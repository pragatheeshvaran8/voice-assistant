import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NotesIndex, chunkMarkdown, tokenize } from '../brain/notes.js';
import { ROOT } from '../brain/config.js';

const sampleNotes = new NotesIndex({ notesDir: path.join(ROOT, 'notes'), notesTopK: 3, notesMinScore: 0.2 });

test('tokenize drops stopwords and plural s', () => {
  assert.deepEqual(tokenize('What are the KV caches?'), ['kv', 'cache']);
});

test('chunks follow headings and keep the heading path', () => {
  const chunks = chunkMarkdown('# Top\nintro text\n\n## Child\nchild text\n\nmore child', { file: 'a.md', chunkChars: 600 });
  assert.deepEqual(
    chunks.map((c) => [c.heading, c.text]),
    [
      ['Top', 'intro text'],
      ['Top > Child', 'child text\nmore child'],
    ],
  );
});

test('long paragraphs are split at sentence ends', () => {
  const text = 'One sentence here. '.repeat(20);
  const chunks = chunkMarkdown(text, { file: 'a.md', chunkChars: 100 });
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.text.length <= 100));
});

test('finds the right note for a matching question', () => {
  const hits = sampleNotes.search('what is a kv cache');
  assert.ok(hits.length > 0, 'expected a hit');
  assert.match(hits[0].heading, /KV cache/);
});

test('finds a personal fact only the notes know', () => {
  const hits = sampleNotes.search('how many words did my speech pre-check get right');
  assert.ok(hits.length > 0, 'expected a hit');
  assert.match(hits[0].text, /32 of 34/);
});

test('returns nothing for an unrelated question', () => {
  assert.deepEqual(sampleNotes.search('what is the capital of France'), []);
  assert.deepEqual(sampleNotes.search('play some jazz music'), []);
});

test('rebuilds when a note file changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-'));
  try {
    const index = new NotesIndex({ notesDir: dir, notesMinScore: 0.1 });
    assert.equal(index.stats().chunks, 0);
    fs.writeFileSync(path.join(dir, 'pets.md'), '# Pets\nMy cat is named Biscuit.');
    fs.writeFileSync(path.join(dir, 'food.md'), '# Food\nI like dosa for breakfast.');
    assert.equal(index.stats().files, 2);
    assert.match(index.search('what is my cat called')[0].text, /Biscuit/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
