import { esp32DashboardUrlFromEnv } from '../../web/public/assets/js/esp32-url.js';

// All tunables as named constants + environment variables. No secrets in code: tokens and keys come from the environment.

export const AI_TIMEOUT_MS = 8000;          // max wait for the AI provider before the deterministic fallback is used
export const OE_TIMEOUT_MS = 5000;          // max wait for OpenEdge (PASOE) per call; exceeded => 504 OE_TIMEOUT
export const AUDIT_TIMEOUT_MS = 1000;       // max wait for the audit write after a tool call (never doubles an OpenEdge outage)
export const CONFIRM_TTL_SECONDS = 120;     // lifetime of a single-use confirmation token (approve / delete)
export const FUTURE_SKEW_MINUTES = 5;       // reading timestamps further in the future than this are rejected
export const READINGS_FOR_AI = 12;          // how many recent readings are loaded from OpenEdge for each advice request
export const LITRES_PER_PCT_DEFICIT = 15;   // deterministic sizing: litres per percentage point below the dry threshold
export const MAX_REASON_LENGTH = 400;

function embedDim(env) {
  const n = parseInt(env.AI_EMBED_DIM ?? '256', 10);
  if (!Number.isInteger(n) || n < 32 || n > 256) return 256;
  return n;
}

export function loadConfig(env = process.env) {
  const oeMode = (env.OE_MODE || 'mock').toLowerCase();
  if (!['mock', 'pasoe'].includes(oeMode)) throw new Error(`OE_MODE must be mock or pasoe (got "${env.OE_MODE}")`);
  const appToken = env.APP_TOKEN || '';
  let registry = [];
  try { registry = JSON.parse(env.DEVICE_REGISTRY || '[]'); } catch { throw new Error('DEVICE_REGISTRY must be valid JSON'); }
  if (!Array.isArray(registry)) throw new Error('DEVICE_REGISTRY must be a JSON array');
  const problems = [];
  if (!appToken || appToken.startsWith('replace-')) problems.push('APP_TOKEN is not set (run `npm run setup` to create a .env with random tokens)');
  if (registry.length === 0) problems.push('DEVICE_REGISTRY is empty (run `npm run setup`)');
  for (const d of registry) {
    if (!d.deviceId || !Number.isInteger(d.plotId) || !d.token || String(d.token).startsWith('replace-')) problems.push(`DEVICE_REGISTRY entry invalid: ${JSON.stringify({ deviceId: d.deviceId, plotId: d.plotId })}`);
  }
  return {
    port: parseInt(env.PORT || '3000', 10),
    host: env.HOST || '0.0.0.0',
    oeMode,
    oeBaseUrl: env.OE_BASE_URL || 'http://localhost:8820/web',
    oeTimeoutMs: Number.isInteger(+env.OE_TIMEOUT_MS) && +env.OE_TIMEOUT_MS >= 50 ? +env.OE_TIMEOUT_MS : OE_TIMEOUT_MS,   // OE_TIMEOUT_MS env var is for tests
    oeAuth: env.OE_AUTH || '',                     // optional "user:password" for PASOE basic auth (PSCUser, e.g. farmapi)
    oeAdminAuth: env.OE_ADMIN_AUTH || '',          // optional "user:password" with PSCAdmin (farmadmin) for the admin routes
    aiProvider: (env.AI_PROVIDER || 'mock').toLowerCase(),   // mock | http (any OpenAI-compatible chat completions API)
    aiBaseUrl: env.AI_BASE_URL || '',
    aiApiKey: env.AI_API_KEY || '',
    aiModel: env.AI_MODEL || '',
    weatherSource: String(env.WEATHER_SOURCE || 'open-meteo').toLowerCase() === 'example' ? 'example' : 'open-meteo',   // 'example' = never fetch, keep the example seed
    weatherTimeoutMs: Number.isInteger(+env.WEATHER_TIMEOUT_MS) && +env.WEATHER_TIMEOUT_MS >= 100 ? +env.WEATHER_TIMEOUT_MS : 8000,
    aiDoctorTimeoutMs: Number.isInteger(+env.AI_DOCTOR_TIMEOUT_MS) && +env.AI_DOCTOR_TIMEOUT_MS >= 100 ? +env.AI_DOCTOR_TIMEOUT_MS : 30000,   // plant doctor (photos take longer)
    aiAgentTimeoutMs: Number.isInteger(+env.AI_AGENT_TIMEOUT_MS) && +env.AI_AGENT_TIMEOUT_MS >= 100 ? +env.AI_AGENT_TIMEOUT_MS : 20000,   // Farm Assistant: one tool-loop step
    assistantCheckInMs: Number.isInteger(+env.ASSISTANT_CHECKIN_MS) && +env.ASSISTANT_CHECKIN_MS >= 0 ? +env.ASSISTANT_CHECKIN_MS : 15 * 60000,   // proactive check-ins; 0 = off
    similarCases: !['0', 'false', 'off', 'no'].includes(String(env.SIMILAR_CASES ?? 'on').toLowerCase()),   // plant-doctor similar cases; off skips the extra AI calls
    aiEmbedModel: env.AI_EMBED_MODEL || 'gemini-embedding-001',   // text embedding of the photo description; does not change AI_MODEL
    aiEmbedDim: embedDim(env),
    aiEmbedTimeoutMs: Number.isInteger(+env.AI_EMBED_TIMEOUT_MS) && +env.AI_EMBED_TIMEOUT_MS >= 100 ? +env.AI_EMBED_TIMEOUT_MS : 8000,
    farmWatchIntervalMin: Number.isInteger(+env.FARM_WATCH_INTERVAL_MIN) && +env.FARM_WATCH_INTERVAL_MIN > 0 ? +env.FARM_WATCH_INTERVAL_MIN : 0,   // 0 = scheduled watch off
    farmWatchDedupeHours: Number.isInteger(+env.FARM_WATCH_DEDUPE_HOURS) && +env.FARM_WATCH_DEDUPE_HOURS >= 1 ? +env.FARM_WATCH_DEDUPE_HOURS : 24,
    aiTranslateTimeoutMs: Number.isInteger(+env.AI_TRANSLATE_TIMEOUT_MS) && +env.AI_TRANSLATE_TIMEOUT_MS >= 100 ? +env.AI_TRANSLATE_TIMEOUT_MS : AI_TRANSLATE_TIMEOUT_MS,   // translation only; advice keeps AI_TIMEOUT_MS
    appToken, registry,
    logDir: env.LOG_DIR || 'logs',
    logLevel: env.LOG_LEVEL || 'warn',
    uiEnabled: !['0', 'false', 'off', 'no'].includes(String(env.UI_ENABLED ?? '1').toLowerCase()),   // serve the web UI at / (static files + local-only /ui/api proxy)
    uiAllowRemote: ['1', 'true', 'on', 'yes'].includes(String(env.UI_ALLOW_REMOTE ?? '0').toLowerCase()),   // let non-loopback clients use the /ui/api proxy (OFF by default)
    esp32DashboardUrl: esp32DashboardUrlFromEnv(env.ESP32_DASHBOARD_URL),   // browser reads this address; the server never connects to it
    problems,
  };
}
export const TRANSLATE_MAX_TEXTS = 60;      // max strings per POST /api/v1/translate
export const TRANSLATE_MAX_CHARS = 500;     // max characters per string (market notes are max 500)
export const AI_TRANSLATE_TIMEOUT_MS = 20000; // default max wait for one translation batch (override with AI_TRANSLATE_TIMEOUT_MS)
export const TRANSLATE_CACHE_MAX = 5000;    // in-memory translation cache entries (oldest dropped first)
