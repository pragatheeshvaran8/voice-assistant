// End-to-end test of the brain's HTTP API with the fake model.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createBrainServer } from '../brain/app.js';
import { getConfig, ROOT } from '../brain/config.js';

const config = getConfig({ LLM_PROVIDER: 'fake', FAKE_DELAY_MS: '1', NOTES_DIR: path.join(ROOT, 'notes'), HISTORY_TURNS: '2' });

async function startServer() {
  const server = createBrainServer(config, { log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function ask(url, body) {
  const res = await fetch(`${url}/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, type: res.headers.get('content-type'), events: res.ok ? text.trim().split('\n').map((l) => JSON.parse(l)) : JSON.parse(text) };
}

test('GET /health reports the model and the notes', async () => {
  const { server, url } = await startServer();
  try {
    const health = await (await fetch(`${url}/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.model, 'fake');
    assert.ok(health.notes.chunks > 10);
  } finally {
    server.close();
  }
});

test('POST /ask streams sentences, then done with stats', async () => {
  const { server, url } = await startServer();
  try {
    const { status, type, events } = await ask(url, { question: 'What is a KV cache?', sessionId: 't1' });
    assert.equal(status, 200);
    assert.match(type, /ndjson/);
    assert.equal(events[0].type, 'start');
    const sentences = events.filter((e) => e.type === 'sentence');
    assert.ok(sentences.length >= 2, 'expected several sentence events');
    assert.match(sentences[1].text, /You asked: What is a KV cache\./);

    const done = events.at(-1);
    assert.equal(done.type, 'done');
    for (const key of ['ttft_ms', 'first_sentence_ms', 'total_ms', 'completion_tokens']) {
      assert.equal(typeof done.stats[key], 'number', key);
    }
    assert.ok(done.stats.first_sentence_ms <= done.stats.total_ms);
    // The KV cache question matches the cheat sheet.
    assert.ok(done.sources.some((s) => /KV cache/.test(s.heading)));
  } finally {
    server.close();
  }
});

test('history grows per session, is capped, and /reset clears it', async () => {
  const { server, url } = await startServer();
  try {
    for (const q of ['one', 'two', 'three']) await ask(url, { question: q, sessionId: 's', useNotes: false });
    assert.deepEqual(
      server.sessions.get('s').history.filter((m) => m.role === 'user').map((m) => m.content),
      ['two', 'three'],
    );
    const last = await ask(url, { question: 'four', sessionId: 's', useNotes: false });
    assert.equal(last.events.at(-1).stats.history_messages, 4);

    await fetch(`${url}/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 's' }) });
    assert.equal(server.sessions.has('s'), false);
  } finally {
    server.close();
  }
});

test('useNotes false skips the notes search', async () => {
  const { server, url } = await startServer();
  try {
    const { events } = await ask(url, { question: 'What is a KV cache?', useNotes: false });
    assert.equal(events.at(-1).stats.notes_hits, 0);
  } finally {
    server.close();
  }
});

test('bad requests get a 400', async () => {
  const { server, url } = await startServer();
  try {
    assert.equal((await ask(url, { question: '   ' })).status, 400);
    const res = await fetch(`${url}/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not json' });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('blocks requests a web page could send', async () => {
  const { server, url } = await startServer();
  try {
    // A plain form post from a browser has no JSON content type.
    const form = await fetch(`${url}/ask`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"question":"hi"}' });
    assert.equal(form.status, 415);

    // DNS rebinding: the Host header names some other site.
    const status = await new Promise((resolve, reject) => {
      const req = http.request(`${url}/health`, { headers: { Host: 'evil.example:80' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
  } finally {
    server.close();
  }
});
