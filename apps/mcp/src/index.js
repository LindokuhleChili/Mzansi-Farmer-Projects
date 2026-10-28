// Mzansi Farmer MCP server.
//   node apps/mcp/src/index.js            stdio (Claude Desktop, Cursor, MCP Inspector)
//   node apps/mcp/src/index.js --http     Streamable HTTP on 127.0.0.1:MCP_HTTP_PORT (default 3001)
// Reads <repo>/.env. Real environment variables win. APP_TOKEN is required and is never printed.
// stdout is the MCP protocol in stdio mode, so logs go to stderr.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadEnvFile } from '../../api/src/env.js';
import { loadConfig } from '../../api/src/config.js';
import { createOeClient } from '../../api/src/oe/client.js';
import { createMcpServer } from './server.js';
import { startMcpHttp } from './http.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
loadEnvFile(join(repoRoot, '.env'));
const config = loadConfig();
if (config.problems.length) {
  console.error('Cannot start the MCP server:\n - ' + config.problems.join('\n - '));
  process.exit(1);
}
const oe = createOeClient(config);
const http = process.argv.includes('--http') || String(process.env.MCP_TRANSPORT || '').toLowerCase() === 'http';
if (http) {
  const port = Number.isInteger(+process.env.MCP_HTTP_PORT) && +process.env.MCP_HTTP_PORT > 0 ? +process.env.MCP_HTTP_PORT : 3001;
  const host = process.env.MCP_HTTP_HOST || '127.0.0.1';
  const started = await startMcpHttp({ oe, token: config.appToken, host, port });
  console.error(`mzansi-farmer MCP (streamable HTTP) on http://${started.host}:${started.port}/mcp  (OE_MODE=${oe.mode})  Bearer APP_TOKEN required`);
} else {
  const server = createMcpServer({ oe });
  await server.connect(new StdioServerTransport());
}
