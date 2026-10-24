# Dynamic AI translation (11 official languages)

The app can show its screens in any of South Africa's 11 official languages:
English (`en`), isiZulu (`zu`), isiXhosa (`xh`), Afrikaans (`af`), Sepedi (`nso`), Sesotho (`st`), Setswana (`tn`),
siSwati (`ss`), Tshivenda (`ve`), Xitsonga (`ts`) and isiNdebele (`nr`).

## How language selection works
1. **Picker.** The old EN/ZU toggle is now one flat `<select>` (top bar, phone header and Settings) listing all 11 languages,
   each written in its own language. The choice is saved in `localStorage` (`mf.lang`). With no saved choice the app opens in
   **English** (there is deliberately no device-language detection). A manual pick always overrides and is saved.
2. **Fixed screen text.** `t(key)` uses the hand-written isiZulu tables (`zu`, `zuMarket`) first. Any string without a
   hand-written line in the selected language is shown in English and queued.
3. **User-typed content.** Market day names, notes, item labels and crop names on market cards and the detail page go
   through `tx(text)`, the same queue.
4. **Request.** After each render the queued English strings are sent in batches (max 60) to `POST /api/v1/translate`
   (`/ui/api/v1/translate` through the local proxy, or with the app bearer token), and the page redraws once with the answers.
   Answers are cached in `localStorage` (`mf.ai-tr.v1`) so a string is requested once per browser.
5. **Note.** When anything on a screen is AI text, a small grey "Translated by AI" line appears above the page with
   a "Show original" switch that shows the English source (and back).

## API
`POST /api/v1/translate` — `{ "texts": ["Market day", ...], "target": "xh" }`
- `target` must be one of the 11 codes, otherwise `400 VALIDATION_ERROR` (`field: "target"`).
- `texts`: 1–60 strings, each at most 500 characters, otherwise `400` (`field: "texts"`).
- `en` is a passthrough: no AI call.
- Reply: `{ target, provider, fallback, translations: [{ text, translated, source }] }` where `source` is `ai`, `cache`,
  `passthrough`, `empty` or `fallback`.
- Server cache: per (target, SHA-256 of the text), in memory, max 5000 entries.
- **Fallback.** If the AI times out, fails or returns a bad shape, the English text comes back with `translated: false`
  and HTTP 200, so the page never breaks. Failed strings are not retried in the same browser session.
- **Protected tokens.** The prompt tells the model to keep numbers, prices (`R18.50`), units (kg, L, %), dates, names and
  `{placeholders}` unchanged; output that changes any number, price or placeholder is rejected (English is used instead).
- Uses the existing provider (`apps/api/src/ai/provider.js`): `AI_PROVIDER=http` sends a JSON chat-completions request;
  `AI_PROVIDER=mock` (tests, offline) returns `[code] <English text>` so you can see what would be translated.

## Quality caveats
- AI translation into South African languages is uneven: usually understandable for short sentences, but it can sound
  unnatural, mix in English, or pick the wrong farming term. Smaller languages (siSwati, Tshivenda, isiNdebele,
  Xitsonga) tend to be weaker than isiZulu, isiXhosa or Afrikaans.
- **Native-speaker review is still recommended** for all fixed screen text before real farmers use it. The reviewed path is:
  translate once, have a speaker check it, and add it as a hand-written table (like `zu` / `zuMarket`), which always wins.
- AI advice text (`/plots/:id/advise`) is still English or isiZulu only; other languages get English advice.
- With the mock provider, screenshots show `[xh] ...` mock output, not real isiXhosa.
