// RAG over the notes folder: chunk the notes, turn each chunk into a vector,
// and find the chunks closest to the question.
//
// The vectors here are TF-IDF word vectors, not learned embeddings:
//   - TF  (term frequency): how often a word appears in this chunk.
//   - IDF (inverse document frequency): rare words across all chunks count more.
//   - Similarity is the cosine of the angle between two vectors (0 to 1).
// This matches on words, not meaning. "car" will not match "automobile".
// A learned embedding model would. The search code would stay the same.
//
// The index rebuilds by itself when a file in the notes folder changes.

import fs from 'node:fs';
import path from 'node:path';

const STOPWORDS = new Set(
  (
    'a about after again all also am an and any are as at be been before being both but by can could did do does ' +
    'doing down each few for from further had has have having he her here hers him his how i if in into is it its ' +
    'just me more most my no nor not now of off on once only or other our ours out over own same she should so ' +
    'some such than that the their theirs them then there these they this those through to too under until up ' +
    'very was we were what when where which while who whom why will with would you your yours tell please'
  ).split(' '),
);

function stem(word) {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('s') && !/(ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

/** Lowercase words, no stopwords, plural "s" removed. */
export function tokenize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map(stem);
}

function splitLong(text, max) {
  if (text.length <= max) return [text];
  const pieces = [];
  let current = '';
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    if (current && current.length + 1 + sentence.length > max) {
      pieces.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

/**
 * Splits markdown into chunks that follow its structure.
 * A heading always starts a new chunk. Paragraphs under the same heading are
 * packed together up to `chunkChars`. Each chunk remembers its heading path,
 * for example "GenAI cheat sheet > KV cache".
 */
export function chunkMarkdown(text, { file = '', chunkChars = 600 } = {}) {
  const headings = [];
  const blocks = [];
  let paragraph = [];

  const headingPath = () => headings.map((h) => h.title).join(' > ');
  const endParagraph = () => {
    const body = paragraph.join(' ').replace(/\s+/g, ' ').trim();
    if (body) blocks.push({ heading: headingPath(), text: body });
    paragraph = [];
  };

  for (const line of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      endParagraph();
      const level = heading[1].length;
      while (headings.length && headings.at(-1).level >= level) headings.pop();
      headings.push({ level, title: heading[2].trim() });
    } else if (!line.trim()) {
      endParagraph();
    } else {
      paragraph.push(line.trim());
    }
  }
  endParagraph();

  const chunks = [];
  let current = null;
  for (const block of blocks) {
    for (const piece of splitLong(block.text, chunkChars)) {
      if (current && current.heading === block.heading && current.text.length + 1 + piece.length <= chunkChars) {
        current.text += `\n${piece}`;
      } else {
        if (current) chunks.push(current);
        current = { file, heading: block.heading || path.basename(file), text: piece };
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function termCounts(tokens) {
  const counts = new Map();
  for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1);
  return counts;
}

function normalize(vector) {
  let sum = 0;
  for (const w of vector.values()) sum += w * w;
  const length = Math.sqrt(sum) || 1;
  for (const [term, w] of vector) vector.set(term, w / length);
  return vector;
}

export class NotesIndex {
  constructor({ notesDir, chunkChars = 600, notesTopK = 3, notesMinScore = 0.2 }) {
    this.dir = notesDir;
    this.chunkChars = chunkChars;
    this.topK = notesTopK;
    this.minScore = notesMinScore;
    this.signature = null;
    this.files = 0;
    this.chunks = [];
    this.idf = new Map();
  }

  #listFiles() {
    if (!this.dir || !fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir, { recursive: true })
      .map(String)
      .filter((rel) => /\.(md|txt)$/i.test(rel))
      .map((rel) => {
        const full = path.join(this.dir, rel);
        const stat = fs.statSync(full);
        return { rel: rel.split(path.sep).join('/'), full, stat };
      })
      .filter((f) => f.stat.isFile());
  }

  /** Rebuilds the index if any note was added, removed or edited. */
  refresh() {
    const files = this.#listFiles();
    const signature = files
      .map((f) => `${f.rel}:${f.stat.mtimeMs}:${f.stat.size}`)
      .sort()
      .join('|');
    if (signature === this.signature) return false;
    this.signature = signature;
    this.#build(files);
    return true;
  }

  #build(files) {
    const chunks = files.flatMap((f) =>
      chunkMarkdown(fs.readFileSync(f.full, 'utf8'), { file: f.rel, chunkChars: this.chunkChars }),
    );

    const docCounts = chunks.map((c) => termCounts(tokenize(`${c.heading} ${c.text}`)));
    const df = new Map();
    for (const counts of docCounts) for (const term of counts.keys()) df.set(term, (df.get(term) || 0) + 1);

    const n = chunks.length;
    this.idf = new Map([...df].map(([term, count]) => [term, Math.log(1 + n / count)]));
    this.unseenIdf = Math.log(1 + n); // a word in the question that no note contains
    this.chunks = chunks.map((c, i) => ({ ...c, vector: this.#weigh(docCounts[i]) }));
    this.files = files.length;
  }

  #weigh(counts) {
    const vector = new Map();
    for (const [term, tf] of counts) {
      vector.set(term, (1 + Math.log(tf)) * (this.idf.get(term) ?? this.unseenIdf));
    }
    return normalize(vector);
  }

  /** Top matching chunks for a question, best first. Empty when nothing is close enough. */
  search(question, { topK = this.topK, minScore = this.minScore } = {}) {
    this.refresh();
    if (!this.chunks.length) return [];
    const query = this.#weigh(termCounts(tokenize(question)));
    if (!query.size) return [];

    return this.chunks
      .map((chunk) => {
        let score = 0;
        for (const [term, w] of query) score += w * (chunk.vector.get(term) || 0);
        return { file: chunk.file, heading: chunk.heading, text: chunk.text, score };
      })
      .filter((hit) => hit.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  stats() {
    this.refresh();
    return { files: this.files, chunks: this.chunks.length };
  }
}
