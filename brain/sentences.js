// Turns a stream of tokens into whole sentences.
//
// Why: the voice can start speaking sentence 1 while the model is still
// writing sentence 2. Without this, you wait for the full answer.
//
// A sentence ends at . ! or ? followed by a space, or at a line break.
// It does not end after "e.g.", "Dr." or a single initial like "J.".

const BOUNDARY = /[.!?]+["'”’)\]]*(?=\s)|\n+/g;
const ABBREVIATION = /\b(?:e\.g|i\.e|mr|mrs|ms|dr|prof|sr|jr|st|vs|approx)\.$/i;
const INITIAL = /(?:^|[\s(])[A-Z]\.$/;
const HAS_WORD = /\p{L}{2,}/u;
const HAS_CONTENT = /[\p{L}\p{N}]/u;
const SOFT_BREAK = /[,;:]\s|\s[-–—]\s/g;

/** Removes things a voice should not read out: markdown, list markers, URLs. */
export function cleanForSpeech(text) {
  return String(text)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [text](url) -> text
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/^\s*#{1,6}\s+/gm, '') // headings
    .replace(/^\s*(?:[-*•]|\d{1,2}[.)])\s+/gm, '') // list markers
    .replace(/\*\*|__|~~|`+/g, '') // bold, strike, code
    .replace(/(^|\s)\*(\S)/g, '$1$2') // *italic
    .replace(/(\S)\*(?=\s|$|[.,!?])/g, '$1') // italic*
    .replace(/\be\.g\.,?/gi, 'for example')
    .replace(/\bi\.e\.,?/gi, 'that is')
    .replace(/\s*[—–]\s*/g, ', ') // dashes -> a short pause
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The buffer is long and has no sentence end yet. Cut at the last comma or
 * dash, so the voice can start instead of waiting for the full stop.
 */
function softCut(buffer, limit) {
  let cut = -1;
  SOFT_BREAK.lastIndex = 0;
  let match;
  while ((match = SOFT_BREAK.exec(buffer))) {
    if (match.index >= 40) cut = match.index + match[0].length;
  }
  if (cut < 0 && buffer.length > limit * 2) cut = buffer.lastIndexOf(' ', limit);
  return cut;
}

export class SentenceSplitter {
  #buffer = '';

  constructor({ softLimit = 220 } = {}) {
    this.softLimit = softLimit;
  }

  /** Add streamed text. Returns the sentences that are now complete. */
  push(text) {
    this.#buffer += text;
    return this.#drain();
  }

  /** The stream ended. Returns whatever is left as the last sentence. */
  flush() {
    const out = this.#drain();
    const rest = cleanForSpeech(this.#buffer);
    this.#buffer = '';
    if (HAS_CONTENT.test(rest)) out.push(rest);
    return out;
  }

  #drain() {
    const out = [];
    let from = 0;
    for (;;) {
      BOUNDARY.lastIndex = from;
      const match = BOUNDARY.exec(this.#buffer);
      if (!match) break;

      const end = match.index + match[0].length;
      const candidate = this.#buffer.slice(0, end);
      const isNewline = match[0][0] === '\n';

      // "e.g." or "J." is not the end of a sentence. Keep looking.
      if (!isNewline && (ABBREVIATION.test(candidate) || INITIAL.test(candidate))) {
        from = end;
        continue;
      }

      const sentence = cleanForSpeech(candidate);
      if (isNewline ? !HAS_CONTENT.test(sentence) : !HAS_WORD.test(sentence)) {
        if (isNewline) {
          // An empty line or a bare list marker. Drop it.
          this.#buffer = this.#buffer.slice(end);
          from = 0;
        } else {
          // "1." at the start of a list item. Wait for the real sentence.
          from = end;
        }
        continue;
      }

      out.push(sentence);
      this.#buffer = this.#buffer.slice(end).replace(/^\s+/, '');
      from = 0;
    }

    if (this.#buffer.length > this.softLimit) {
      const cut = softCut(this.#buffer, this.softLimit);
      if (cut > 0) {
        const piece = cleanForSpeech(this.#buffer.slice(0, cut));
        this.#buffer = this.#buffer.slice(cut).replace(/^\s+/, '');
        if (HAS_WORD.test(piece)) out.push(piece);
      }
    }
    return out;
  }
}
