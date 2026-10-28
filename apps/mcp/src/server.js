// MCP server for the farm assistant tools. Every tool calls the same functions the chat assistant uses,
// so OpenEdge still applies DOSE_BLOCKED, CITATION_UNKNOWN and the irrigation rules. propose_action stores a
// proposal or a case step. It never approves it and it never opens a valve.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { TOOL_DEFS, createTools, PROPOSAL_KINDS } from '../../api/src/assistant/tools.js';

const int = z.number().int();
const SCHEMAS = {
  get_farm_profile: {},
  get_sensor_readings: { plotId: int },
  get_forecast: {},
  run_plant_doctor: { diagnosisId: int.optional() },
  search_guides: { query: z.string() },
  get_nearby_reports: { plotId: int.optional() },
  get_case: { caseId: int },
  list_harvest_days: {},
  propose_action: {
    plotId: int,
    kind: z.enum(PROPOSAL_KINDS),
    litres: int.optional(),
    text: z.string(),
    cost: z.enum(['free', 'low', 'medium', 'high']).optional(),
    citations: z.array(int),
  },
  remember: { key: z.string(), value: z.string() },
  find_similar_cases: { diagnosisId: int.optional(), crop: z.string().optional(), condition: z.string().optional(), limit: int.optional() },
};

const READ_ONLY = new Set(['get_farm_profile', 'get_sensor_readings', 'get_forecast', 'run_plant_doctor', 'search_guides', 'get_nearby_reports', 'get_case', 'list_harvest_days', 'find_similar_cases']);

export function createMcpServer({ oe, clock = () => new Date() }) {
  const server = new McpServer({ name: 'mzansi-farmer', version: '0.1.0' });
  const known = new Set(TOOL_DEFS.map((t) => t.name));
  for (const def of TOOL_DEFS) {
    if (!SCHEMAS[def.name]) continue;
    server.registerTool(def.name, {
      description: def.description,
      inputSchema: SCHEMAS[def.name],
      annotations: { readOnlyHint: READ_ONLY.has(def.name), destructiveHint: false, openWorldHint: false },
    }, async (args) => {
      const requestId = 'mcp_' + randomBytes(4).toString('hex');
      const state = { passages: [], proposals: [], sensor: {}, plots: [], alerts: [] };
      const tools = createTools({
        call: (_name, method, path, body) => oe.call(method, path, body),
        clock, state, requestId, providerName: 'mcp',
      });
      const fn = tools[def.name];
      if (!fn || !known.has(def.name)) return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'UNKNOWN_TOOL' }) }] };
      try {
        const r = await fn(args || {});
        const isError = Boolean(r?.result?.error);
        return { isError, content: [{ type: 'text', text: JSON.stringify(r.result) }] };
      } catch (e) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'TOOL_FAILED', message: e.message || 'tool failed' }) }] };
      }
    });
  }
  return server;
}

export const MCP_TOOL_NAMES = TOOL_DEFS.map((t) => t.name);
