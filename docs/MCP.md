# MCP server

The assistant tools are available to an MCP client. The server calls the same functions as the Farm Assistant, which call OpenEdge. `DOSE_BLOCKED`, `CITATION_UNKNOWN` and the irrigation rules still apply. `propose_action` creates a suggestion or a step for the farmer to approve. It does not approve it, and it does not open a valve or send a message.

Tools: `get_farm_profile`, `get_sensor_readings`, `get_forecast`, `run_plant_doctor`, `search_guides`, `get_nearby_reports`, `get_case`, `list_harvest_days`, `propose_action`, `remember`, `find_similar_cases`.

`find_similar_cases` compares a stored **written description** of past photos when an embedding exists, and otherwise the crop and condition. It does not compare photo pixels. `run_plant_doctor` reads diagnoses already stored. New photos are still taken on the Plant doctor page.

The server reads `<repo>/.env`. Environment variables set by the client win. `APP_TOKEN` is required. No key is written into the source.

## stdio (Claude Desktop, Cursor, MCP Inspector)

From the repository root, after `npm install`:

```bash
npm run mcp
```

Claude Desktop (`claude_desktop_config.json`) or Cursor (`.cursor/mcp.json`), using the Windows demo path:

```json
{
  "mcpServers": {
    "mzansi-farmer": {
      "command": "node",
      "args": ["C:\\apps\\Mzansi-Farmer-Projects\\apps\\mcp\\src\\index.js"]
    }
  }
}
```

The process loads `C:\apps\Mzansi-Farmer-Projects\.env` itself, so the token does not need to be copied into this file. For a real OpenEdge database, `.env` should already contain `OE_MODE=pasoe`, `OE_BASE_URL` and `OE_AUTH`. stdout is the MCP protocol. Do not write logs to stdout.

MCP Inspector:

```bash
npx @modelcontextprotocol/inspector node apps/mcp/src/index.js
```

Run that from the repository root. The inspector starts the server on stdio. There is no bearer header on stdio: being able to start the process is the same trust as starting the API.

## Streamable HTTP

```bash
npm run mcp:http
```

Listens on `http://127.0.0.1:3001/mcp` unless `MCP_HTTP_HOST` / `MCP_HTTP_PORT` are set. Every request except CORS preflight needs:

```http
Authorization: Bearer <APP_TOKEN>
Accept: application/json, text/event-stream
```

The transport is stateless (no session id). A client that speaks Streamable HTTP can point at that URL. Do not expose the port off the machine: the token is the only check, and the service is plain HTTP.

## What a client must not expect

* `propose_action` with `irrigate`, `hold` or `notify` returns the OpenEdge verdict. `approved_by_rules` means the suggestion is `pending_approval`. The farmer still uses the two-step approval in the app.
* A rejected irrigation (stale sensor, soil not dry, rain, budget) stays rejected.
* A step that names a chemical dose returns `DOSE_BLOCKED` and is not stored.
* A citation id that is not a guide passage returns `CITATION_UNKNOWN`.
