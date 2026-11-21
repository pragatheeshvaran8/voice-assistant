// Appends one JSON line per question to logs/turns.jsonl.
// `npm run report` turns these lines into a latency table.

import fs from 'node:fs';
import path from 'node:path';

export function appendTurn(config, row) {
  fs.mkdirSync(config.logsDir, { recursive: true });
  const line = JSON.stringify({ ts: new Date().toISOString(), ...row });
  fs.appendFileSync(path.join(config.logsDir, 'turns.jsonl'), `${line}\n`, 'utf8');
}
