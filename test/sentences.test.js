import test from 'node:test';
import assert from 'node:assert/strict';
import { SentenceSplitter, cleanForSpeech } from '../brain/sentences.js';

/** Feeds text in small pieces, like a real token stream. */
function stream(text, size = 3) {
  const splitter = new SentenceSplitter();
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(...splitter.push(text.slice(i, i + size)));
  out.push(...splitter.flush());
  return out;
}

test('splits a stream into sentences', () => {
  assert.deepEqual(stream('Paris is the capital. It is in France! Want more?'), [
    'Paris is the capital.',
    'It is in France!',
    'Want more?',
  ]);
});

test('emits the first sentence before the stream ends', () => {
  const splitter = new SentenceSplitter();
  assert.deepEqual(splitter.push('The first one is done.'), []);
  assert.deepEqual(splitter.push(' The second'), ['The first one is done.']);
  assert.deepEqual(splitter.flush(), ['The second']);
});

test('does not split decimals, abbreviations or initials', () => {
  assert.deepEqual(stream('Pi is about 3.14 today. Ask Dr. Rao, e.g. by mail. J. R. R. Tolkien wrote it.'), [
    'Pi is about 3.14 today.',
    'Ask Dr. Rao, for example by mail.',
    'J. R. R. Tolkien wrote it.',
  ]);
});

test('drops list markers and markdown', () => {
  assert.deepEqual(stream('Two steps:\n1. **Open** the app.\n2. Click `Save`.\n'), [
    'Two steps:',
    'Open the app.',
    'Click Save.',
  ]);
});

test('keeps a final answer that is only a number', () => {
  assert.deepEqual(stream('42'), ['42']);
});

test('splits a very long sentence at a comma so speech starts sooner', () => {
  const long = `${'word '.repeat(50)}and then, ${'more '.repeat(20)}end.`;
  const parts = stream(long, 5);
  assert.ok(parts.length >= 2, `expected a soft split, got ${parts.length} part(s)`);
  assert.ok(parts[0].endsWith(','));
});

test('cleanForSpeech removes links and headings', () => {
  assert.equal(cleanForSpeech('## Title'), 'Title');
  assert.equal(cleanForSpeech('See [the docs](https://x.y) or https://a.b/c now'), 'See the docs or a link now');
  assert.equal(cleanForSpeech('This is *really* good'), 'This is really good');
});
