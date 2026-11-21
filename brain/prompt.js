// Builds the exact list of messages sent to the model on every turn:
//   1. system prompt (rules for spoken answers + current date and time)
//   2. recent history (trimmed to fit a token budget)
//   3. the new question (with note passages, when notes matched)

export const SYSTEM_PROMPT = `You are a voice assistant running on the user's Windows laptop.
A text-to-speech voice reads your reply aloud. The user's words reached you through speech recognition.

How to answer:
- Reply in one to three short sentences, under 60 words, unless the user asks for more detail.
- Put the most useful fact first.
- Use plain spoken English. No markdown, lists, headings, code, emojis, tables or links.
- Write numbers and symbols the way a person says them. Say "20 percent", not "20%".
- Speech recognition often mishears words, most of all technical terms. If a word does not fit, answer about the similar-sounding term the user most likely meant, and name the correct term. If you cannot guess, ask one short question back.
- If you do not know, say so. Never make up facts.`;

export const NOTES_RULES = `Below are passages from my own notes. If they answer the question, base your answer on them and begin with "From your notes". If they do not answer it, ignore them and answer normally.`;

/** Rough token count. For English, 1 token is about 4 characters. */
export function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

/**
 * Keeps the newest question and answer pairs that fit in `budget` tokens.
 * Old turns fall off first. This is how a small "context window" is managed.
 */
export function trimHistory(history, budget) {
  const kept = [];
  let used = 0;
  // Walk back from the newest pair. Each pair is [user, assistant].
  for (let i = history.length - 2; i >= 0; i -= 2) {
    const pair = history.slice(i, i + 2);
    if (pair[0]?.role !== 'user') continue;
    const cost = pair.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0);
    if (used + cost > budget) break;
    used += cost;
    kept.unshift(...pair);
  }
  return kept;
}

export function formatNow(now = new Date()) {
  return now.toLocaleString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatPassages(hits) {
  return hits.map((h, i) => `[${i + 1}] (${h.file} > ${h.heading}) ${h.text}`).join('\n');
}

export function buildMessages({ question, history = [], hits = [], now = new Date(), historyTokenBudget = 1500, userContext = '' }) {
  // userContext names the topics the user talks about. It lets the model fix
  // misheard words, for example "KB cache" when the user said "KV cache".
  const about = userContext ? `\n\nAbout the user: ${userContext}` : '';
  const system = `${SYSTEM_PROMPT}${about}\n\nCurrent local date and time: ${formatNow(now)}.`;
  const user = hits.length
    ? `${NOTES_RULES}\n\nPassages from my notes:\n${formatPassages(hits)}\n\nQuestion: ${question}`
    : question;
  return [
    { role: 'system', content: system },
    ...trimHistory(history, historyTokenBudget),
    { role: 'user', content: user },
  ];
}
