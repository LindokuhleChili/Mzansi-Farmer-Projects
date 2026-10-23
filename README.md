# Mzansi Farmer Ops

AI proposes, OpenEdge rules validate, the farmer approves. An ESP32 soil sensor feeds a Node API; an AI model suggests an irrigation action; ABL rules in OpenEdge 12.8 decide whether it is allowed; the farmer confirms in two steps. Numbers and records come from OpenEdge, never from the model. All data is fictional example data.

## Quick start (any OS, Node 20+)

```bash
npm install
npm run setup     # creates .env with random tokens (never committed)
npm test          # offline: mock OpenEdge + mock AI, 146 checks
npm start         # API on http://localhost:3000
npm run demo      # in another terminal: full loop, reading -> AI -> rules -> approval -> audit
```

Real OpenEdge (Windows), real Gemini, the ESP32 firmware and the simulator are described in `docs/NOTES.md`.

| Doc | What |
|---|---|
| `docs/NOTES.md` | stack, rules and thresholds, env vars, how to run, real vs mocked, limitations |
| `docs/API.md` | HTTP API |
| `docs/OE-CONTRACT.md` | API to OpenEdge contract |
| `docs/ESP32.md` | firmware and simulator |
| `docs/screens/` | demo screens and credits |
