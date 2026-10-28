// MCP server. In-memory transport exercises the same tools as stdio. HTTP checks the APP_TOKEN gate.
// propose_action must not approve anything: a dose is blocked, and irrigation on a stale reading stays unapproved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../apps/api/src/config.js';
import { createOeClient } from '../apps/api/src/oe/client.js';
import { createMcpServer, MCP_TOOL_NAMES } from '../apps/mcp/src/server.js';
import { startMcpHttp } from '../apps/mcp/src/http.js';

const APP = 'mcp-app-token-fixture-123';
const TOOLS = ['get_farm_profile', 'get_sensor_readings', 'get_forecast', 'run_plant_doctor', 'search_guides', 'get_nearby_reports', 'get_case', 'list_harvest_days', 'propose_action', 'remember', 'find_similar_cases'];

function env() {
  return loadConfig({ OE_MODE: 'mock', APP_TOKEN: APP, AI_PROVIDER: 'mock', LOG_LEVEL: 'silent', LOG_DIR: mkdtempSync(join(tmpdir(), 'mfo-mcp-')), DEVICE_REGISTRY: JSON.stringify([{ deviceId: 'esp32-01', plotId: 1, token: 'mcp-device-token-fixture-1' }]) });
}
async function connect(oe) {
  const server = createMcpServer({ oe });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'mzansi-test', version: '0.0.0' });
  await client.connect(clientT);
  return { client, server };
}
const text = (res) => JSON.parse(res.content[0].text);

test('tools match the assistant registry', () => {
  assert.deepEqual(MCP_TOOL_NAMES, TOOLS);
});

test('in-memory client: profile, dose block, unapproved irrigation, similar cases', async () => {
  const config = env();
  const oe = createOeClient(config);
  const { client, server } = await connect(oe);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((t) => t.name).sort(), [...TOOLS].sort());
  const profile = text(await client.callTool({ name: 'get_farm_profile', arguments: {} }));
  assert.equal(profile.plots.length, 5);
  const dose = text(await client.callTool({ name: 'propose_action', arguments: { plotId: 4, kind: 'step', text: 'Spray copper fungicide at 20 ml per litre.', citations: [1], cost: 'low' } }));
  assert.equal(dose.error, 'DOSE_BLOCKED');
  const irr = text(await client.callTool({ name: 'propose_action', arguments: { plotId: 1, kind: 'irrigate', litres: 100, text: 'Water the maize at the base in the morning.', citations: [1] } }));
  assert.equal(irr.verdict, 'rejected_by_rules');
  assert.ok(irr.rejectReasons.includes('SENSOR_STALE'));
  const sugg = await oe.call('GET', `/farm/suggestions/${irr.suggestionId}`);
  assert.notEqual(sugg.body.status, 'approved');
  assert.equal(sugg.body.status, 'rejected');
  const body = { crop: 'Tomato', plantPart: 'leaf', growthStage: 'fruiting', province: 'KwaZulu-Natal', photoCount: 1, result: { condition: 'Early blight (likely)', confidence: 'medium', observations: 'Brown rings.', steps: [{ text: 'Remove the spotted leaves.', cost: 'free' }, { text: 'Water at the base in the morning.', cost: 'free' }, { text: 'Add mulch so soil does not splash.', cost: 'low' }], monitor: ['New spots'], neighbourRisk: { level: 'medium', reason: 'Spores spread with rain.' }, callExpert: 'Call your extension officer if it spreads.' } };
  assert.equal((await oe.call('POST', '/farm/doctor/diagnoses', body)).status, 201);
  assert.equal((await oe.call('POST', '/farm/doctor/diagnoses', { ...body, province: 'Limpopo' })).status, 201);
  const sim = text(await client.callTool({ name: 'find_similar_cases', arguments: { crop: 'Tomato', condition: 'Early blight (likely)' } }));
  assert.equal(sim.method, 'crop_condition');
  assert.ok(sim.cases.length >= 1);
  assert.match(sim.cases[0].label, /Early blight, /);
  await client.close();
  await server.close();
});

test('Streamable HTTP rejects a missing token and accepts APP_TOKEN', async () => {
  const config = env();
  const oe = createOeClient(config);
  const http = await startMcpHttp({ oe, token: config.appToken, host: '127.0.0.1', port: 0 });
  const url = `http://127.0.0.1:${http.port}/mcp`;
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } };
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify(init) })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, authorization: 'Bearer wrong-token-value' }, body: JSON.stringify(init) })).status, 401);
  const ok = await fetch(url, { method: 'POST', headers: { ...headers, authorization: `Bearer ${APP}` }, body: JSON.stringify(init) });
  assert.notEqual(ok.status, 401);
  assert.ok(ok.status < 500, `MCP initialize status ${ok.status}`);
  const opt = await fetch(url, { method: 'OPTIONS' });
  assert.equal(opt.status, 204);
  await http.close();
});
