// Standalone HTTP server for mock-pasoe: same REST contract as PASOE. Usage: node mock-pasoe/server.js  (default port 8820)
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createStore } from './store.js';
import { handle } from './handler.js';

export function createMockServer(store = createStore()) {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      const raw = Buffer.concat(chunks).toString('utf8');
      let r;
      try { body = raw ? JSON.parse(raw) : {}; r = handle(store, req.method, req.url, body); }
      catch { r = { status: 400, body: { error: 'INVALID_JSON', message: 'Request body is not valid JSON.' } }; }
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r.body));
    });
  });
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = parseInt(process.env.MOCK_PASOE_PORT || '8820', 10);
  createMockServer().listen(port, '127.0.0.1', () => console.log(`mock-pasoe on http://127.0.0.1:${port}/web/farm  (stand-in for PASOE; example data)`));
}
