// Streamable HTTP transport for the MCP server. Every request needs Authorization: Bearer <APP_TOKEN>.
// Stateless: one short-lived server per request, so a restart cannot leave a session behind. Binds to 127.0.0.1 unless MCP_HTTP_HOST is set.
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './server.js';

export function bearerOk(header, token) {
  const got = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(got);
  const b = Buffer.from(String(token || ''));
  if (!b.length || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(undefined);
      try { resolve(JSON.parse(raw)); } catch { reject(Object.assign(new Error('invalid json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

export function startMcpHttp({ oe, token, clock, host = '127.0.0.1', port = 3001 }) {
  const server = createServer(async (req, res) => {
    const finish = (status, obj) => {
      if (res.headersSent) return;
      const body = JSON.stringify(obj);
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, Mcp-Session-Id, Last-Event-ID', 'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS' });
      res.end(body);
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, Mcp-Session-Id, Last-Event-ID', 'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS' });
      res.end();
      return;
    }
    const path = (req.url || '/').split('?')[0];
    if (path !== '/mcp') return finish(404, { error: 'NOT_FOUND' });
    if (!bearerOk(req.headers.authorization, token)) return finish(401, { error: 'UNAUTHORIZED', message: 'Missing or invalid bearer token.' });
    let parsed;
    try { parsed = req.method === 'POST' ? await readBody(req) : undefined; }
    catch (e) { return finish(e.status || 400, { error: 'BAD_REQUEST', message: e.message || 'Bad request.' }); }
    const mcp = createMcpServer({ oe, clock });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close().catch(() => {}); mcp.close().catch(() => {}); });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, parsed);
    } catch (e) {
      finish(500, { error: 'INTERNAL_ERROR', message: e.message || 'MCP request failed.' });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      resolve({
        host, port: typeof addr === 'object' && addr ? addr.port : port, server,
        close: () => new Promise((done, err) => server.close((e) => e ? err(e) : done())),
      });
    });
  });
}
