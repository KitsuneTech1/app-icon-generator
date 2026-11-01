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
  makeIcon,
  mapWithConcurrency,
  readConceptOptions,
  runFinalize,
  safeRunId,
} = await import("../server.js");

after(async () => {
  await fs.rm(outputDir, { recursive: true, force: true });
});

describe("input handling", () => {
  test("clamps concept counts to whole numbers and rejects traversal IDs", () => {
    assert.equal(readConceptOptions({ prompt: "fox", count: 2.9 }).count, 2);
    assert.equal(readConceptOptions({ prompt: "fox", count: 0 }).count, 1);
    assert.equal(safeRunId(".."), "");
    assert.equal(safeRunId("."), "");
    assert.deepEqual(
      conceptIdsFromFiles(["concept-10.png", "concept-03.png", "notes.png"]),
      [3, 10],
    );
  });

  test("uses at least one worker for a bad concurrency value", async () => {
    const result = await mapWithConcurrency([1, 2, 3], 0, async (value) => value * 2);
    assert.deepEqual(result.map((item) => item.value), [2, 4, 6]);
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
  });
});
