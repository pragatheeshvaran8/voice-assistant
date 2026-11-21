// Talks to the LLM and streams its answer back token by token.
//
// Providers:
//   openrouter  Gemini (or any model) through OpenRouter. OpenAI-compatible API,
//               so LLM_BASE_URL can also point at a local llama.cpp server.
//   fake        Canned answer, no network. Used by tests and offline demos.
//
// streamChat() yields events:
//   { type: 'token', text }                 a piece of the answer
//   { type: 'usage', usage, model }         real token counts (last chunk)
//   { type: 'finish', reason }              'stop' or 'length' (hit max tokens)
//   { type: 'fallback', from, to, reason }  main model failed, trying the backup

import { estimateTokens } from './prompt.js';

export class LlmError extends Error {
  constructor(message, { status = 0, code = '' } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.code = code;
  }
}

/** A short sentence the voice can say when something goes wrong. */
export function spokenError(err) {
  if (err?.code === 'timeout') return 'The model took too long to answer. Please try again.';
  switch (err?.status) {
    case 401:
      return 'The API key was rejected. Please check the key in the dot env file.';
    case 402:
      return 'The model account has run out of credits.';
    case 429:
      return 'The model is busy right now. Please try again in a minute.';
    default:
      return err?.status
        ? 'The model returned an error. Please try again.'
        : 'I could not reach the language model. Please check the internet connection.';
  }
}

const RETRYABLE = new Set([402, 404, 408, 429, 500, 502, 503, 504]);

// After a model fails, skip it for a while so every question does not pay
// for one failed request first. 402 = out of credits, 429 = rate limited.
const COOLDOWN_MS = { 402: 10 * 60_000, 429: 60_000, 503: 30_000 };
const cooldownUntil = new Map();

export function resetCooldowns() {
  cooldownUntil.clear();
}

/** Models that are cooling down right now, with seconds left. */
export function coolingModels() {
  const now = Date.now();
  return [...cooldownUntil].filter(([, until]) => until > now).map(([model, until]) => ({ model, seconds: Math.ceil((until - now) / 1000) }));
}

function modelsToTry(config) {
  const all = [...new Set([config.model, ...(config.fallbackModels || [])])];
  const now = Date.now();
  const ready = all.filter((m) => (cooldownUntil.get(m) || 0) <= now);
  return ready.length ? ready : all;
}

export async function* streamChat(config, request) {
  if (config.provider === 'fake') {
    yield* fakeStream(config, request);
    return;
  }

  const models = modelsToTry(config);
  if (models[0] !== config.model) {
    yield { type: 'fallback', from: config.model, to: models[0], reason: 'main model is cooling down after an error' };
  }
  for (let i = 0; i < models.length; i++) {
    let started = false;
    try {
      for await (const event of openAiStream(config, { ...request, model: models[i] })) {
        started = true;
        yield event;
      }
      cooldownUntil.delete(models[i]);
      return;
    } catch (err) {
      if (COOLDOWN_MS[err.status]) cooldownUntil.set(models[i], Date.now() + COOLDOWN_MS[err.status]);
      const canFallBack = !started && i < models.length - 1 && RETRYABLE.has(err.status);
      if (!canFallBack) throw err;
      yield { type: 'fallback', from: models[i], to: models[i + 1], reason: err.message };
    }
  }
}

function toLlmError(err) {
  if (err instanceof LlmError) return err;
  if (err?.name === 'TimeoutError') return new LlmError('The model timed out.', { code: 'timeout' });
  if (err?.name === 'AbortError') return new LlmError('The request was cancelled.', { code: 'aborted' });
  const cause = err?.cause?.code || err?.cause?.message || '';
  return new LlmError(`Network error: ${err?.message || err}${cause ? ` (${cause})` : ''}`, { code: 'network' });
}

function readErrorMessage(body) {
  try {
    const parsed = JSON.parse(body);
    return parsed?.error?.message || body;
  } catch {
    return body;
  }
}

async function* openAiStream(config, { model, messages, temperature, topP, maxTokens, signal }) {
  const isOpenRouter = config.baseUrl.includes('openrouter.ai');
  const isGoogle = config.baseUrl.includes('googleapis.com');
  if (!config.apiKey && (isOpenRouter || isGoogle)) {
    const name = isOpenRouter ? 'OPENROUTER_API_KEY' : 'GEMINI_API_KEY';
    throw new LlmError(`${name} is missing. Add it to .env.`, { status: 401 });
  }

  const timeout = AbortSignal.timeout(config.timeoutMs);
  const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;

  const body = {
    model,
    messages,
    stream: true,
    temperature,
    top_p: topP,
    max_tokens: maxTokens,
  };
  // Ask for real token counts in the last chunk.
  if (isOpenRouter) body.usage = { include: true };
  else body.stream_options = { include_usage: true };

  // Thinking models write hidden reasoning before the answer. That adds
  // seconds before the first spoken word, so it is off by default.
  if (isOpenRouter) {
    body.reasoning = config.reasoning === 'off' ? { enabled: false } : { effort: config.reasoning === 'on' ? 'medium' : config.reasoning };
  } else if (isGoogle) {
    body.reasoning_effort = config.reasoning === 'off' ? 'none' : config.reasoning === 'on' ? 'medium' : config.reasoning;
  }

  const headers = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  if (isOpenRouter) {
    headers['HTTP-Referer'] = 'http://localhost';
    headers['X-Title'] = 'Voice Assistant';
  }

  let res;
  try {
    res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: abort,
    });
  } catch (err) {
    throw toLlmError(err);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new LlmError(`HTTP ${res.status}: ${readErrorMessage(text).slice(0, 300)}`, { status: res.status });
  }

  // Server-sent events: lines like "data: {json}", ending with "data: [DONE]".
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('data:')) continue; // keep-alive comments start with ":"
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;

        let chunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (chunk.error) {
          throw new LlmError(chunk.error.message || 'The model stream failed.', {
            status: Number(chunk.error.code) || 500,
          });
        }
        const choice = chunk.choices?.[0];
        if (choice?.delta?.content) yield { type: 'token', text: choice.delta.content };
        if (choice?.finish_reason) yield { type: 'finish', reason: choice.finish_reason };
        if (chunk.usage) yield { type: 'usage', usage: chunk.usage, model: chunk.model || model };
      }
    }
  } catch (err) {
    throw toLlmError(err);
  } finally {
    reader.cancel().catch(() => {});
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function* fakeStream(config, { messages, signal }) {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
  let question = lastUser.split('Question:').pop().trim().replace(/[.?!]+$/, '');
  if (!question) question = 'nothing';
  const answer = `This is the fake brain, so no model was called. You asked: ${question}. Set LLM_PROVIDER to openrouter to use Gemini.`;

  for (const piece of answer.split(/(?<=\s)/)) {
    if (signal?.aborted) throw new LlmError('The request was cancelled.', { code: 'aborted' });
    await sleep(config.fakeDelayMs);
    yield { type: 'token', text: piece };
  }
  yield { type: 'finish', reason: 'stop' };
  yield {
    type: 'usage',
    model: 'fake',
    usage: {
      prompt_tokens: estimateTokens(messages.map((m) => m.content).join('\n')),
      completion_tokens: estimateTokens(answer),
    },
  };
}
