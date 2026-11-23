// Latency table from logs/turns.jsonl:  npm run report
//
// Options:
//   --mode wispr|voice|typed|wav|chat|selftest   only rows from that mode
//   --last 20                              only the newest N rows
//
// Prints a markdown table and writes it to results/latency.md.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, getConfig } from '../brain/config.js';

const config = getConfig();
const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const STAGES = [
  ['speech_ms', 'You speaking (length of your question)'],
  ['stt_ms', 'Ears: you stop talking, text is ready'],
  ['retrieval_ms', 'Notes search'],
  ['ttft_ms', 'Brain: time to first token'],
  ['first_sentence_ms', 'Brain: first whole sentence ready'],
  ['client_first_sentence_ms', 'Client: question sent, first sentence back'],
  ['input_to_voice_ms', 'Question in (Enter pressed), assistant starts talking'],
  ['voice_to_voice_ms', 'You stop talking, assistant starts talking'],
  ['total_ms', 'Brain: full answer'],
  ['tokens_per_sec', 'Tokens per second (not ms)'],
  ['completion_tokens', 'Answer length in tokens (not ms)'],
];

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

const fmt = (n) => (n === null ? '-' : Number.isInteger(n) ? String(n) : n.toFixed(1));

const file = path.join(config.logsDir, 'turns.jsonl');
if (!fs.existsSync(file)) {
  console.log(`No log yet at ${file}. Ask a few questions first.`);
  process.exit(0);
}

let rows = fs
  .readFileSync(file, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  })
  .filter(Boolean)
  .filter((r) => !r.error);

const mode = option('mode');
if (mode) rows = rows.filter((r) => r.mode === mode);
const last = Number(option('last'));
if (last > 0) rows = rows.slice(-last);

if (!rows.length) {
  console.log('No matching rows.');
  process.exit(0);
}

const lines = [];
const modes = Object.entries(rows.reduce((acc, r) => ({ ...acc, [r.mode]: (acc[r.mode] || 0) + 1 }), {}));
const models = [...new Set(rows.map((r) => r.model).filter(Boolean))];
lines.push(`# Latency report`);
lines.push('');
lines.push(`- Rows: ${rows.length} (${modes.map(([m, n]) => `${m} ${n}`).join(', ')})`);
lines.push(`- From ${rows[0].ts} to ${rows.at(-1).ts}`);
if (models.length) lines.push(`- Models: ${models.join(', ')}`);
lines.push('');
lines.push('| Stage | n | median ms | p90 ms | min | max |');
lines.push('|---|---:|---:|---:|---:|---:|');
for (const [key, label] of STAGES) {
  const values = rows.map((r) => r[key]).filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!values.length) continue;
  lines.push(
    `| ${label} | ${values.length} | ${fmt(percentile(values, 0.5))} | ${fmt(percentile(values, 0.9))} | ${fmt(values[0])} | ${fmt(values.at(-1))} |`,
  );
}
lines.push('');
lines.push('Median = the middle value. p90 = 9 in 10 turns were this fast or faster.');

const text = `${lines.join('\n')}\n`;
process.stdout.write(text);
const out = path.join(ROOT, 'results', 'latency.md');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, text, 'utf8');
console.log(`\nSaved to ${path.relative(ROOT, out)}`);
