# Plant doctor

The farmer takes 1 to 3 photos of a sick plant and picks the crop, plant part, growth stage and province. The AI suggests what it might be and what to do. The farmer decides whether to keep it.

**AI proposes, OpenEdge validates, the farmer approves.**

## Flow (`POST /api/v1/doctor/diagnoses`)

1. **API checks the input.** It needs 1 to 3 photos, each JPEG, PNG or WebP. The file's first bytes must match its type. Each photo can be at most 3 MB, and the whole request at most 12 MB. Errors: 400 `VALIDATION_ERROR`, 413 `PHOTO_TOO_LARGE`, 415 `PHOTO_TYPE_NOT_ALLOWED`. The page shrinks photos to 1280 px before it sends them.
2. **The AI answers in strict JSON.** It uses the same provider config as the rest of the app (`AI_PROVIDER`, `AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY`), sending photos as OpenAI-style `image_url` data URIs. The answer holds a condition, a confidence, observations, 3 to 5 steps (each with a cost of free, low, medium or high), things to watch, the risk to neighbours, and when to call an expert. The timeout is `AI_DOCTOR_TIMEOUT_MS` (default 30 s).
3. **Guardrail layer 1: the prompt.** It tells the AI never to give chemical names with doses.
4. **Guardrail layer 2: the API server check.** Any step with a quantity (ml, g, %, per litre, tablespoons and so on) is removed, and the remaining steps are sorted cheapest first. If fewer than 3 steps are left, or the JSON is bad, the safe fallback answer is used.
5. **Guardrail layer 3: OpenEdge `DOSE_BLOCKED`.** This is the final say. `doctor.i` blocks any sentence that has a dose word *and* a chemical word, using whole words only, so "small" does not match "ml". Both word lists live in the **BlockedTerm** table, and an admin can change them from the page or with `POST /api/v1/doctor/blocked-terms`. A blocked answer returns 422 and is never stored. The API then stores the safe fallback and audits `doctor_dose_blocked`.
6. **The farmer approves.** The diagnosis is stored as `pending_review`, then the farmer chooses Save (`saved`) or Dismiss (`dismissed`). Deciding twice returns 409 `ALREADY_DECIDED`. Every step is written to the hash-chained audit.

**Safe fallback.** The AI failing never shows the farmer an error page. They get general steps that name no chemicals (remove affected leaves, water at the base, give plants space, photograph again), plus advice on when to call the extension officer. The answer is labelled as the fallback, with the reason.

**Privacy.** Photos go only to the AI provider. They are never sent to OpenEdge, stored, or logged; the logs keep only the photo count and byte sizes.

## OpenEdge

- Schema `openedge/schema/007-doctor.df`: tables BlockedTerm and Diagnosis.
- Seed `openedge/data/doctor-seed.json`: 18 dose words and 14 chemical words.
- Routes under `/farm/doctor/*` in `doctor.i`.
- Loading it: `oe-run.ps1 load-doctor`, then seed and restart PASOE.
- `mock-pasoe/doctor.js` is the JS twin. Contract cases DR01 to DR31 run against both.

## Tests

- Node suite 13 is `eval/doctor.test.mjs`.
- Mock behaviours (`AI_MOCK_BEHAVIOUR`): `dose`, `dose-all`, `dose-hidden`, `injection`, `timeout`, `bad-json`.

## Photo credit

The header photo `plant-doctor-tomato-leaf.jpg` (early blight on tomato) is "Alternaria solani on Solanum lycopersicum" by **Michal Maňas**, from Wikimedia Commons, under **CC BY 4.0**: https://commons.wikimedia.org/wiki/File:Alternaria_solani_on_Solanum_lycopersicum.jpg (resized). The same photo was used for the one real Gemini check.

## Not medical/agronomic certainty

This is a suggestion from photos, not a lab test. The page says so and points the farmer to their extension officer.
