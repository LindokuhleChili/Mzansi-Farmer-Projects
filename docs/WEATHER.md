# Weather alerts (feature 17)

No AI is used. OpenEdge compares a 7-day forecast with the alert levels, writes `WeatherAlert` rows and the audit log, and checks every change to an alert level. The farmer acknowledges alerts.

**Real forecast (Open-Meteo).** When the farmer presses "Check forecast", the API first fetches the real 7-day daily forecast from [Open-Meteo](https://open-meteo.com/). It needs no key. The request asks for `temperature_2m_max`, `temperature_2m_min` and `precipitation_sum` with `timezone=Africa/Johannesburg` and `forecast_days=7`, at one representative town per province (`apps/api/src/weather/open-meteo.js`, e.g. KwaZulu-Natal = Greytown -29.06, 30.59). OpenEdge then validates the data and stores it (`POST /farm/forecast/import`, `FORECAST_INVALID` on bad data), replacing that province's rows for that base date with `IsSynthetic=false` and `Source='open-meteo'`. The page shows "Forecast: Open-Meteo" and the credit "Weather data by Open-Meteo.com (CC BY 4.0)". If the fetch times out (`WEATHER_TIMEOUT_MS`, default 8000) or fails, or if OpenEdge refuses the data, nothing changes: the stored forecast stays with its own label, and the farmer is told. Set `WEATHER_SOURCE=example` to never fetch (offline mode).

**Offline fallback: the example forecast.** `openedge/data/weather-seed.json` is a synthetic forecast (`source: "example"`, base date 2026-10-24). It is not from a weather service. The UI always shows the tag "Example forecast data".

## Data (schema `openedge/schema/006-weather.df`)
| Table | Purpose |
|---|---|
| `Farm.Province` | new field; it chooses which forecast applies |
| `ForecastDay` | province, base date, day 1–7, max/min °C, rain mm, IsSynthetic, Source |
| `AlertThreshold` | rain `>=` mm, heat `>=` °C (max), frost `<=` °C (min); level watch/warning/severe; active |
| `WeatherAlert` | one row per farm + type + forecast date (unique), status open / acknowledged / expired |

Seed: farm 1 is in KwaZulu-Natal. Farm 2, "Example farm without a forecast (EXAMPLE DATA)", is in Gauteng and has no forecast. Default levels: rain ≥ 10 mm (warning), rain ≥ 25 mm (severe), heat ≥ 33 °C (warning), frost ≤ 2 °C (warning).

## Rules (`openedge/src/weather.i`, mirrored in `mock-pasoe/weather.js`)
- Refresh checks each forecast day against each active level. If both a severe and a warning level match the same day, it uses the severe one. Messages look like "Heat Day 2, 33.0 C" and "Heavy rain Day 5, 11.0 mm".
- Refreshing twice never makes duplicates. An open alert that the forecast no longer supports is marked **expired**, and it is reopened if the forecast supports it again. Acknowledged alerts are left as they are.
- If a province has no forecast, the API returns `noData: true` and zero alerts. Nothing is guessed.
- Alert levels: rain must be above 0 and at most 500 mm, heat between 0 and 60 °C, and frost between -20 and 20 °C, with at most 1 decimal. An active frost level must be lower than every active heat level. The level must be watch, warning or severe; anything else is refused (`ALERT_THRESHOLD_INVALID` with `field`).
- Acknowledge works once: a second acknowledge returns `409 ALREADY_DECIDED` and an unknown id returns `404 ALERT_NOT_FOUND`.

## Endpoints
| API (`/api/v1`) | OpenEdge (`/web/farm`) |
|---|---|
| GET `/farms/:id` | GET `/farms/{id}` |
| GET `/forecast?province=` | GET `/forecast?province=` |
| GET `/farms/:id/alerts?status=` | GET `/alerts?farmId=&status=` |
| POST `/farms/:id/alerts/refresh` | POST `/alerts/refresh` |
| POST `/alerts/:id/acknowledge` | POST `/alerts/{id}/ack` |
| GET / POST `/alert-thresholds[/:id]` | GET / POST `/alert-thresholds[/{id}]` |
| POST `/forecast/refresh {province}` (fetches Open-Meteo) | POST `/forecast/import` |

## Screen
The `#/weather` page shows a header photo, 7 day cards (days with alerts are highlighted), the alert list with Acknowledge buttons, and the editable alert levels. Every new string is in `i18n.js`, so the 11-language AI translation covers it. OpenEdge message text goes through `tx()`.

## Tests
- WX29–WX38: forecast import (valid data, replacing rows, 6 days, min above max, source `example`, a date that doesn't exist, unknown province, negative rain). `eval/weather.test.mjs` uses a mocked fetch to cover the Open-Meteo URL, parsing, timeouts, HTTP errors and bad JSON, the API refresh, and `WEATHER_SOURCE=example`. The tests make no network calls.
- Contract cases WX01–WX28 (`eval/oe-contract-cases.json`) run against mock-pasoe (`npm test`) and the real ABL (`oe-run.ps1 -Action scratch-test`). They cover refresh, no duplicates, raising and restoring a level, noData, invalid levels, the frost edge (12.0 triggers and 11.9 does not), and acknowledging twice.
- `eval/weather.test.mjs` (suite 12) covers the seed labelling, severe-over-warning, inactive levels, the API routes and the UI proxy.

## Loading into an existing (live) database
The schema change needs the database stopped. **Do not do this without the owner's OK:**
`oe-run.ps1 -Action stop-db` → `-Action load-weather` → `-Action start-db` → `-Action seed` (this reseeds all example data, including the weather file) → restart PASOE.
Until 006 is loaded, `farm-api.p` (which includes `weather.i`) and `seed.p` do not compile against that database.
