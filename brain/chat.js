// Terminal chat with the brain: npm run chat
//
// You see the raw tokens arrive live, then the timing for each answer.
// Use it to learn how the model behaves before adding voice.
//
// Commands:
//   /temp 0.9      change temperature (0 = focused, 1+ = creative)
//   /topp 0.5      change top-p
//   /notes on|off  search the notes folder or not
//   /show          print the exact messages sent last time (the context window)
//   /reset         forget the conversation
//   /help, /exit

import readline from 'node:readline';
import { getConfig } from './config.js';
import { answer, remember } from './assistant.js';
import { NotesIndex } from './notes.js';
import { appendTurn } from './turnlog.js';
import { estimateTokens } from './prompt.js';

const config = getConfig();
const notes = new NotesIndex(config);
const state = {
  temperature: config.temperature,
  topP: config.topP,
  useNotes: config.notesEnabled,
  history: [],
  lastMessages: null,
};

const tty = process.stdout.isTTY;
const dim = (s) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const say = (s = '') => process.stdout.write(`${s}\n`);

function help() {
  say(dim('Commands: /temp <0-2>  /topp <0-1>  /notes on|off  /show  /reset  /help  /exit'));
}

function statsLine(s) {
  const parts = [
    `first token ${s.ttft_ms} ms`,
    `first sentence ${s.first_sentence_ms} ms`,
    `total ${s.total_ms} ms`,
    `${s.completion_tokens}${s.tokens_estimated ? '~' : ''} tokens`,
    `${s.tokens_per_sec ?? '-'} tok/s`,
    `prompt ${s.prompt_tokens} tokens`,
  ];
  if (s.reasoning_tokens) parts.push(`reasoning ${s.reasoning_tokens} tokens`);
  if (s.cost_usd !== null) parts.push(s.cost_usd > 0 ? `cost $${s.cost_usd.toFixed(6)}` : 'free');
  if (s.finish_reason === 'length') parts.push('CUT OFF by max tokens');
  parts.push(s.model);
  return `  [${parts.join(' | ')}]`;
}

function command(line) {
  const [name, arg] = line.slice(1).split(/\s+/, 2);
  switch (name) {
    case 'exit':
    case 'quit':
      return 'exit';
    case 'reset':
      state.history = [];
      say(dim('History cleared.'));
      break;
    case 'temp': {
      const value = Number(arg);
      if (Number.isFinite(value) && value >= 0 && value <= 2) state.temperature = value;
      say(dim(`temperature = ${state.temperature}`));
      break;
    }
    case 'topp': {
      const value = Number(arg);
      if (Number.isFinite(value) && value > 0 && value <= 1) state.topP = value;
      say(dim(`top_p = ${state.topP}`));
      break;
    }
    case 'notes':
      if (arg === 'on' || arg === 'off') state.useNotes = arg === 'on';
      say(dim(`notes = ${state.useNotes ? 'on' : 'off'}`));
      break;
    case 'show':
      if (!state.lastMessages) {
        say(dim('Nothing sent yet.'));
        break;
      }
      for (const m of state.lastMessages) {
        say(dim(`--- ${m.role} (~${estimateTokens(m.content)} tokens) ---`));
        say(m.content);
      }
      say(dim(`--- total ~${estimateTokens(state.lastMessages.map((m) => m.content).join(''))} tokens ---`));
      break;
    default:
      help();
  }
  return null;
}

const noteStats = notes.stats();
say(`Brain chat | model ${config.provider === 'fake' ? 'fake' : config.model} | temperature ${state.temperature} | notes ${state.useNotes ? `on (${noteStats.files} files, ${noteStats.chunks} chunks)` : 'off'}`);
help();

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
rl.setPrompt('you> ');
// When input is piped (not a keyboard), echo each line instead of showing a prompt.
const prompt = () => (tty ? rl.prompt() : undefined);
prompt();

for await (const raw of rl) {
  const line = raw.trim();
  if (!line) {
    prompt();
    continue;
  }
  if (!tty) say(`you> ${line}`);
  if (line.startsWith('/')) {
    if (command(line) === 'exit') break;
    prompt();
    continue;
  }

  process.stdout.write('bot> ');
  try {
    const result = await answer({
      config,
      question: line,
      history: state.history,
      notes,
      useNotes: state.useNotes,
      temperature: state.temperature,
      topP: state.topP,
      onToken: (token) => process.stdout.write(token),
      onEvent: (event) => process.stdout.write(dim(`(${event.from} unavailable, using ${event.to}) `)),
    });
    say();
    say(dim(statsLine(result.stats)));
    if (result.sources.length) {
      say(dim(`  notes used: ${result.sources.map((s) => `${s.file} > ${s.heading} (${s.score})`).join('; ')}`));
    }
    state.lastMessages = result.messages;
    if (result.text) remember(state.history, line, result.text, config.historyTurns);
    appendTurn(config, { mode: 'chat', question: line, ...result.stats });
  } catch (err) {
    say();
    say(`[error] ${err.message}`);
  }
  prompt();
}

rl.close();
