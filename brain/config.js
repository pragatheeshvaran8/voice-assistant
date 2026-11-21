// All settings in one place. Values come from the environment or from .env.
// Every module takes a config object, so tests can pass their own.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ENV_FILE = path.join(ROOT, '.env');
// Built into Node 20.12+. Variables already set in the shell win over .env.
if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

function num(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

/** Picks the key that belongs to the server in LLM_BASE_URL. */
function pickApiKey(env, baseUrl) {
  if (env.LLM_API_KEY) return env.LLM_API_KEY;
  if (baseUrl.includes('openrouter.ai')) return env.OPENROUTER_API_KEY || '';
  if (baseUrl.includes('googleapis.com')) return env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '';
  return ''; // a local server needs no key
}

export function getConfig(env = process.env) {
  const baseUrl = (env.LLM_BASE_URL || env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
  return {
    // Brain
    provider: (env.LLM_PROVIDER || 'openrouter').toLowerCase(),
    baseUrl,
    apiKey: pickApiKey(env, baseUrl),
    model: env.LLM_MODEL || 'google/gemini-2.5-flash',
    // Tried in order when the main model fails before it says anything.
    fallbackModels: String(env.LLM_FALLBACK_MODELS ?? env.LLM_FALLBACK_MODEL ?? '')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean),
    // off = no hidden "thinking" before the answer. Thinking adds seconds of delay.
    reasoning: (env.LLM_REASONING || 'off').toLowerCase(),
    temperature: num(env.LLM_TEMPERATURE, 0.4),
    topP: num(env.LLM_TOP_P, 0.95),
    maxTokens: num(env.LLM_MAX_TOKENS, 220),
    timeoutMs: num(env.LLM_TIMEOUT_MS, 30000),
    fakeDelayMs: num(env.FAKE_DELAY_MS, 15),

    // Topics you talk about. Helps the model fix words speech recognition got wrong.
    userContext: env.USER_CONTEXT || '',

    // Memory
    historyTurns: num(env.HISTORY_TURNS, 6),
    historyTokenBudget: num(env.HISTORY_TOKEN_BUDGET, 1500),

    // Notes (RAG)
    notesEnabled: bool(env.NOTES_ENABLED, true),
    notesDir: path.resolve(ROOT, env.NOTES_DIR || 'notes'),
    notesTopK: num(env.NOTES_TOP_K, 3),
    notesMinScore: num(env.NOTES_MIN_SCORE, 0.2),
    chunkChars: num(env.NOTES_CHUNK_CHARS, 600),

    // Server and logs
    host: '127.0.0.1',
    port: num(env.BRAIN_PORT, 47800),
    logsDir: path.resolve(ROOT, env.LOGS_DIR || 'logs'),
  };
}
