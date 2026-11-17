import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  attachWordTimings,
  segmentCaptions,
} from "../src/studio-server/captions";
import { alignCaptions } from "../src/studio-server/align-captions";
import { clipLines } from "../src/shared/studio";
const root = process.argv[2];
if (!root)
  throw new Error("Usage: tsx tools/studio-audio-check.mts <run-root>");
const source = JSON.parse(await readFile(join(root, "source.json"), "utf8"));
const original = JSON.parse(
  await readFile(join(root, "audit/reviewed-lines.json"), "utf8"),
);
const asr = JSON.parse(await readFile(join(root, "asr-raw.json"), "utf8"));
const rebuilt = segmentCaptions(attachWordTimings(original, asr.segments));
const selected = clipLines(original, 10118.3, 10129.7);
const aligned = await alignCaptions(
  source.videoPath,
  root,
  {
    id: "test-audio",
    title: "断句验证",
    startSec: 10118.3,
    endSec: 10129.7,
    subtitles: selected,
  },
  source.media.durationSec,
  new AbortController().signal,
  (done, total) => console.log({ done, total }),
);
const report = {
  before: selected,
  rebuilt: clipLines(rebuilt, 10118.3, 10129.7),
  aligned,
};
await mkdir("studio-test-results", { recursive: true });
await writeFile(
  "studio-test-results/audio-alignment.json",
  JSON.stringify(report, null, 2),
);
console.log(
  JSON.stringify(
    aligned.map((l) => ({ start: l.startSec, end: l.endSec, text: l.text })),
    null,
    2,
  ),
);
