// The brain's HTTP API. Only listens on 127.0.0.1.
//
//   GET  /health   status, model, notes count
//   POST /ask      { question, sessionId?, useNotes?, temperature? }
//                  Streams NDJSON (one JSON object per line):
//                    {"type":"start", ...}
//                    {"type":"sentence","text":"...","t_ms":640}   one per sentence
//                    {"type":"info","message":"..."}               e.g. model switch
//                    {"type":"done","text":"...","stats":{...},"sources":[...]}
//                    {"type":"error","message":"<spoken>","detail":"..."}
//   POST /reset    { sessionId? }  forget the conversation

import http from 'node:http';
import { answer, remember } from './assistant.js';
import { NotesIndex } from './notes.js';
import { coolingModels, spokenError } from './llm.js';

const MAX_BODY = 16 * 1024;
const MAX_SESSIONS = 50;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', (part) => {
      size += part.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Request body is too large.'), { status: 413 }));
        req.destroy();
      } else {
        parts.push(part);
      }
    });
    req.on('end', () => {
      const raw = Buffer.concat(parts).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('Body must be JSON.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

// A web page in your browser could post to 127.0.0.1 and spend your quota.
// Browsers cannot send "Content-Type: application/json" across sites without
// asking first (CORS preflight), and this server never says yes. A Host check
// also blocks DNS rebinding (a site that points its own name at 127.0.0.1).
function isLocalHost(req) {
  const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
  return host === '127.0.0.1' || host === 'localhost';
}

function isJson(req) {
  return /^application\/json\b/i.test(String(req.headers['content-type'] || ''));
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

export function createBrainServer(config, { log = console.log } = {}) {
  const notes = new NotesIndex(config);
  const sessions = new Map();

  function session(id) {
    if (!sessions.has(id)) {
      if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
      sessions.set(id, { history: [] });
    }
    return sessions.get(id);
  }

  async function ask(req, res) {
    const body = await readJson(req);
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    if (!question) return sendJson(res, 400, { error: 'question is required' });
    if (question.length > 2000) return sendJson(res, 400, { error: 'question is too long (2000 characters max)' });

    const sessionId = String(body.sessionId || 'default').slice(0, 64);
    const useNotes = typeof body.useNotes === 'boolean' ? body.useNotes : config.notesEnabled;
    const temperature = Number.isFinite(body.temperature) ? body.temperature : config.temperature;
    const state = session(sessionId);

    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    // Send each line the moment it is written. Do not wait to fill a packet.
    res.socket?.setNoDelay(true);
    const send = (event) => {
      if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(event)}\n`);
    };

    // If the voice client hangs up, stop paying for tokens nobody will hear.
    const cancel = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) cancel.abort();
    });

    send({ type: 'start', model: config.provider === 'fake' ? 'fake' : config.model, session: sessionId, notes: useNotes });

    try {
      const result = await answer({
        config,
        question,
        history: state.history,
        notes,
        useNotes,
        temperature,
        signal: cancel.signal,
        onSentence: (text, tMs) => send({ type: 'sentence', text, t_ms: tMs }),
        onEvent: (event) => send({ type: 'info', message: `${event.from} unavailable, using ${event.to}`, reason: event.reason }),
      });

      if (!result.text) {
        send({ type: 'error', message: 'The model returned an empty answer. Please try again.', detail: `finish_reason=${result.stats.finish_reason}` });
        return;
      }
      remember(state.history, question, result.text, config.historyTurns);
      send({ type: 'done', text: result.text, stats: result.stats, sources: result.sources });

      const s = result.stats;
      log(
        `[ask] ${JSON.stringify(question.slice(0, 60))} -> first sentence ${s.first_sentence_ms} ms, ` +
          `total ${s.total_ms} ms, ${s.completion_tokens} tokens, ${s.tokens_per_sec ?? '-'} tok/s, ` +
          `notes ${s.notes_hits}, model ${s.model}`,
      );
    } catch (err) {
      if (cancel.signal.aborted) {
        log('[ask] client hung up, request cancelled');
      } else {
        send({ type: 'error', message: spokenError(err), detail: err.message, status: err.status || 0 });
        log(`[ask] error: ${err.message}`);
      }
    } finally {
      res.end();
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!isLocalHost(req)) return sendJson(res, 403, { error: 'Only local requests are allowed.' });
      if (req.method === 'POST' && !isJson(req)) {
        return sendJson(res, 415, { error: 'Send Content-Type: application/json.' });
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, {
          ok: true,
          service: 'voice-assistant-brain',
          provider: config.provider,
          model: config.provider === 'fake' ? 'fake' : config.model,
          fallbackModels: config.fallbackModels,
          cooling: coolingModels(),
          notes: { enabled: config.notesEnabled, ...notes.stats() },
        });
      }
      if (req.method === 'POST' && url.pathname === '/ask') return await ask(req, res);
      if (req.method === 'POST' && url.pathname === '/reset') {
        const body = await readJson(req);
        sessions.delete(String(body.sessionId || 'default'));
        return sendJson(res, 200, { ok: true });
      }
      sendJson(res, 404, { error: 'Not found. Try GET /health or POST /ask.' });
    } catch (err) {
      if (!res.headersSent) sendJson(res, err.status || 500, { error: err.message });
      else res.end();
    }
  });

  server.notes = notes;
  server.sessions = sessions;
  return server;
}
