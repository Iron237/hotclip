import { readFile, open, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import { runFfmpeg } from "../src/core/cut";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { VOICE_AUDIO_FILTER } from "../src/core/caption-voiceprints";
const root = process.argv[2];
if (!root) throw new Error("Usage: verify-voice-audio-clock.mts RUN_ROOT");
const source = JSON.parse(await readFile(join(root, "source.json"), "utf8"));
const dir = join(root, "studio", "voiceprints");
const info = await stat(source.videoPath);
const audioKey = createHash("sha256")
  .update(
    JSON.stringify([
      source.videoPath,
      info.size,
      info.mtimeMs,
      VOICE_AUDIO_FILTER,
    ]),
  )
  .digest("hex");
const pcm = join(dir, `audio-${audioKey}.f32le`);
if (!(await stat(pcm).catch(() => null))) {
  await runFfmpeg([
    "-y",
    "-i",
    source.videoPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-af",
    VOICE_AUDIO_FILTER,
    "-f",
    "f32le",
    pcm + ".tmp",
  ]);
  const { rename } = await import("node:fs/promises");
  await rename(pcm + ".tmp", pcm);
}
const audio = await open(pcm, "r");
const verifyDir = join(dir, "clock-check");
await mkdir(verifyDir, { recursive: true });
try {
  const samples = [];
  for (const start of [100, 7400, 14000]) {
    const file = join(verifyDir, `${start}.f32le`);
    await runFfmpeg([
      "-y",
      "-ss",
      String(start),
      "-i",
      source.videoPath,
      "-t",
      "2",
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-f",
      "f32le",
      file,
    ]);
    const sought = await readFile(file);
    const whole = Buffer.alloc(sought.length + 3200 * 4);
    await audio.read(whole, 0, whole.length, (start * 16000 - 1600) * 4);
    let bestLag = 0,
      bestCorrelation = -1;
    for (let lag = -1600; lag <= 1600; lag++) {
      let dot = 0,
        xx = 0,
        yy = 0;
      for (let n = 0; n < sought.length / 4; n += 8) {
        const x = sought.readFloatLE(n * 4),
          y = whole.readFloatLE((n + 1600 + lag) * 4);
        dot += x * y;
        xx += x * x;
        yy += y * y;
      }
      const correlation = dot / Math.sqrt(xx * yy);
      if (correlation > bestCorrelation) {
        bestCorrelation = correlation;
        bestLag = lag;
      }
    }
    console.log(
      JSON.stringify({
        sourceSeconds: start,
        offsetMs: bestLag / 16,
        correlation: bestCorrelation,
      }),
    );
    assert.ok(bestCorrelation > 0.95, `decoded source differs at ${start}s`);
    assert.ok(
      Math.abs(bestLag / 16000) < 0.005,
      `source clock drifts at ${start}s`,
    );
    samples.push({
      sourceSeconds: start,
      offsetMs: bestLag / 16,
      correlation: bestCorrelation,
    });
  }
  const receipt = { success: true, filter: VOICE_AUDIO_FILTER, samples };
  await writeFile(
    join(verifyDir, "receipt.json"),
    JSON.stringify(receipt, null, 2),
  );
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  await audio.close();
}
