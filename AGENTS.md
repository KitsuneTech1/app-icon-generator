# App Icon Generator — Agent Guide

A local Node/Express service that turns a text prompt into a batch of **rendered
app-icon concept images** (via an OpenRouter image model), lets you pick favorites,
and exports **Android / iOS / web** icon packs (PNG zips). Everything is saved to
the Kitsune company drive.

## Start it

```bash
cd app-icon-generator
npm install        # first run only
npm start          # => http://127.0.0.1:8792
```

- Port: `8792` (override with `PORT`). Binds to `127.0.0.1` only.
- UI: open http://127.0.0.1:8792 in a browser (prompt → enhance → generate
  concepts → tick favorites → make icons → download). The browser polls progress
  every 250ms and shows concepts/packs as they finish.

## Where output is saved

Every run is written to `./output/<runId>/` by default. Set `ICON_OUTPUT_DIR`
to use another local folder or a writable network share. Layout per run:

```
<runId>/
  run.json                      # the request (prompt, style, count, …)
  concepts/concept-01.svg …     # every generated concept
  finals/<name>-NN-icons.zip …  # icon packs for finalized concepts
```

`runId` looks like `2026-06-11T18-35-34-ufeh`. Files are also served over HTTP at
`/runs/<runId>/...` (e.g. download a pack at `/runs/<runId>/finals/<file>.zip`).

## Dependencies

- **Node 18+** (uses global `fetch`/`AbortController`).
- **Models** (both OpenAI-compatible, providers read from `~/.kimi/config.toml`):
  - **Icon concepts** — an OpenRouter **image** model (default
    `sourceful/riverflow-v2.5-fast`, `[providers.openrouter]`), called with
    `modalities:["image"]`. Returns a data-URI image (usually WebP); the server
    decodes it and normalizes to **PNG** via sharp. Override with
    `ICON_GEN_MODEL` / `ICON_GEN_PROVIDER`. ⚠️ image gen costs real credit
    (~$0.02/image, so a 25-concept run ≈ $0.5).
  - **Prompt enhance** — a fast text model (default `DeepSeek-V4-Flash` on
    `[providers.azure-foundry]`). Override with `ICON_ENHANCE_MODEL` /
    `ICON_ENHANCE_PROVIDER`.
  - Each call is capped by `ICON_MODEL_TIMEOUT_MS` (default 120s); a timed-out or
    failed concept is marked failed and the batch still completes.
- `sharp` (decode + raster resizing), `archiver` (zips). `ICON_CONCURRENCY`
  (default 5) caps parallel image calls.
- Concepts are saved as **PNG** (`concepts/concept-NN.png`); the finalize step
  feeds them straight into the resize/pack pipeline.

## HTTP API

### One-shot (best for agents)

`POST /api/generate` — prompt → concepts → final packs, all saved. Blocks until done.

```bash
curl -s -X POST http://127.0.0.1:8792/api/generate \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "music fox app icon, headphones, sound waves",
    "negativePrompt": "text, watermark, blurry",
    "enhance": true,          // expand the prompt with Kimi first (optional)
    "count": 25,              // concepts to generate (1-25, default 25)
    "select": "all",          // "all" | [1,4,9] (ids) | 5 (top N)
    "name": "music-fox",
    "preset": "all",          // all | android | ios | web
    "background": "#121212",
    "padding": 8,
    "rounded": false
  }'
# -> { runId, prompt, savedTo, concepts:[{id,url}|{id,error}], finals:[{conceptId,zip,savedTo}] }
```

Download a resulting pack: `GET /runs/<runId>/finals/<name>-NN-icons.zip`.

### Interactive / live-progress (what the UI uses)

| Endpoint | Purpose |
|----------|---------|
| `GET /config` | `{ outputDir, maxConcepts }` |
| `POST /enhance` `{prompt}` | → `{enhanced}` — massively expanded prompt |
| `POST /concepts/start` `{prompt,negativePrompt,style,background,count}` | → `{jobId,runId,total}`; generates in background |
| `POST /finalize/start` `{runId,conceptIds:[],name,preset,background,padding,rounded}` | → `{jobId,total}`; empty `conceptIds` = all concepts |
| `GET /progress/:jobId` | poll (~250ms): `{completed,total,failed,done,cancelled,elapsedMs,statusLine,items[]}` |
| `POST /cancel/:jobId` | cancel a running concepts/finalize job — aborts in-flight model calls; kept concepts stay |

`items[]` for a concepts job: `{id,url}` (or `{id,error}`); for a finalize job:
`{id,zip}` (or `{id,error}`). Poll until `done:true`.

### Back-compat (single-shot, synchronous)

- `POST /generate-svg` `{prompt,style,negativePrompt,background}` → `{svg}`
- `POST /generate` (multipart, field `source`=image) → streams an icon-pack zip
- `POST /concepts` / `POST /finalize` — synchronous versions of the start endpoints
  (return the full result; no live progress)

## Notes for agents

- Generating 25 concepts = 25 image-model calls (concurrency-capped) = real
  OpenRouter credit. Expect a minute or two. A long run can be stopped with
  `POST /cancel/:jobId` (the UI's Cancel button).
- Concepts are **raster PNGs** rendered by the image model, normalized via sharp.
- To install a pack into a Flutter app: unzip and copy `android/mipmap-*` into
  `android/app/src/main/res/`, `ios/AppIcon.appiconset` into
  `Runner/Assets.xcassets/`, and use `web/` for favicons/PWA icons.
