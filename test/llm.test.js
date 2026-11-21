// Tests the real OpenRouter client against a local fake server that speaks
// the same streaming format. No internet, no API cost.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { streamChat, resetCooldowns, coolingModels } from '../brain/llm.js';
import { getConfig } from '../brain/config.js';

function sse(res, chunks) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(': OPENROUTER PROCESSING\n\n');
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.end('data: [DONE]\n\n');
}

/** Starts a fake OpenRouter. `behave(model)` decides the reply for each model. */
async function fakeOpenRouter(behave) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const body = JSON.parse(raw);
      calls.push(body);
      behave(body.model, res, body);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  // The client only adds OpenRouter fields when the URL mentions openrouter.ai,
  // so the path carries that name.
  const baseUrl = `http://127.0.0.1:${server.address().port}/openrouter.ai/api/v1`;
  return { server, calls, baseUrl };
}

const reply = (text) => (model, res) =>
  sse(res, [
    { model, choices: [{ delta: { content: text.slice(0, 5) } }] },
    { model, choices: [{ delta: { content: text.slice(5) }, finish_reason: 'stop' }] },
    { model, choices: [], usage: { prompt_tokens: 12, completion_tokens: 4, cost: 0.00001 } },
  ]);

async function collect(config) {
  const events = [];
  for await (const e of streamChat(config, { messages: [{ role: 'user', content: 'hi' }], temperature: 0, topP: 1, maxTokens: 50 })) {
    events.push(e);
  }
  return events;
}

test('parses tokens, finish reason and usage from the stream', async () => {
  resetCooldowns();
  const fake = await fakeOpenRouter(reply('Hello world.'));
  try {
    const config = getConfig({ LLM_BASE_URL: fake.baseUrl, OPENROUTER_API_KEY: 'test', LLM_MODEL: 'main' });
    const events = await collect(config);
    const text = events.filter((e) => e.type === 'token').map((e) => e.text).join('');
    assert.equal(text, 'Hello world.');
    assert.equal(events.find((e) => e.type === 'finish').reason, 'stop');
    assert.equal(events.find((e) => e.type === 'usage').usage.completion_tokens, 4);
    // Thinking is switched off and usage is requested.
    assert.deepEqual(fake.calls[0].reasoning, { enabled: false });
    assert.deepEqual(fake.calls[0].usage, { include: true });
    assert.equal(fake.calls[0].stream, true);
  } finally {
    fake.server.close();
  }
});

test('falls back when the main model has no credits, then skips it for a while', async () => {
  resetCooldowns();
  const fake = await fakeOpenRouter((model, res) => {
    if (model === 'main') {
      res.writeHead(402, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'needs more credits', code: 402 } }));
    } else {
      reply('From backup.')(model, res);
    }
  });
  try {
    const config = getConfig({ LLM_BASE_URL: fake.baseUrl, OPENROUTER_API_KEY: 'test', LLM_MODEL: 'main', LLM_FALLBACK_MODELS: 'backup' });

    const first = await collect(config);
    assert.equal(first[0].type, 'fallback');
    assert.equal(first[0].to, 'backup');
    assert.deepEqual(fake.calls.map((c) => c.model), ['main', 'backup']);
    assert.equal(coolingModels()[0].model, 'main');

    // Second question goes straight to the backup. No wasted call.
    await collect(config);
    assert.deepEqual(fake.calls.map((c) => c.model), ['main', 'backup', 'backup']);
  } finally {
    fake.server.close();
    resetCooldowns();
  }
});

test('reports the HTTP error when there is no fallback', async () => {
  resetCooldowns();
  const fake = await fakeOpenRouter((model, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'bad key' } }));
  });
  try {
    const config = getConfig({ LLM_BASE_URL: fake.baseUrl, OPENROUTER_API_KEY: 'wrong', LLM_MODEL: 'main' });
    await assert.rejects(collect(config), (err) => err.status === 401 && /bad key/.test(err.message));
  } finally {
    fake.server.close();
  }
});

test('missing key fails fast with a clear message', async () => {
  const config = getConfig({ OPENROUTER_API_KEY: '', LLM_MODEL: 'main' });
  await assert.rejects(collect(config), /OPENROUTER_API_KEY is missing/);
});
