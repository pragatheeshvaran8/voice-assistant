// One question in, one spoken-style answer out, with timings.
// The HTTP server and the terminal chat both call answer().

import { performance } from 'node:perf_hooks';
import { buildMessages, estimateTokens } from './prompt.js';
import { SentenceSplitter } from './sentences.js';
import { streamChat } from './llm.js';

const round = (n, digits = 0) => (n === null || n === undefined ? null : Number(n.toFixed(digits)));

/**
 * @returns {Promise<{ text: string, sentences: string[], stats: object, sources: object[], messages: object[] }>}
 *
 * Timings (all in ms, measured from the moment the question arrives):
 *   retrieval_ms       notes search done
 *   ttft_ms            first token from the model (time to first token)
 *   first_sentence_ms  first whole sentence ready to speak
 *   total_ms           last token received
 */
export async function answer({
  config,
  question,
  history = [],
  notes = null,
  useNotes = config.notesEnabled,
  temperature = config.temperature,
  topP = config.topP,
  maxTokens = config.maxTokens,
  signal,
  now = new Date(),
  onToken,
  onSentence,
  onEvent,
}) {
  const start = performance.now();
  const elapsed = () => performance.now() - start;

  const hits = useNotes && notes ? notes.search(question) : [];
  const retrievalMs = elapsed();

  const messages = buildMessages({
    question,
    history,
    hits,
    now,
    historyTokenBudget: config.historyTokenBudget,
    userContext: config.userContext,
  });

  const splitter = new SentenceSplitter();
  const sentences = [];
  let text = '';
  let ttftMs = null;
  let firstSentenceMs = null;
  let lastTokenMs = null;
  let usage = null;
  let finishReason = null;
  let model = config.provider === 'fake' ? 'fake' : config.model;
  let fallback = null;

  const emit = (list) => {
    for (const sentence of list) {
      if (firstSentenceMs === null) firstSentenceMs = elapsed();
      sentences.push(sentence);
      onSentence?.(sentence, Math.round(elapsed()));
    }
  };

  for await (const event of streamChat(config, { messages, temperature, topP, maxTokens, signal })) {
    if (event.type === 'token') {
      if (ttftMs === null) ttftMs = elapsed();
      lastTokenMs = elapsed();
      text += event.text;
      onToken?.(event.text);
      emit(splitter.push(event.text));
    } else if (event.type === 'usage') {
      usage = event.usage;
      if (event.model) model = event.model;
    } else if (event.type === 'finish') {
      finishReason = event.reason;
    } else if (event.type === 'fallback') {
      fallback = event;
      model = event.to;
      onEvent?.(event);
    }
  }
  emit(splitter.flush());
  const totalMs = elapsed();

  const completionTokens = usage?.completion_tokens ?? estimateTokens(text);
  // Generation speed after the first token. Network chunks arrive in bursts,
  // so this is "delivery speed", close to but not exactly model decode speed.
  const decodeMs = ttftMs !== null && lastTokenMs > ttftMs ? lastTokenMs - ttftMs : null;

  const stats = {
    model,
    fallback_from: fallback ? fallback.from : null,
    retrieval_ms: round(retrievalMs, 1),
    ttft_ms: round(ttftMs),
    first_sentence_ms: round(firstSentenceMs),
    total_ms: round(totalMs),
    prompt_tokens: usage?.prompt_tokens ?? estimateTokens(messages.map((m) => m.content).join('\n')),
    completion_tokens: completionTokens,
    reasoning_tokens: usage?.completion_tokens_details?.reasoning_tokens ?? null,
    tokens_estimated: !usage,
    // Too few tokens or too little time gives a meaningless number, so skip it.
    tokens_per_sec: decodeMs >= 50 && completionTokens >= 5 ? round((completionTokens - 1) / (decodeMs / 1000), 1) : null,
    finish_reason: finishReason,
    cost_usd: usage?.cost ?? null,
    history_messages: messages.length - 2,
    notes_hits: hits.length,
    temperature,
    top_p: topP,
  };

  return {
    text: text.trim(),
    sentences,
    stats,
    sources: hits.map((h) => ({ file: h.file, heading: h.heading, score: round(h.score, 2) })),
    messages,
  };
}

/** Adds a finished turn to the history and keeps only the newest pairs. */
export function remember(history, question, answerText, maxTurns) {
  history.push({ role: 'user', content: question }, { role: 'assistant', content: answerText });
  const extra = history.length - maxTurns * 2;
  if (extra > 0) history.splice(0, extra);
  return history;
}
