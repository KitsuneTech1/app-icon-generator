import test, { after, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "icon-forge-test-"));
process.env.ICON_OUTPUT_DIR = outputDir;

const {
  appendIconPack,
  conceptIdsFromFiles,
  getPublicConfig,
  imageBufferFromMessage,
  isPrivateAddress,
  makeIcon,
  mapWithConcurrency,
  normalizeConceptIds,
  publicConceptResult,
  publicFinalizeResult,
  readConceptOptions,
  runFinalize,
  safeName,
  safeRunId,
  validateRemoteImageUrl,
} = await import("../server.js");

after(async () => {
  await fs.rm(outputDir, { recursive: true, force: true });
});

describe("input handling", () => {
  test("clamps concept counts to whole numbers and rejects traversal IDs", () => {
    assert.equal(readConceptOptions({ prompt: "fox", count: 2.9 }).count, 2);
    assert.equal(readConceptOptions({ prompt: "fox", count: 0 }).count, 1);
    assert.equal(readConceptOptions(null).style, "clean vector app icon");
    assert.equal(safeRunId(".."), "");
    assert.equal(safeRunId("."), "");
    assert.equal(safeRunId("a".repeat(81)), "");
    assert.equal(safeName("a".repeat(200)).length, 80);
    assert.deepEqual(normalizeConceptIds([1, 25, 26, 0, "2", 9007199254740992]), [1, 25, 2]);
    assert.deepEqual(
      conceptIdsFromFiles(["concept-10.png", "concept-03.png", "concept-26.png", "notes.png"]),
      [3, 10],
    );
    assert.throws(
      () => readConceptOptions({ prompt: "x".repeat(4001) }),
      /maximum 4000 characters/,
    );
  });

  test("uses at least one worker for a bad concurrency value", async () => {
    const result = await mapWithConcurrency([1, 2, 3], 0, async (value) => value * 2);
    assert.deepEqual(result.map((item) => item.value), [2, 4, 6]);
  });

  test("does not return internal paths in public results or worker errors", async () => {
    assert.deepEqual(
      publicConceptResult({ runId: "run", savedTo: "internal-output", concepts: [] }),
      { runId: "run", concepts: [] },
    );
    assert.deepEqual(
      publicFinalizeResult({
        runId: "run",
        savedTo: "internal-output",
        finals: [{ conceptId: 1, savedTo: "internal-output/pack.zip", zip: "/runs/run/finals/pack.zip" }],
      }),
      { runId: "run", finals: [{ conceptId: 1, zip: "/runs/run/finals/pack.zip" }] },
    );
    const result = await mapWithConcurrency([1], 1, async () => {
      throw new Error("internal secret");
    });
    assert.equal(result[0].error, "Icon generation failed.");
  });
});

describe("untrusted model output", () => {
  test("rejects private image hosts before any network request", () => {
    assert.equal(isPrivateAddress("localhost"), true);
    assert.equal(isPrivateAddress("example.com"), false);
    assert.throws(() => validateRemoteImageUrl("http://localhost/secret"), /public HTTP/);
    assert.throws(() => validateRemoteImageUrl("https://user:pass@example.com/icon.png"), /public HTTP/);
    assert.equal(validateRemoteImageUrl("https://example.com/icon.png").href, "https://example.com/icon.png");
  });

  test("accepts bounded image data URIs and rejects malformed ones", async () => {
    const source = await sharp({
      create: { width: 2, height: 2, channels: 4, background: "#336699" },
    })
      .png()
      .toBuffer();
    const decoded = await imageBufferFromMessage({
      images: [{ image_url: { url: `data:image/png;base64,${source.toString("base64")}` } }],
    });
    assert.deepEqual(decoded, source);
    await assert.rejects(
      imageBufferFromMessage({ images: [{ url: "data:text/plain;base64,Zm9v" }] }),
      /invalid image data URI/,
    );
  });

  test("does not expose the absolute output directory in public config", () => {
    assert.deepEqual(getPublicConfig(), { maxConcepts: 25 });
  });
});

describe("icon packaging", () => {
  test("renders a square PNG at the requested size", async () => {
    const source = await sharp({
      create: { width: 32, height: 32, channels: 4, background: "#ff6600" },
    })
      .png()
      .toBuffer();
    const icon = await makeIcon(source, 96, 8, "#121212", false);
    const metadata = await sharp(icon).metadata();
    assert.deepEqual(
      { width: metadata.width, height: metadata.height, format: metadata.format },
      { width: 96, height: 96, format: "png" },
    );
  });

  test("adds only the requested web pack entries", async () => {
    const source = await sharp({
      create: { width: 32, height: 32, channels: 4, background: "#336699" },
    })
      .png()
      .toBuffer();
    const entries = [];
    const archive = { append: (_data, options) => entries.push(options.name) };
    await appendIconPack(archive, source, {
      padding: 8,
      background: "#121212",
      rounded: false,
      preset: "web",
      name: "demo",
    });
    assert.deepEqual(entries, [
      "web/favicon-16.png",
      "web/favicon-32.png",
      "web/apple-touch-icon.png",
      "web/icon-192.png",
      "web/icon-512.png",
      "README.txt",
    ]);
  });

  test("finalizes sparse concept IDs instead of renumbering them", async () => {
    const runId = "sparse-run";
    const conceptsDir = path.join(outputDir, runId, "concepts");
    await fs.mkdir(conceptsDir, { recursive: true });
    const source = await sharp({
      create: { width: 32, height: 32, channels: 4, background: "#884422" },
    })
      .png()
      .toBuffer();
    await fs.writeFile(path.join(conceptsDir, "concept-01.png"), source);
    await fs.writeFile(path.join(conceptsDir, "concept-03.png"), source);

    const result = await runFinalize({ runId, name: "demo", preset: "web" });

    assert.deepEqual(result.finals.map((item) => item.conceptId), [1, 3]);
    for (const item of result.finals) {
      assert.equal((await fs.stat(item.savedTo)).isFile(), true);
    }
    const invalidSelection = await runFinalize({
      runId,
      name: "demo",
      preset: "web",
      conceptIds: [26],
    });
    assert.deepEqual(invalidSelection.finals, []);
    await assert.rejects(
      runFinalize({ runId, conceptIds: "1" }),
      /conceptIds must be an array/,
    );
  });

  test("removes partial packs when source image processing fails", async () => {
    const runId = "broken-run";
    const conceptsDir = path.join(outputDir, runId, "concepts");
    const finalsDir = path.join(outputDir, runId, "finals");
    await fs.mkdir(conceptsDir, { recursive: true });
    await fs.writeFile(path.join(conceptsDir, "concept-01.png"), Buffer.from("not an image"));

    await assert.rejects(runFinalize({ runId, name: "broken", preset: "web" }));
    await assert.rejects(fs.stat(path.join(finalsDir, "broken-01-icons.zip")), { code: "ENOENT" });
  });
});
