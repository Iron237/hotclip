import { mkdir, readFile, writeFile, rm, stat, rename } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { StudioClip, StudioLine } from "../shared/studio";
import {
  stripCaptionPunctuation,
  joinCaptionWords,
} from "../shared/caption-text";
import {
  qwenAlign,
  qwenHealth,
  DEFAULT_QWEN_URL,
} from "../core/transcribe/qwen-local";
import { ensureConfiguredQwenService } from "../core/transcribe/qwen-service";
import { runFfmpeg } from "./media";
import { segmentCaptions } from "./captions";
import { rebuildWords } from "../shared/edit-transcript";
import { refineWordTimings } from "../core/align";

export function captionAlignmentGroups(input: StudioLine[]): StudioLine[][] {
  const groups: StudioLine[][] = [];
  for (const l of input) {
    if (l.endSec - l.startSec > 60)
      throw new Error("单句超过 60 秒，请先缩小字幕时间范围");
    const prev = groups.at(-1);
    if (
      prev &&
      (l.speakerRole ?? "unknown") === (prev[0].speakerRole ?? "unknown") &&
      (l.speakerBasis ?? "unclassified") ===
        (prev[0].speakerBasis ?? "unclassified") &&
      l.endSec - prev[0].startSec <= 24 &&
      l.startSec - prev.at(-1)!.endSec < 1.5
    )
      prev.push(l);
    else groups.push([l]);
  }
  return groups;
}

export async function alignCaptions(
  source: string,
  root: string,
  clip: StudioClip,
  duration: number,
  signal: AbortSignal,
  progress: (done: number, total: number) => void,
): Promise<StudioLine[]> {
  const health = await qwenHealth().catch(async () => {
    await ensureConfiguredQwenService(DEFAULT_QWEN_URL, signal);
    return qwenHealth();
  });
  if (!health.aligner) throw new Error("Qwen 强制对齐模型未加载，原字幕未修改");
  const input = clip.subtitles
    .filter((l) => l.text.trim())
    .sort((a, b) => a.startSec - b.startSec);
  const groups = captionAlignmentGroups(input);
  const cache = join(root, "studio", "alignment-cache");
  await mkdir(cache, { recursive: true });
  const info = await stat(source),
    result: StudioLine[] = [];
  progress(0, groups.length);
  for (const [index, group] of groups.entries()) {
    signal.throwIfAborted();
    // Excluded dialogue remains available for audit; never align it into host cues.
    if (group[0].speakerRole !== "host") {
      result.push(...group);
      progress(index + 1, groups.length);
      continue;
    }
    const start = Math.max(0, group[0].startSec - 0.3),
      end = Math.min(duration, group.at(-1)!.endSec + 0.3);
    const normalized = (s: string) =>
      stripCaptionPunctuation(s).replace(/\s/g, "");
    const text = group
      .map((l) =>
        l.words?.length &&
        normalized(l.words.map((w) => w.text).join("")) === normalized(l.text)
          ? joinCaptionWords(l.words)
          : l.text,
      )
      .join(" ");
    const hash = createHash("sha256")
      .update(
        JSON.stringify([
          "audio-captions-v4-speaker-evidence",
          health.revision,
          source,
          info.size,
          info.mtimeMs,
          start,
          end,
          group,
        ]),
      )
      .digest("hex");
    const file = join(cache, hash + ".json");
    const cached = await readFile(file, "utf8")
      .then(JSON.parse)
      .catch((e) => {
        if (e.code === "ENOENT") return null;
        throw e;
      });
    if (cached) result.push(...segmentCaptions(cached));
    else {
      const pcm = join(cache, randomUUID() + ".f32le");
      try {
        await runFfmpeg(
          [
            "-ss",
            String(start),
            "-i",
            source,
            "-t",
            String(end - start),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-f",
            "f32le",
            pcm,
          ],
          { signal },
        );
        const buffer = await readFile(pcm),
          samples = new Float32Array(buffer.length / 4);
        for (let i = 0; i < samples.length; i++)
          samples[i] = buffer.readFloatLE(i * 4);
        const words = await qwenAlign(
          DEFAULT_QWEN_URL,
          samples,
          text,
          "zh",
          signal,
        );
        // Qwen may assign zero duration to a short function word. Keep its text
        // via neighbouring anchors and explicitly mark it interpolated; never
        // silently delete it or claim every character has an acoustic timestamp.
        const refined = refineWordTimings(
          rebuildWords(text, 0, end - start),
          words,
        );
        if (
          !words.length ||
          refined.matchedFrac < 0.85 ||
          refined.words.some((w) => w.startSec < 0 || w.endSec > end - start)
        )
          throw new Error(
            `第 ${index + 1} 段缺少可靠音频锚点，保留原字幕，请回听核对`,
          );
        const lines: StudioLine[] = [
          {
            ...group[0],
            id: "aligned-" + hash.slice(0, 16),
            text,
            raw: group.map((l) => l.raw).join(" "),
            correctionReason: group
              .map((l) => l.correctionReason)
              .filter(Boolean)
              .join("；"),
            uncertain: group.some((l) => l.uncertain),
            sourceIds: group.flatMap((l) => l.sourceIds ?? [l.id]),
            speakerReason: [
              ...new Set(group.map((l) => l.speakerReason).filter(Boolean)),
            ].join("；"),
            words: refined.words.map((w) => ({
              ...w,
              startSec: w.startSec + start,
              endSec: w.endSec + start,
            })),
          },
        ];
        result.push(...segmentCaptions(lines));
        const pending = file + "." + randomUUID() + ".tmp";
        try {
          await writeFile(pending, JSON.stringify(lines));
          await rename(pending, file);
        } finally {
          await rm(pending, { force: true });
        }
      } finally {
        await rm(pcm, { force: true });
      }
    }
    progress(index + 1, groups.length);
  }
  return result;
}
