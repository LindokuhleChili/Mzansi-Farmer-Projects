// All tunables as named constants + environment variables. No secrets in code: tokens and keys come from the environment.
export const AI_TIMEOUT_MS = 8000;          // max wait for the AI provider before the deterministic fallback is used
export const OE_TIMEOUT_MS = 5000;          // max wait for OpenEdge (PASOE) per call; exceeded => 504 OE_TIMEOUT
export const AUDIT_TIMEOUT_MS = 1000;       // max wait for the audit write after a tool call (never doubles an OpenEdge outage)
export const CONFIRM_TTL_SECONDS = 120;     // lifetime of a single-use confirmation token (approve / delete)
export const FUTURE_SKEW_MINUTES = 5;       // reading timestamps further in the future than this are rejected
export const READINGS_FOR_AI = 12;          // how many recent readings are loaded from OpenEdge for each advice request
export const LITRES_PER_PCT_DEFICIT = 15;   // deterministic sizing: litres per percentage point below the dry threshold
export const MAX_REASON_LENGTH = 400;

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
    oeAuth: env.OE_AUTH || '',                     // optional "user:password" for PASOE basic auth
    aiProvider: (env.AI_PROVIDER || 'mock').toLowerCase(),   // mock | http (any OpenAI-compatible chat completions API)
    aiBaseUrl: env.AI_BASE_URL || '',
    aiApiKey: env.AI_API_KEY || '',
    aiModel: env.AI_MODEL || '',
    aiDoctorTimeoutMs: Number.isInteger(+env.AI_DOCTOR_TIMEOUT_MS) && +env.AI_DOCTOR_TIMEOUT_MS >= 100 ? +env.AI_DOCTOR_TIMEOUT_MS : 30000,   // plant doctor (photos take longer)
    aiTranslateTimeoutMs: Number.isInteger(+env.AI_TRANSLATE_TIMEOUT_MS) && +env.AI_TRANSLATE_TIMEOUT_MS >= 100 ? +env.AI_TRANSLATE_TIMEOUT_MS : AI_TRANSLATE_TIMEOUT_MS,   // translation only; advice keeps AI_TIMEOUT_MS
    appToken, registry,
    logDir: env.LOG_DIR || 'logs',
    logLevel: env.LOG_LEVEL || 'warn',
    uiEnabled: !['0', 'false', 'off', 'no'].includes(String(env.UI_ENABLED ?? '1').toLowerCase()),   // serve the web UI at / (static files + local-only /ui/api proxy)
    uiAllowRemote: ['1', 'true', 'on', 'yes'].includes(String(env.UI_ALLOW_REMOTE ?? '0').toLowerCase()),   // let non-loopback clients use the /ui/api proxy (OFF by default)
    problems,
  };
}
export const TRANSLATE_MAX_TEXTS = 60;      // max strings per POST /api/v1/translate
export const TRANSLATE_MAX_CHARS = 500;     // max characters per string (market notes are max 500)
export const AI_TRANSLATE_TIMEOUT_MS = 20000; // default max wait for one translation batch (override with AI_TRANSLATE_TIMEOUT_MS)
export const TRANSLATE_CACHE_MAX = 5000;    // in-memory translation cache entries (oldest dropped first)
