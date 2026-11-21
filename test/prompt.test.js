import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMessages, trimHistory, SYSTEM_PROMPT } from '../brain/prompt.js';
import { remember } from '../brain/assistant.js';

const pair = (q, a) => [
  { role: 'user', content: q },
  { role: 'assistant', content: a },
];

test('message order is system, history, question', () => {
  const history = pair('hi', 'hello');
  const messages = buildMessages({ question: 'how are you', history, now: new Date('2026-11-21T10:00:00') });
  assert.deepEqual(
    messages.map((m) => m.role),
    ['system', 'user', 'assistant', 'user'],
  );
  assert.ok(messages[0].content.startsWith(SYSTEM_PROMPT));
  assert.match(messages[0].content, /Saturday, 21 November 2026 at 10:00/);
  assert.equal(messages.at(-1).content, 'how are you');
});

test('note passages go into the question, not the system prompt', () => {
  const hits = [{ file: 'a.md', heading: 'A', text: 'The sky is green here.' }];
  const messages = buildMessages({ question: 'what colour is the sky', hits });
  assert.match(messages.at(-1).content, /\[1\] \(a\.md > A\) The sky is green here\./);
  assert.match(messages.at(-1).content, /Question: what colour is the sky$/);
  assert.doesNotMatch(messages[0].content, /sky/);
});

test('trimHistory drops the oldest pairs first when over budget', () => {
  const history = [...pair('old '.repeat(100), 'x'), ...pair('new question', 'new answer')];
  const kept = trimHistory(history, 50);
  assert.deepEqual(
    kept.map((m) => m.content),
    ['new question', 'new answer'],
  );
});

test('remember keeps only the newest turns', () => {
  const history = [];
  for (let i = 1; i <= 5; i++) remember(history, `q${i}`, `a${i}`, 2);
  assert.deepEqual(
    history.map((m) => m.content),
    ['q4', 'a4', 'q5', 'a5'],
  );
});
