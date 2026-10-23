#!/usr/bin/env node
'use strict';
// Tiny mock of the Mzansi readings API for local demos and tests. No dependencies.
//   DEVICE_TOKEN=demo-token node mock-server.js [--port 3000]
// Behaviour (matches the contract):
//   wrong/missing X-Device-Token -> 401 {"error":"unauthorized"}
//   malformed JSON / invalid field -> 400 {"error":...,"field":...}
//   same deviceId+timestamp again   -> 409 {"error":"duplicate"}
//   otherwise                       -> 201 {"id":N}
const http = require('node:http');
const { CONTRACT, validatePayload } = require('./payload');

function createServer({ token, log = console.log } = {}) {
  const seen = new Map(); // "deviceId|timestamp" -> id
  const stored = [];
  let nextId = 1;
  const F = CONTRACT.fields;

  const reply = (res, status, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  };

  const server = http.createServer((req, res) => {
    const url = (req.url || '').split('?')[0];
    if (req.method === 'GET' && url === '/health') return reply(res, 200, { ok: true, stored: stored.length });
    if (req.method === 'GET' && url === CONTRACT.path) return reply(res, 200, stored); // handy for demos
    if (url !== CONTRACT.path) return reply(res, 404, { error: 'not found' });
    if (req.method !== 'POST') return reply(res, 405, { error: 'method not allowed' });

    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 64 * 1024) req.destroy(); else chunks.push(c); });
    req.on('end', () => {
      if (req.headers[CONTRACT.authHeader.toLowerCase()] !== token) {
        log(`[mock] 401 bad/missing ${CONTRACT.authHeader}`);
        return reply(res, 401, { error: 'unauthorized' });
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
        log('[mock] 400 malformed JSON');
        return reply(res, 400, { error: 'malformed JSON', field: 'body' });
      }
      const bad = validatePayload(body);
      if (bad) {
        log(`[mock] 400 ${bad.field}: ${bad.error}  ${JSON.stringify(body)}`);
        return reply(res, 400, bad);
      }
      const key = `${body[F.deviceId]}|${body[F.timestamp]}`;
      if (seen.has(key)) {
        log(`[mock] 409 duplicate ${key}`);
        return reply(res, 409, { error: 'duplicate' });
      }
      const id = nextId++;
      seen.set(key, id);
      stored.push({ id, ...body });
      log(`[mock] 201 id=${id} ${JSON.stringify(body)}`);
      reply(res, 201, { id });
    });
  });
  server.stored = stored;
  return server;
}

if (require.main === module) {
  const { parseArgs } = require('node:util');
  const { values } = parseArgs({ options: { port: { type: 'string', default: '3000' }, host: { type: 'string', default: '0.0.0.0' } } });
  const token = process.env.DEVICE_TOKEN;
  if (!token) { console.error('error: set DEVICE_TOKEN (the token the mock will accept)'); process.exit(2); }
  createServer({ token }).listen(Number(values.port), values.host, () =>
    console.log(`[mock] listening on ${values.host}:${values.port}  POST ${CONTRACT.path}  header ${CONTRACT.authHeader}`));
}

module.exports = { createServer };
