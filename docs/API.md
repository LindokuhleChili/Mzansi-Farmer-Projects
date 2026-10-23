# Mzansi Farmer Ops: HTTP API contract (v1)

Base URL (local default): `http://localhost:3000`. All bodies are JSON (`Content-Type: application/json`).
All data in the demo is **fictional example data**. Every error uses the same shape:

```json
{ "error": "ERROR_CODE", "message": "Human readable text", "requestId": "req_ab12cd34", "details": [] }
```

Every response carries an `X-Request-Id` header (the same value as `requestId` in errors and audit rows).

## Authentication

| Caller | Header | Value |
|---|---|---|
| Sensor device (ESP32 or simulator), `POST /api/readings` only | `X-Device-Token` | the value of the server's `DEVICE_TOKEN` environment variable |
| Farmer / app (all other `/api/*` routes) | `Authorization` | `Bearer <value of APP_TOKEN>` (the server's `APP_TOKEN` env var) |

`GET /health` needs no header. A missing or wrong token returns `401` with `error: "UNAUTHORIZED"`.
The device token can only post readings; it cannot approve, reject or delete anything.
Tokens are never committed; the server reads them from environment variables (see `.env.example`).

## 1. Post a sensor reading (ESP32 / simulator)

```http
POST /api/readings
Content-Type: application/json
X-Device-Token: <DEVICE_TOKEN>

{
  "deviceId": "esp32-demo-01",
  "plotId": 1,
  "soilMoisturePct": 18.5,
  "temperatureC": 29.4,
  "humidityPct": 41.0,
  "raining": false,
  "readAt": "2026-10-23T08:00:00Z"
}
```

| Field | Type | Required | Rules |
|---|---|---|---|
| `deviceId` | string | yes | 1 to 40 chars |
| `plotId` | integer | yes | must be an existing plot (demo plots are 1 to 5) |
| `soilMoisturePct` | number | yes | 0 to 100 |
| `temperatureC` | number | yes | -20 to 60 |
| `humidityPct` | number | yes | 0 to 100 |
| `raining` | boolean | no (default `false`) | from the raindrop sensor |
| `readAt` | string, ISO 8601 with `Z` or offset | no | server time is used when omitted; future times more than 5 minutes ahead are rejected |

Responses:

| Status | Body |
|---|---|
| `201` | `{ "readingId": 1007, "plotId": 1, "deviceId": "esp32-demo-01", "readAt": "2026-10-23T08:00:00.000Z", "stored": true }` |
| `400` | `{ "error": "VALIDATION_ERROR", "message": "...", "details": [ { "field": "soilMoisturePct", "problem": "must be between 0 and 100" } ] }` |
| `401` | `{ "error": "UNAUTHORIZED", ... }` |
| `404` | `{ "error": "PLOT_NOT_FOUND", ... }` |
| `502` | `{ "error": "OE_UNAVAILABLE", ... }` (OpenEdge / PASOE not reachable; the device should retry later) |

Recommended device behaviour: post every 30 s; on `5xx` or network failure keep the reading and retry with backoff; on `400` drop the reading (it will never be accepted).

curl example:

```bash
curl -i -X POST http://localhost:3000/api/readings \
  -H "Content-Type: application/json" -H "X-Device-Token: $DEVICE_TOKEN" \
  -d '{"deviceId":"esp32-demo-01","plotId":1,"soilMoisturePct":18.5,"temperatureC":29.4,"humidityPct":41,"raining":false}'
```

## 2. Read data (numbers always come from OpenEdge)

| Method and path | Returns |
|---|---|
| `GET /health` | `{ "status": "ok", "oeMode": "mock" \| "pasoe", "aiProvider": "mock" \| "http" }` |
| `GET /api/plots` | `{ "plots": [ { "plotId": 1, "farmId": 1, "plotName": "Maize Plot A (example)", "crop": "Maize", "areaHa": 1.2, "maxIrrigationLitres": 500, "dryThresholdPct": 35, "weeklyWaterBudgetL": 1500 } ] }` |
| `GET /api/plots/{plotId}/readings?limit=20` | `{ "plotId": 1, "readings": [ { "readingId": 1, "deviceId": "...", "readAt": "...", "soilMoisturePct": 18.5, "temperatureC": 29.4, "humidityPct": 41, "raining": false } ] }` newest first |
| `GET /api/suggestions?status=pending_approval` | `{ "suggestions": [ Suggestion ] }` |
| `GET /api/suggestions/{id}` | `Suggestion` |
| `GET /api/audit?limit=50` | `{ "events": [ { "auditId": 1, "at": "...", "requestId": "...", "actor": "...", "event": "...", "detail": { } } ] }` newest first |

## 3. AI proposes, ABL validates, the farmer approves

### 3.1 Ask for advice

```http
POST /api/plots/1/advise
Authorization: Bearer <APP_TOKEN>
{ "lang": "en" }          // "en" (default) or "zu" (draft translation, needs native-speaker review)
```

The API reads the plot and the latest readings **from OpenEdge**, asks the AI layer for a structured proposal, validates the model output against a schema, and sends the proposal to the OpenEdge rule check. Response `200`:

```json
{
  "suggestionId": 3,
  "requestId": "req_ab12cd34",
  "status": "pending_approval",
  "proposal": { "plotId": 1, "action": "irrigate", "litres": 300, "reason": "Soil moisture is 18% ..." },
  "verdict": "approved_by_rules",
  "rejectReasons": [],
  "facts": { "soilMoisturePct": 18.5, "readingAgeMinutes": 4, "dryThresholdPct": 35, "usedLast7DaysL": 0, "weeklyWaterBudgetL": 1500 },
  "ai": { "provider": "mock", "usedFallback": false, "note": "AI-generated suggestion. The numbers in 'facts' come from OpenEdge." },
  "next": "POST /api/suggestions/3/approve to start the confirmation step"
}
```

When the rules refuse, `status` is `"rejected"`, `verdict` is `"rejected_by_rules"` and `rejectReasons` is a list such as `[ { "code": "SENSOR_STALE", "message": "Latest reading is 2880 min old (limit 30)." } ]`. Nothing can be approved from a rejected suggestion (`409 NOT_APPROVABLE`).

Reject codes: `PLOT_NOT_FOUND`, `ACTION_NOT_ALLOWED`, `LITRES_OUT_OF_RANGE`, `NO_SENSOR_DATA`, `SENSOR_STALE`, `SOIL_NOT_DRY`, `RAIN_DETECTED`, `WATER_BUDGET_EXCEEDED`.

`Suggestion` = `{ suggestionId, plotId, action, litres, reason, provider, status, verdict, rejectReasons, createdAt, decidedAt, requestId }`.
`status` values: `rejected`, `pending_approval`, `approved`, `declined`, `deleted`.

### 3.2 Approve (two steps, explicit confirmation)

1. `POST /api/suggestions/{id}/approve` with `{}` returns `202` and `{ "error": "CONFIRMATION_REQUIRED", "confirmToken": "cfm_...", "summary": "Irrigate Maize Plot A with 300 L", "expiresInSeconds": 120 }`. Nothing changes yet.
2. `POST /api/suggestions/{id}/approve` with `{ "confirmToken": "cfm_..." }` re-runs the OpenEdge rules (the data may have changed), then returns `200` with the updated `Suggestion` (`status: "approved"`). A wrong, expired or reused token returns `403 CONFIRMATION_INVALID`.

`POST /api/suggestions/{id}/reject` (`{ "reason": "optional" }`) sets `status: "declined"`; it is low-risk, so it needs no confirmation.
`DELETE /api/suggestions/{id}` uses the same two-step confirmation (`confirmToken` in the JSON body of the second call) and sets `status: "deleted"` (the audit trail is kept).

### Status codes summary

`200` ok, `201` created, `202` confirmation required, `400` validation error, `401` unauthorized, `403` bad confirmation token, `404` not found, `409` not approvable or already decided, `502` OpenEdge unavailable, `504` OpenEdge timeout.
If the AI provider fails or returns bad output, `advise` still returns `200` using the deterministic fallback, with `ai.usedFallback: true` and `ai.fallbackReason`.
