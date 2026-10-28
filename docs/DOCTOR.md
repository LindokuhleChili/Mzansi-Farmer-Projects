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

## Similar past cases

After a diagnosis is stored, the API looks for older ones and adds `similarCases` to the response. The page shows lines such as `Early blight, KwaZulu-Natal, 3 days ago`. The place is the **province** on that diagnosis.

What is compared:

| Situation | What is compared | `similarMethod` |
|---|---|---|
| `AI_PROVIDER=http`, `SIMILAR_CASES` on (the default), and both calls succeed | A short **written description** of the photos, embedded as text. Cosine similarity of those vectors. | `description_embedding` (`similarCompared`: `visual_description_text`) |
| No API key, mock AI, embedding call failed, or no stored vector is close enough | Same crop, then overlapping words in the condition name | `crop_condition` |
| `SIMILAR_CASES=off` | Nothing. The diagnosis is unchanged. | `disabled` |

This is **not** an image embedding. Gemini's OpenAI-compatible embeddings endpoint takes text (`input` is a string). The chat model (`AI_MODEL`, left as `gemini-3.5-flash-lite`) writes the description. A different model, `AI_EMBED_MODEL` (default `gemini-embedding-001`), embeds that text. `AI_EMBED_DIM` (default 256, max 256) keeps the JSON array inside an OpenEdge character field. If the endpoint returns a longer vector, only the first 256 numbers are stored (the model is trained so a prefix is still a usable embedding).

The vector is stored on the Diagnosis row by schema `009-similar.df` (`VisualText`, `EmbedModel`, `EmbedDim`, `EmbedVector`). Photos are still not stored. A description that fails `DOSE_BLOCKED` is dropped and the diagnosis itself is kept. `GET /farm/doctor/similar-candidates` returns the vectors. Ranking runs in the Node API. The assistant tool `find_similar_cases` uses the same ranking.

Load the schema on a database that already has `008-assistant.df` **before** restarting PASOE with this code: `.\scripts\oe-run.ps1 -Action load-similar` (database server stopped).

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

The header photo `plant-doctor-tomato-fruit.jpg` (early blight fruit rot on tomato fruit, per the Wikimedia caption) is "Alternaria solani on Solanum lycopersicum" by **Michal Maňas**, from Wikimedia Commons, under **CC BY 4.0**: https://commons.wikimedia.org/wiki/File:Alternaria_solani_on_Solanum_lycopersicum.jpg (resized). The same photo was used for the one real Gemini check.

## Not medical/agronomic certainty

This is a suggestion from photos, not a lab test. The page says so and points the farmer to their extension officer.

## Real check (2026-10-24, gemini-3.5-flash-lite, mock OpenEdge)

One real call with this photo answered "Anthracnose fruit rot (likely)" with **high** confidence, and gave 4 steps with no chemicals. The Wikimedia caption says *Alternaria solani* (early blight), so the AI named a different disease while sounding sure of itself. That is one reason the page shows the answer as a suggestion and sends the farmer to an extension officer. The check request wrongly sent `plantPart: "leaf"` for this fruit photo; the photo shows **fruit**.
