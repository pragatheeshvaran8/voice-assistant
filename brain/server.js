// Starts the brain: node brain/server.js
// The PowerShell voice client starts this for you if it is not running.

import { getConfig } from './config.js';
import { createBrainServer } from './app.js';

const config = getConfig();
const server = createBrainServer(config);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${config.port} is already used by another program. Set BRAIN_PORT in .env to a free port.`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  const notes = server.notes.stats();
  const fallback = config.fallbackModels.length ? ` (fallback: ${config.fallbackModels.join(', ')})` : '';
  console.log(`Brain ready on http://${config.host}:${config.port}`);
  console.log(`Model: ${config.provider === 'fake' ? 'fake (no API calls)' : config.model}${fallback}`);
  console.log(`Notes: ${config.notesEnabled ? `${notes.files} files, ${notes.chunks} chunks` : 'off'}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.closeAllConnections();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
