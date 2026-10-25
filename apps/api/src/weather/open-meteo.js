// Real 7-day forecast from Open-Meteo (https://open-meteo.com, no key; data CC BY 4.0, credit "Weather data by Open-Meteo.com").
// The API fetches it and hands it to OpenEdge (POST /farm/forecast/import), which validates and stores it (IsSynthetic=false).
// If the fetch fails or the answer is odd, nothing is changed: the last stored forecast (or the example seed) stays, marked as such.
export const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';
// One representative farming town per province (latitude, longitude).
export const PROVINCE_COORDS = Object.freeze({
  'Eastern Cape': { place: 'Mthatha', lat: -31.59, lon: 28.78 },
  'Free State': { place: 'Bloemfontein', lat: -29.12, lon: 26.21 },
  Gauteng: { place: 'Pretoria', lat: -25.75, lon: 28.19 },
  'KwaZulu-Natal': { place: 'Greytown', lat: -29.06, lon: 30.59 },
  Limpopo: { place: 'Polokwane', lat: -23.9, lon: 29.45 },
  Mpumalanga: { place: 'Mbombela', lat: -25.47, lon: 30.97 },
  'North West': { place: 'Mahikeng', lat: -25.86, lon: 25.64 },
  'Northern Cape': { place: 'Upington', lat: -28.45, lon: 21.26 },
  'Western Cape': { place: 'Worcester', lat: -33.65, lon: 19.45 },
});

export class ForecastError extends Error { constructor(kind, message) { super(message); this.kind = kind; } }   // kind: unknown_province | timeout | http | network | invalid

export function openMeteoUrl(province) {
  const c = PROVINCE_COORDS[province];
  if (!c) throw new ForecastError('unknown_province', `No coordinates for province ${province}.`);
  const q = new URLSearchParams({ latitude: String(c.lat), longitude: String(c.lon), daily: 'temperature_2m_max,temperature_2m_min,precipitation_sum',
    timezone: 'Africa/Johannesburg', forecast_days: '7' });
  return `${OPEN_METEO_URL}?${q}`;
}

/** Turns an Open-Meteo daily answer into the /farm/forecast/import body. Throws ForecastError('invalid') on anything unexpected. */
export function parseOpenMeteo(province, data) {
  const d = data?.daily;
  const keys = ['time', 'temperature_2m_max', 'temperature_2m_min', 'precipitation_sum'];
  if (!d || !keys.every((k) => Array.isArray(d[k]) && d[k].length >= 7)) throw new ForecastError('invalid', 'Open-Meteo answer has no 7-day daily block.');
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const mx = d.temperature_2m_max[i], mn = d.temperature_2m_min[i], rain = d.precipitation_sum[i];
    if (!num(mx) || !num(mn) || !num(rain)) throw new ForecastError('invalid', `Open-Meteo day ${i + 1} has missing values.`);
    days.push({ dayNo: i + 1, tempMaxC: Math.round(mx * 10) / 10, tempMinC: Math.round(mn * 10) / 10, rainMm: Math.round(Math.max(0, rain) * 10) / 10 });
  }
  if (typeof d.time[0] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d.time[0])) throw new ForecastError('invalid', 'Open-Meteo answer has no start date.');
  return { province, baseDate: d.time[0], source: 'open-meteo', days };
}

export async function fetchOpenMeteo(province, { fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const url = openMeteoUrl(province);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new ForecastError('http', `Open-Meteo returned HTTP ${res.status}`);
    let data;
    try { data = await res.json(); } catch { throw new ForecastError('invalid', 'Open-Meteo answer is not JSON.'); }
    return parseOpenMeteo(province, data);
  } catch (e) {
    if (e instanceof ForecastError) throw e;
    if (e.name === 'AbortError') throw new ForecastError('timeout', `Open-Meteo did not answer within ${timeoutMs} ms`);
    throw new ForecastError('network', `Open-Meteo not reachable: ${e.cause?.code || e.message}`);
  } finally { clearTimeout(timer); }
}
