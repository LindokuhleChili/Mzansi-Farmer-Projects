# Mzansi Farmer Ops: HTTP API contract (v1)

Base URL (local default): `http://<laptop-LAN-IP>:3000` (plain http, port 3000, server binds `0.0.0.0`; use `http://localhost:3000` on the same machine). Default sensor reading interval: **30 s**. All bodies are JSON (`Content-Type: application/json`).
All data in the demo is **fictional example data**. Every error uses the same shape:

```json
{ "error": "ERROR_CODE", "message": "Human readable text", "requestId": "req_ab12cd34", "details": [] }
```

Every response carries an `X-Request-Id` header (the same value as `requestId` in errors and audit rows).

## Authentication

| Caller | Header | Value |
|---|---|---|
| Sensor device (ESP32 or simulator), `POST /api/v1/readings` only | `X-Device-Token` | the device's own token. The server maps the token to a `deviceId` and its `plotId` (configured in the `DEVICE_REGISTRY` environment variable). The body also carries `deviceId` and `plotId`; both are cross-checked against the token. |
| Farmer / app (all other `/api/v1/*` routes) | `Authorization` | `Bearer <value of APP_TOKEN>` (the server's `APP_TOKEN` env var) |

`GET /health` needs no header. A missing or wrong token returns `401` with `error: "UNAUTHORIZED"`.
A device token can only post readings; it cannot approve, reject or delete anything.
Tokens are never committed; the server reads them from environment variables (see `.env.example`).

## 1. Post a sensor reading (ESP32 / simulator)

```http
POST /api/v1/readings
Content-Type: application/json
X-Device-Token: <device token>

{
  "deviceId": "esp32-01",
  "plotId": 1,
  "timestamp": "2026-10-24T08:00:00Z",
  "soilMoisturePct": 18.5,
  "temperatureC": 29.4,
  "humidityPct": 41.0
}
```

| Field | Type | Required | Rules |
|---|---|---|---|
| `deviceId` | string | yes | must equal the device id the token maps to (`esp32-01`) |
| `plotId` | integer | yes | must equal the plot the token maps to (demo: `esp32-01` is plot 1); cross-check, not a way to choose a plot |
| `timestamp` | string, ISO 8601 UTC (`...Z`) | yes | must be a real calendar date (no 31 February, leap years respected); not more than 5 minutes in the future |
| `soilMoisturePct` | number | yes | 0 to 100 |
| `temperatureC` | number | yes | -20 to 60 |
| `humidityPct` | number | yes | 0 to 100 |
| `raining` | boolean | no (default `false`) | optional extension for a raindrop sensor; rule `RAIN_DETECTED` uses it |

Responses:

| Status | Body |
|---|---|
| `201` | `{ "id": 1007 }` (the OpenEdge `SensorReading.ReadingId`) |
| `400` | `{ "error": "VALIDATION_ERROR", "field": "soilMoisturePct", "message": "must be a number between 0 and 100", "requestId": "..." }` (also for a missing field, bad JSON types, `deviceId`/`plotId` not matching the token: `error: "DEVICE_MISMATCH"`, `field: "plotId"` or `"deviceId"`) |
| `401` | `{ "error": "UNAUTHORIZED", "message": "...", "requestId": "..." }` (missing or unknown token) |
| `409` | `{ "error": "DUPLICATE_READING", "field": "timestamp", "message": "...", "requestId": "..." }` (same `deviceId` + `timestamp` already stored) |
| `502` / `504` | `{ "error": "OE_UNAVAILABLE" \| "OE_TIMEOUT", ... }` (OpenEdge not reachable; keep the reading and retry later) |

Recommended device behaviour: post every 30 s; on `5xx` or network failure keep the reading and retry with backoff; on `400` or `409` drop it (it will never be accepted). Use a fresh `timestamp` per reading (UTC, second precision is enough).

curl example:

```bash
curl -i -X POST http://localhost:3000/api/v1/readings \
  -H "Content-Type: application/json" -H "X-Device-Token: $DEVICE_TOKEN" \
  -d '{"deviceId":"esp32-01","plotId":1,"timestamp":"2026-10-24T08:00:00Z","soilMoisturePct":18.5,"temperatureC":29.4,"humidityPct":41}'
```

## 2. Read data (numbers always come from OpenEdge)

| Method and path | Returns |
|---|---|
| `GET /health` | `{ "status": "ok", "oeMode": "mock" \| "pasoe", "aiProvider": "mock" \| "http" }` |
| `GET /api/v1/plots` | `{ "plots": [ { "plotId": 1, "farmId": 1, "plotName": "Maize Plot A (example)", "crop": "Maize", "areaHa": 1.2, "maxIrrigationLitres": 500, "dryThresholdPct": 35, "weeklyWaterBudgetL": 1500 } ] }` |
| `GET /api/v1/plots/{plotId}/readings?limit=20` | `{ "plotId": 1, "readings": [ { "readingId": 1, "deviceId": "...", "readAt": "...", "soilMoisturePct": 18.5, "temperatureC": 29.4, "humidityPct": 41, "raining": false } ] }` newest first |
| `GET /api/v1/suggestions?status=pending_approval` | `{ "suggestions": [ Suggestion ] }` |
| `GET /api/v1/suggestions/{id}` | `Suggestion` |
| `GET /api/v1/audit?limit=50` | `{ "events": [ { "auditId": 1, "at": "...", "requestId": "...", "actor": "...", "event": "...", "detail": { } } ] }` newest first |

## 3. AI proposes, ABL validates, the farmer approves

### 3.1 Ask for advice

```http
POST /api/v1/plots/1/advise
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
  "next": "POST /api/v1/suggestions/3/approve to start the confirmation step"
}
```

When the rules refuse, `status` is `"rejected"`, `verdict` is `"rejected_by_rules"` and `rejectReasons` is a list such as `[ { "code": "SENSOR_STALE", "message": "Latest reading is 2880 min old (limit 15)." } ]`. Nothing can be approved from a rejected suggestion (`409 NOT_APPROVABLE`).

Reject codes: `PLOT_NOT_FOUND`, `ACTION_NOT_ALLOWED`, `LITRES_OUT_OF_RANGE`, `NO_SENSOR_DATA`, `SENSOR_STALE`, `SOIL_NOT_DRY`, `RAIN_DETECTED`, `WATER_BUDGET_EXCEEDED`.

`Suggestion` = `{ suggestionId, plotId, action, litres, reason, provider, status, verdict, rejectReasons, createdAt, decidedAt, requestId }`.
`status` values: `rejected`, `pending_approval`, `approved`, `declined`, `deleted`.

### 3.2 Approve (two steps, explicit confirmation)

1. `POST /api/v1/suggestions/{id}/approve` with `{}` returns `202` and `{ "error": "CONFIRMATION_REQUIRED", "confirmToken": "cfm_...", "summary": "Irrigate Maize Plot A with 300 L", "expiresInSeconds": 120 }`. Nothing changes yet.
2. `POST /api/v1/suggestions/{id}/approve` with `{ "confirmToken": "cfm_..." }` re-runs the OpenEdge rules (the data may have changed), then returns `200` with the updated `Suggestion` (`status: "approved"`). A wrong, expired or reused token returns `403 CONFIRMATION_INVALID`.

`POST /api/v1/suggestions/{id}/reject` (`{ "reason": "optional" }`) sets `status: "declined"`; it is low-risk, so it needs no confirmation.
`DELETE /api/v1/suggestions/{id}` uses the same two-step confirmation (`confirmToken` in the JSON body of the second call) and sets `status: "deleted"` (the audit trail is kept).

### Status codes summary

`200` ok, `201` created, `202` confirmation required, `400` validation error, `401` unauthorized, `403` bad confirmation token, `404` not found, `409` duplicate reading / not approvable / already decided, `502` OpenEdge unavailable, `504` OpenEdge timeout.
If the AI provider fails or returns bad output, `advise` still returns `200` using the deterministic fallback, with `ai.usedFallback: true` and `ai.fallbackReason`.
