import express from "express";
import multer from "multer";
import sharp from "sharp";
import archiver from "archiver";
import { lookup as dnsLookup } from "node:dns/promises";
import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const PORT = Number(process.env.PORT || 8792);
const kimiConfigPath = path.join(os.homedir(), ".kimi", "config.toml");

// How many concepts to ask the image model for at once. Each is one API call.
const CONCURRENCY = positiveInteger(process.env.ICON_CONCURRENCY, 5);
const MAX_CONCEPTS = 25;
// Default batch size when the caller doesn't specify one. Kept low because each
// concept is a paid image-gen call (~$0.026); the UI slider still goes to 25.
const DEFAULT_CONCEPTS = Math.min(
  MAX_CONCEPTS,
  positiveInteger(process.env.ICON_DEFAULT_CONCEPTS, 4),
);

// Models / providers. Prompt enhancement uses a fast text model; icon concepts
// use an image-generation model. Both go through providers in ~/.kimi/config.toml.
const ENHANCE_PROVIDER = process.env.ICON_ENHANCE_PROVIDER || "azure-foundry";
const ENHANCE_MODEL = process.env.ICON_ENHANCE_MODEL || "DeepSeek-V4-Flash";
const ICON_PROVIDER = process.env.ICON_GEN_PROVIDER || "openrouter";
const ICON_MODEL = process.env.ICON_GEN_MODEL || "sourceful/riverflow-v2.5-fast";

// Where every run (concepts + final icon packs) is saved. Defaults to ./output
// and can be moved with ICON_OUTPUT_DIR.
const OUTPUT_DIR = resolveOutputDir();
const MAX_PROMPT_LENGTH = 4000;
const MAX_NEGATIVE_LENGTH = 2000;
const MAX_STYLE_LENGTH = 500;
const MAX_NAME_LENGTH = 80;
const MAX_RUN_ID_LENGTH = 80;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_INPUT_PIXELS = 16_777_216;
const MAX_REMOTE_REDIRECTS = 3;

const androidIcons = [
  ["android/mipmap-mdpi/ic_launcher.png", 48],
  ["android/mipmap-hdpi/ic_launcher.png", 72],
  ["android/mipmap-xhdpi/ic_launcher.png", 96],
  ["android/mipmap-xxhdpi/ic_launcher.png", 144],
  ["android/mipmap-xxxhdpi/ic_launcher.png", 192],
  ["android/play-store/icon-512.png", 512],
];

const iosIcons = [
  ["ios/AppIcon.appiconset/Icon-20@2x.png", 40],
  ["ios/AppIcon.appiconset/Icon-20@3x.png", 60],
  ["ios/AppIcon.appiconset/Icon-29@2x.png", 58],
  ["ios/AppIcon.appiconset/Icon-29@3x.png", 87],
  ["ios/AppIcon.appiconset/Icon-40@2x.png", 80],
  ["ios/AppIcon.appiconset/Icon-40@3x.png", 120],
  ["ios/AppIcon.appiconset/Icon-60@2x.png", 120],
  ["ios/AppIcon.appiconset/Icon-60@3x.png", 180],
  ["ios/AppIcon.appiconset/Icon-76@1x.png", 76],
  ["ios/AppIcon.appiconset/Icon-76@2x.png", 152],
  ["ios/AppIcon.appiconset/Icon-83.5@2x.png", 167],
  ["ios/AppIcon.appiconset/Icon-1024.png", 1024],
];

const webIcons = [
  ["web/favicon-16.png", 16],
  ["web/favicon-32.png", 32],
  ["web/apple-touch-icon.png", 180],
  ["web/icon-192.png", 192],
  ["web/icon-512.png", 512],
];

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));
// Serve saved runs so the browser can preview concepts and download packs.
app.use("/runs", express.static(OUTPUT_DIR));

app.get("/config", (_req, res) => {
  res.json(getPublicConfig());
});

// ── Live jobs (polled every ~250ms by the UI) ────────────────────────────────
const jobs = new Map();

function makeJob(id, kind, total, extra = {}) {
  const job = {
    id,
    kind,
    total,
    completed: 0,
    failed: 0,
    done: false,
    cancelled: false,
    error: null,
    started: Date.now(),
    statusLine: "Starting…",
    items: [],
    // Aborts in-flight model calls when the job is cancelled.
    abort: new AbortController(),
    ...extra,
  };
  jobs.set(id, job);
  return job;
}

app.get("/progress/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: "unknown job" });
    return;
  }
  res.json({
    id: job.id,
    kind: job.kind,
    total: job.total,
    completed: job.completed,
    failed: job.failed,
    done: job.done,
    cancelled: job.cancelled,
    error: job.error,
    elapsedMs: Date.now() - job.started,
    statusLine: job.statusLine,
    runId: job.runId,
    items: [...job.items].sort((a, b) => a.id - b.id),
  });
});

// Cancel a running job: abort in-flight model calls and stop scheduling more.
app.post("/cancel/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: "unknown job" });
    return;
  }
  if (!job.done) {
    job.cancelled = true;
    job.abort.abort();
    job.statusLine = "Cancelling…";
  }
  res.json({ ok: true, cancelled: true });
});

// Start a concept batch; returns a jobId immediately, generates in the
// background, and updates the job as each concept lands.
app.post("/concepts/start", (req, res, next) => {
  try {
    const opts = readConceptOptions(req.body);
    if (!opts.prompt) {
      res.status(400).json({ error: "Type a prompt first." });
      return;
    }
    const runId = newRunId();
    const conceptsDir = path.join(OUTPUT_DIR, runId, "concepts");
    fs.mkdirSync(conceptsDir, { recursive: true });
    const job = makeJob(runId, "concepts", opts.count, {
      runId,
      savedTo: path.join(OUTPUT_DIR, runId),
    });
    runConceptsJob(job, opts, conceptsDir).catch((err) => {
      job.error = publicErrorMessage(err);
      job.done = true;
    });
    res.json({ jobId: runId, runId, total: opts.count });
  } catch (err) {
    next(err);
  }
});

async function runConceptsJob(job, opts, conceptsDir) {
  let active = 0;
  await mapWithConcurrency(Array.from({ length: opts.count }), CONCURRENCY, async (_u, idx) => {
    if (job.cancelled) return;
    active++;
    job.statusLine = `Rendering ${active} icon${active === 1 ? "" : "s"} in parallel… ${job.completed}/${job.total} done`;
    try {
      const png = await buildConceptImage(opts.prompt, opts.negative, opts.style, opts.background, idx, job.abort.signal);
      const file = `concept-${String(idx + 1).padStart(2, "0")}.png`;
      fs.writeFileSync(path.join(conceptsDir, file), png);
      job.items.push({ id: idx + 1, url: `/runs/${job.runId}/concepts/${file}` });
    } catch (err) {
      if (job.cancelled) return;
      job.failed++;
      job.items.push({ id: idx + 1, error: publicErrorMessage(err) });
    } finally {
      active--;
      if (!job.cancelled) {
        job.completed++;
        job.statusLine = `Rendered ${job.completed}/${job.total}${job.failed ? ` (${job.failed} failed)` : ""}…`;
      }
    }
  });
  fs.writeFileSync(
    path.join(OUTPUT_DIR, job.runId, "run.json"),
    JSON.stringify({ runId: job.runId, ...opts, model: ICON_MODEL, created: new Date().toISOString() }, null, 2),
  );
  const ready = job.items.filter((i) => i.url).length;
  job.statusLine = job.cancelled
    ? `Cancelled - ${ready} concept${ready === 1 ? "" : "s"} kept`
    : `Done - ${ready} concept${ready === 1 ? "" : "s"} ready`;
  job.done = true;
}

// Start finalizing selected concepts into icon packs; polled like concepts.
app.post("/finalize/start", (req, res, next) => {
  try {
    const body = objectBody(req.body);
    const runId = safeRunId(body.runId);
    const conceptsDir = path.join(OUTPUT_DIR, runId, "concepts");
    if (!runId || !fs.existsSync(conceptsDir)) {
      res.status(400).json({ error: "Unknown runId - generate concepts first." });
      return;
    }
    if (body.conceptIds !== undefined && !Array.isArray(body.conceptIds)) {
      res.status(400).json({ error: "conceptIds must be an array." });
      return;
    }
    const available = fs.readdirSync(conceptsDir).filter((f) => f.endsWith(".png")).sort();
    let ids = normalizeConceptIds(body.conceptIds);
    if (!Array.isArray(body.conceptIds) || body.conceptIds.length === 0) {
      ids = conceptIdsFromFiles(available);
    }

    const jobId = `final-${newRunId()}`;
    const job = makeJob(jobId, "finalize", ids.length, {
      runId,
      savedTo: path.join(OUTPUT_DIR, runId, "finals"),
    });
    runFinalizeJob(job, runId, ids, body).catch((err) => {
      job.error = publicErrorMessage(err);
      job.done = true;
    });
    res.json({ jobId, total: ids.length });
  } catch (err) {
    next(err);
  }
});

async function runFinalizeJob(job, runId, ids, body) {
  const runDir = path.join(OUTPUT_DIR, runId);
  const conceptsDir = path.join(runDir, "concepts");
  const finalsDir = path.join(runDir, "finals");
  fs.mkdirSync(finalsDir, { recursive: true });

  const name = safeName(body.name || "app-icon");
  const padding = clampNumber(body.padding, 0, 30, 8);
  const background = sanitizeColor(body.background || "#111827");
  const rounded = body.rounded === true || body.rounded === "true";
  const preset = normalizePreset(body.preset);

  for (const id of ids) {
    if (job.cancelled) break;
    job.statusLine = `Rendering icon pack #${id}… ${job.completed}/${job.total}`;
    const file = `concept-${String(id).padStart(2, "0")}.png`;
    const imgPath = path.join(conceptsDir, file);
    if (!fs.existsSync(imgPath)) {
      job.completed++;
      continue;
    }
    try {
      const zipName = `${name}-${String(id).padStart(2, "0")}-icons.zip`;
      const zipPath = path.join(finalsDir, zipName);
      await writeIconZip(fs.readFileSync(imgPath), { padding, background, rounded, preset, name }, zipPath);
      job.items.push({ id, zip: `/runs/${runId}/finals/${zipName}` });
    } catch (err) {
      job.failed++;
      job.items.push({ id, error: publicErrorMessage(err) });
    } finally {
      job.completed++;
    }
  }
  const made = job.items.filter((i) => i.zip).length;
  job.statusLine = job.cancelled
    ? `Cancelled - ${made} pack${made === 1 ? "" : "s"} saved`
    : `Done - ${made} pack${made === 1 ? "" : "s"} saved`;
  job.done = true;
}

// ── Prompt enhancement ───────────────────────────────────────────────────────
app.post("/enhance", async (req, res, next) => {
  try {
    const prompt = readText(objectBody(req.body).prompt, MAX_PROMPT_LENGTH, "Prompt");
    if (!prompt) {
      res.status(400).json({ error: "Type an icon prompt first." });
      return;
    }
    const enhanced = await enhancePrompt(prompt);
    res.json({ enhanced });
  } catch (err) {
    next(err);
  }
});

// ── Generate N concept images from a prompt ──────────────────────────────────
app.post("/concepts", async (req, res, next) => {
  try {
    const opts = readConceptOptions(req.body);
    if (!opts.prompt) {
      res.status(400).json({ error: "Type a prompt first." });
      return;
    }
    const result = await runConcepts(opts);
    res.json(publicConceptResult(result));
  } catch (err) {
    next(err);
  }
});

// ── Turn selected concepts into final platform icon packs ────────────────────
app.post("/finalize", async (req, res, next) => {
  try {
    const result = await runFinalize(req.body);
    res.json(publicFinalizeResult(result));
  } catch (err) {
    next(err);
  }
});

// ── One-shot agent API: prompt -> concepts -> finals, all saved to the drive ──
app.post("/api/generate", async (req, res, next) => {
  try {
    const body = objectBody(req.body);
    let prompt = readText(body.prompt, MAX_PROMPT_LENGTH, "Prompt");
    if (!prompt) {
      res.status(400).json({ error: "prompt is required" });
      return;
    }
    if (body.enhance === true || body.enhance === "true") {
      prompt = await enhancePrompt(prompt);
    }

    const conceptResult = await runConcepts(readConceptOptions({ ...body, prompt }));

    // select: "all" (default), an array of concept ids, or a number = take top N.
    let conceptIds = [];
    const select = body.select;
    if (Array.isArray(select)) conceptIds = select.map(Number).filter(Boolean);
    else if (typeof select === "number" || /^\d+$/.test(String(select || ""))) {
      const topN = Math.max(0, Math.floor(Number(select)));
      conceptIds = conceptResult.concepts
        .filter((c) => !c.error)
        .slice(0, topN)
        .map((c) => c.id);
      if (topN === 0) conceptIds = [0];
    } // else "all" -> empty -> runFinalize uses every concept

    const finalResult = await runFinalize({
      runId: conceptResult.runId,
      conceptIds,
      name: body.name,
      padding: body.padding,
      background: conceptResult.background,
      rounded: body.rounded,
      preset: body.preset,
    });

    res.json({
      runId: conceptResult.runId,
      prompt,
      concepts: conceptResult.concepts,
      finals: finalResult.finals.map(({ savedTo, ...item }) => item),
    });
  } catch (err) {
    next(err);
  }
});

// ── Back-compat: upload one image -> zip of all sizes ────────────────────────
app.post("/generate", upload.single("source"), async (req, res, next) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: "Upload an image first." });
      return;
    }
    const padding = clampNumber(req.body.padding, 0, 30, 8);
    const background = sanitizeColor(req.body.background || "#111827");
    const rounded = req.body.rounded === "true";
    const preset = normalizePreset(req.body.preset);
    const baseName = safeName(req.body.name || "app-icon");

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${baseName}-icons.zip"`);
    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err) => next(err));
    archive.pipe(res);
    await appendIconPack(archive, req.file.buffer, { padding, background, rounded, preset, name: baseName });
    await archive.finalize();
  } catch (err) {
    next(err);
  }
});

app.use((err, req, res, _next) => {
  console.error("[icon-generator] request failed", err?.name || "Error");
  if (!res.headersSent) {
    const status = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
    res.status(status).json({ error: publicErrorMessage(err) });
  }
});

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  app.listen(PORT, "127.0.0.1", () => {
    console.log(`App Icon Generator running at http://127.0.0.1:${PORT}`);
    console.log(`Concepts: ${ICON_MODEL} (${ICON_PROVIDER}) · Enhance: ${ENHANCE_MODEL} (${ENHANCE_PROVIDER})`);
    console.log("Saving runs to the configured output directory.");
  });
}

// ── Core pipeline ────────────────────────────────────────────────────────────

function readConceptOptions(body) {
  body = objectBody(body);
  return {
    prompt: readText(body.prompt, MAX_PROMPT_LENGTH, "Prompt"),
    negative: readText(body.negativePrompt, MAX_NEGATIVE_LENGTH, "Negative prompt"),
    style: readText(body.style || "clean vector app icon", MAX_STYLE_LENGTH, "Style"),
    background: sanitizeColor(body.background || "#111827"),
    count: Math.floor(clampNumber(body.count, 1, MAX_CONCEPTS, DEFAULT_CONCEPTS)),
  };
}

async function runConcepts(opts) {
  const runId = newRunId();
  const conceptsDir = path.join(OUTPUT_DIR, runId, "concepts");
  fs.mkdirSync(conceptsDir, { recursive: true });

  const results = await mapWithConcurrency(
    Array.from({ length: opts.count }),
    CONCURRENCY,
    async (_unused, idx) => {
      const png = await buildConceptImage(
        opts.prompt,
        opts.negative,
        opts.style,
        opts.background,
        idx,
      );
      const file = `concept-${String(idx + 1).padStart(2, "0")}.png`;
      fs.writeFileSync(path.join(conceptsDir, file), png);
      return { id: idx + 1, file };
    },
  );

  const concepts = results.map((r, idx) =>
    r.ok
      ? { ...r.value, url: `/runs/${runId}/concepts/${r.value.file}` }
      : { id: idx + 1, error: r.error },
  );

  fs.writeFileSync(
    path.join(OUTPUT_DIR, runId, "run.json"),
    JSON.stringify(
      { runId, ...opts, model: ICON_MODEL, created: new Date().toISOString() },
      null,
      2,
    ),
  );

  return {
    runId,
    count: opts.count,
    background: opts.background,
    savedTo: path.join(OUTPUT_DIR, runId),
    concepts,
  };
}

async function runFinalize(body) {
  body = objectBody(body);
  const runId = safeRunId(body.runId);
  const runDir = path.join(OUTPUT_DIR, runId);
  const conceptsDir = path.join(runDir, "concepts");
  if (!runId || !fs.existsSync(conceptsDir)) {
    const error = new Error("Unknown runId - generate concepts first.");
    error.statusCode = 400;
    throw error;
  }
  if (body.conceptIds !== undefined && !Array.isArray(body.conceptIds)) {
    const error = new Error("conceptIds must be an array.");
    error.statusCode = 400;
    throw error;
  }

  const name = safeName(body.name || "app-icon");
  const padding = clampNumber(body.padding, 0, 30, 8);
  const background = sanitizeColor(body.background || "#111827");
  const rounded = body.rounded === true || body.rounded === "true";
  const preset = normalizePreset(body.preset);

  const available = fs
    .readdirSync(conceptsDir)
    .filter((f) => f.endsWith(".png"))
    .sort();

  let ids = normalizeConceptIds(body.conceptIds);
  // No selection => finalize every concept.
  if (!Array.isArray(body.conceptIds) || body.conceptIds.length === 0) {
    ids = conceptIdsFromFiles(available);
  }

  const finalsDir = path.join(runDir, "finals");
  fs.mkdirSync(finalsDir, { recursive: true });

  const finals = [];
  for (const id of ids) {
    const file = `concept-${String(id).padStart(2, "0")}.png`;
    const imgPath = path.join(conceptsDir, file);
    if (!fs.existsSync(imgPath)) continue;
    const imgBuffer = fs.readFileSync(imgPath);
    const zipName = `${name}-${String(id).padStart(2, "0")}-icons.zip`;
    const zipPath = path.join(finalsDir, zipName);
    await writeIconZip(imgBuffer, { padding, background, rounded, preset, name }, zipPath);
    finals.push({
      conceptId: id,
      zip: `/runs/${runId}/finals/${zipName}`,
      savedTo: zipPath,
    });
  }

  return { runId, savedTo: finalsDir, finals };
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++;
      try {
        results[idx] = { ok: true, value: await fn(items[idx], idx) };
      } catch (err) {
        results[idx] = { ok: false, error: publicErrorMessage(err) };
      }
    }
  }
  const workerCount = Math.min(
    Math.max(1, Math.floor(Number(limit)) || 1),
    items.length,
  );
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

// ── Icon rendering / packaging ───────────────────────────────────────────────

async function appendIconPack(archive, sourceBuffer, opts) {
  const { padding, background, rounded, preset, name } = opts;
  const jobs = [];
  if (preset === "all" || preset === "android") jobs.push(...androidIcons);
  if (preset === "all" || preset === "ios") jobs.push(...iosIcons);
  if (preset === "all" || preset === "web") jobs.push(...webIcons);
  for (const [filePath, size] of jobs) {
    const png = await makeIcon(sourceBuffer, size, padding, background, rounded);
    archive.append(png, { name: filePath });
  }
  if (preset === "all" || preset === "ios") {
    archive.append(JSON.stringify(makeIosContents(), null, 2), {
      name: "ios/AppIcon.appiconset/Contents.json",
    });
  }
  archive.append(makeReadme(name, padding, background, rounded), { name: "README.txt" });
}

function writeIconZip(sourceBuffer, opts, destPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    let settled = false;
    const fail = async (err) => {
      if (settled) return;
      settled = true;
      output.destroy();
      try {
        await fs.promises.rm(destPath, { force: true });
      } catch {
        // Keep the original packaging error.
      }
      reject(err);
    };
    output.on("close", () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
    output.on("error", (err) => void fail(err));
    archive.on("error", (err) => void fail(err));
    archive.pipe(output);
    appendIconPack(archive, sourceBuffer, opts)
      .then(() => archive.finalize())
      .catch((err) => void fail(err));
  });
}

async function makeIcon(input, size, paddingPercent, background, rounded) {
  const innerSize = Math.max(1, Math.round(size * (1 - paddingPercent / 100)));
  const image = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .resize(innerSize, innerSize, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  let canvas = sharp({
    create: { width: size, height: size, channels: 4, background },
  }).composite([{ input: image, gravity: "center" }]);

  if (rounded) {
    const radius = Math.round(size * 0.22);
    const mask = Buffer.from(
      `<svg width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="#fff"/></svg>`,
    );
    canvas = canvas.composite([{ input: mask, blend: "dest-in" }]);
  }

  return canvas.png().toBuffer();
}

function makeIosContents() {
  const images = [
    ["iphone", "20x20", "2x", "Icon-20@2x.png"],
    ["iphone", "20x20", "3x", "Icon-20@3x.png"],
    ["iphone", "29x29", "2x", "Icon-29@2x.png"],
    ["iphone", "29x29", "3x", "Icon-29@3x.png"],
    ["iphone", "40x40", "2x", "Icon-40@2x.png"],
    ["iphone", "40x40", "3x", "Icon-40@3x.png"],
    ["iphone", "60x60", "2x", "Icon-60@2x.png"],
    ["iphone", "60x60", "3x", "Icon-60@3x.png"],
    ["ipad", "76x76", "1x", "Icon-76@1x.png"],
    ["ipad", "76x76", "2x", "Icon-76@2x.png"],
    ["ipad", "83.5x83.5", "2x", "Icon-83.5@2x.png"],
    ["ios-marketing", "1024x1024", "1x", "Icon-1024.png"],
  ];
  return {
    images: images.map(([idiom, size, scale, filename]) => ({ idiom, size, scale, filename })),
    info: { author: "xcode", version: 1 },
  };
}

function makeReadme(name, padding, background, rounded) {
  return [
    `${name} app icons`,
    "",
    `Padding: ${padding}%`,
    `Background: ${background}`,
    `Rounded mask baked in: ${rounded ? "yes" : "no"}`,
    "",
    "Android: copy android/mipmap-* folders into android/app/src/main/res/.",
    "iOS: copy ios/AppIcon.appiconset into Runner/Assets.xcassets/.",
    "Web: use the web folder for favicons and PWA icons.",
    "",
  ].join("\n");
}

// ── Models (OpenRouter image gen + Azure Foundry text) ───────────────────────

const MODEL_TIMEOUT_MS = positiveInteger(
  process.env.ICON_MODEL_TIMEOUT_MS || process.env.ICON_KIMI_TIMEOUT_MS,
  120000,
);

// One OpenAI-compatible chat call. Returns the response message object
// ({ content, images }). Honors an optional external [signal] for cancellation
// and always caps the call with a timeout so a hung request can't stall a batch.
async function callModel(provider, model, messages, { maxTokens, temperature, modalities, signal } = {}) {
  const { baseUrl, apiKey } = readProvider(provider);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    "api-key": apiKey,
  };
  if (provider === "openrouter") {
    headers["HTTP-Referer"] = `http://127.0.0.1:${PORT}`;
    headers["X-Title"] = "Kitsune App Icon Generator";
  }

  const body = { model, messages };
  if (typeof temperature === "number") body.temperature = temperature;
  if (maxTokens) body.max_tokens = maxTokens;
  if (modalities) body.modalities = modalities;

  let response;
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") {
      if (signal && signal.aborted) throw new Error("Cancelled");
      throw new Error(`${model} timed out after ${Math.round(MODEL_TIMEOUT_MS / 1000)}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }

  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`${model} request failed: ${response.status}`);
  }
  const data = await response.json();
  return data?.choices?.[0]?.message || {};
}

async function enhancePrompt(prompt) {
  const message = await callModel(
    ENHANCE_PROVIDER,
    ENHANCE_MODEL,
    [
      {
        role: "system",
        content:
          "You are an expert app-icon art director. Expand the user's short idea into ONE richly detailed, vivid app-icon image prompt. Name the main symbol, one supporting symbol, the color palette (include hex codes), the mood, the lighting, the composition, the visual style, and small-size readability needs. 120-200 words, a single flowing paragraph. Output ONLY the prompt text - no preamble, no headings, no lists, no markdown, no quotes.",
      },
      { role: "user", content: prompt },
    ],
    { maxTokens: 4000, temperature: 0.9 },
  );
  return (message.content || "").trim();
}

// Generate one icon concept as a PNG buffer via the image model. Normalizes
// whatever the model returns (often WebP) to PNG for the resize/pack pipeline.
async function buildConceptImage(prompt, negative, style, background, variationIndex, signal) {
  const composed = [
    `App icon design: ${prompt}.`,
    `Visual style: ${style}.`,
    `Background color ${background}.`,
    negative ? `Avoid: ${negative}.` : "",
    "Square 1:1 composition, a single centered subject, bold simple shapes, strong silhouette, high contrast, crisp and readable at small sizes, no text, no words, no watermark.",
    `Variation #${variationIndex + 1}: make the composition and palette accents clearly distinct from other variations of the same idea.`,
  ]
    .filter(Boolean)
    .join(" ");

  const message = await callModel(
    ICON_PROVIDER,
    ICON_MODEL,
    [{ role: "user", content: composed }],
    { modalities: ["image"], signal },
  );
  const raw = await imageBufferFromMessage(message, signal);
  return sharp(raw, { limitInputPixels: MAX_INPUT_PIXELS }).png().toBuffer();
}

// Pull the first image out of a chat message (data URI or hosted URL) -> Buffer.
async function imageBufferFromMessage(message, signal) {
  const img = message?.images?.[0];
  const url = img?.image_url?.url || img?.url;
  if (typeof url !== "string" || !url) throw new Error(`${ICON_MODEL} returned no image.`);
  if (url.startsWith("data:")) {
    const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(url);
    if (!match) throw new Error("Model returned an invalid image data URI.");
    if (match[2].length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 4) {
      throw new Error("Model returned an image that is too large.");
    }
    const buffer = Buffer.from(match[2], "base64");
    if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) {
      throw new Error("Model returned an image that is too large.");
    }
    return buffer;
  }
  if (/^https?:\/\//i.test(url)) {
    return fetchRemoteImage(url, signal);
  }
  throw new Error("Unrecognized image URL format from model.");
}

async function fetchRemoteImage(url, signal) {
  let current = url;
  const controller = signal ? null : new AbortController();
  const requestSignal = signal || controller.signal;
  const timer = controller ? setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS) : null;

  try {
    for (let redirect = 0; redirect <= MAX_REMOTE_REDIRECTS; redirect++) {
      const target = await assertPublicRemoteImageUrl(current);
      const response = await fetch(target.href, {
        redirect: "manual",
        signal: requestSignal,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location || redirect === MAX_REMOTE_REDIRECTS) {
          throw new Error("Image download used too many redirects.");
        }
        current = new URL(location, target).href;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Image download failed: ${response.status}`);
      }
      const contentType = response.headers.get("content-type");
      if (contentType && !/^image\//i.test(contentType)) {
        await response.body?.cancel();
        throw new Error("Image download returned a non-image response.");
      }
      return await readLimitedResponse(response, MAX_IMAGE_BYTES);
    }
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(signal?.aborted ? "Cancelled" : "Image download timed out.");
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
  throw new Error("Image download failed.");
}

async function readLimitedResponse(response, maxBytes) {
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error("Downloaded image is too large.");
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("Downloaded image is too large.");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function validateRemoteImageUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Unrecognized image URL format from model.");
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || isPrivateAddress(url.hostname)) {
    throw new Error("Image URL must point to a public HTTP(S) host.");
  }
  return url;
}

async function assertPublicRemoteImageUrl(value) {
  const url = validateRemoteImageUrl(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(hostname)) return url;
  let addresses;
  try {
    addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error("Image URL host could not be resolved.");
  }
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("Image URL must resolve to a public host.");
  }
  return url;
}

function readProvider(name) {
  const config = fs.readFileSync(kimiConfigPath, "utf8");
  const block = getTomlBlock(config, `providers.${name}`);
  const baseUrl = getTomlString(block, "base_url");
  let apiKey = getTomlString(block, "api_key");
  if (name === "azure-foundry") apiKey = process.env.AZURE_OPENAI_API_KEY || apiKey;
  if (name === "openrouter") apiKey = process.env.OPENROUTER_API_KEY || apiKey;
  if (!baseUrl || !apiKey) {
    throw new Error(`Missing [providers.${name}] base_url/api_key in ~/.kimi/config.toml (or its env key).`);
  }
  return { baseUrl, apiKey };
}

function getTomlBlock(config, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = config.match(new RegExp(`\\[${escaped}\\]([\\s\\S]*?)(?=\\n\\[|$)`));
  return match ? match[1] : "";
}

function getTomlString(block, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = block.match(new RegExp(`^\\s*${escaped}\\s*=\\s*"([^"]*)"`, "m"));
  return match ? match[1] : "";
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function resolveOutputDir() {
  const candidates = [
    process.env.ICON_OUTPUT_DIR,
    path.join(__dirname, "output"),
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch {
      // try the next candidate
    }
  }
  // Last resort: local output even if the check above hiccuped.
  const fallback = path.join(__dirname, "output");
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

function newRunId() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const rand = crypto.randomBytes(16).toString("hex");
  return `${ts}-${rand}`;
}

function safeRunId(value) {
  const v = String(value || "").trim();
  return v.length <= MAX_RUN_ID_LENGTH && v && v !== "." && v !== ".." && /^[A-Za-z0-9._-]+$/.test(v) ? v : "";
}

function normalizeConceptIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0 && n <= MAX_CONCEPTS))];
}

function conceptIdsFromFiles(files) {
  return files
    .map((file) => /^concept-(\d+)\.png$/.exec(file)?.[1])
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isSafeInteger(n) && n > 0 && n <= MAX_CONCEPTS)
    .sort((a, b) => a - b);
}

function normalizePreset(value) {
  return ["all", "android", "ios", "web"].includes(value) ? value : "all";
}

function positiveInteger(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function sanitizeColor(value) {
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value : "#111827";
}

function safeName(value) {
  const cleaned = String(value).trim().replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, MAX_NAME_LENGTH).replace(/^-+|-+$/g, "") || "app-icon";
}

function objectBody(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function readText(value, maxLength, label) {
  const text = String(value ?? "").trim();
  if (text.length > maxLength) {
    const error = new Error(`${label} is too long (maximum ${maxLength} characters).`);
    error.statusCode = 400;
    throw error;
  }
  return text;
}

function publicErrorMessage(error) {
  return error?.statusCode === 400 ? error.message : "Icon generation failed.";
}

function getPublicConfig() {
  return { maxConcepts: MAX_CONCEPTS };
}

function publicConceptResult(result) {
  const { savedTo, ...publicResult } = result;
  return publicResult;
}

function publicFinalizeResult(result) {
  const { savedTo, finals, ...publicResult } = result;
  return {
    ...publicResult,
    finals: finals.map(({ savedTo: _savedTo, ...item }) => item),
  };
}

function isPrivateAddress(value) {
  const host = String(value).replace(/^\[|\]$/g, "").toLowerCase();
  if (net.isIP(host) === 4) {
    const octets = host.split(".").map(Number);
    const [a, b] = octets;
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (net.isIP(host) === 6) {
    return host === "::" || host === "::1" || host.startsWith("fc") || host.startsWith("fd") ||
      host.startsWith("fe80") || host.startsWith("ff") || host.startsWith("::ffff:127.") ||
      host.startsWith("::ffff:10.") || host.startsWith("::ffff:192.168.") || host.startsWith("::ffff:172.");
  }
  return host === "localhost" || host.endsWith(".localhost") || host === "metadata.google.internal";
}

export {
  app,
  appendIconPack,
  conceptIdsFromFiles,
  makeIcon,
  makeIosContents,
  mapWithConcurrency,
  getPublicConfig,
  imageBufferFromMessage,
  isPrivateAddress,
  normalizeConceptIds,
  publicConceptResult,
  publicFinalizeResult,
  readConceptOptions,
  runFinalize,
  safeName,
  safeRunId,
  validateRemoteImageUrl,
};
