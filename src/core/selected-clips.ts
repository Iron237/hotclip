import { checkDomainLexicon } from "./domain-lexicon";
/** Export decisions made by the calling agent without a second LLM call. */
import { mkdir, open, readdir, unlink, writeFile } from "fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "path";
import { randomUUID } from "crypto";
import { exportClips, sanitizeFilename, type ExportClipSpec } from "./export";
import { probeMedia } from "./probe";
import { sliceWords } from "./subtitle";
import { transcribeCached } from "./pipeline";
import type { GlossaryEntry, SpeechRunOptions } from "../shared/api-types";

export interface SelectedClip {
  title: string;
  startSec: number;
  endSec: number;
  reason?: string;
}

export function validateSelectedClips(value: unknown, durationSec: number): SelectedClip[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error("无法确定源视频时长");
  if (!Array.isArray(value) || value.length < 1 || value.length > 12) throw new Error("clips 必须包含 1–12 条切片");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`clips[${index}] 应为对象`);
    const { title, startSec, endSec, reason } = item;
    if (typeof title !== "string" || !title.trim() || title.length > 120) throw new Error(`clips[${index}].title 需要 1–120 字标题`);
    if (typeof startSec !== "number" || typeof endSec !== "number" || !Number.isFinite(startSec) || !Number.isFinite(endSec)
      || startSec < 0 || endSec <= startSec || endSec > durationSec) {
      throw new Error(`clips[${index}] 时间必须满足 0 <= startSec < endSec <= ${durationSec}; 使用源片秒数`);
    }
    if (reason !== undefined && (typeof reason !== "string" || reason.length > 1200)) throw new Error(`clips[${index}].reason 最多 1200 字`);
    return { title: title.trim(), startSec, endSec, ...(reason !== undefined ? { reason } : {}) };
  });
}

export interface SelectedExportOptions {
  modelsRoot: string;
  cacheDir: string;
  fontsDir: string;
  renderCacheDir?: string;
  evidenceCacheDir?: string;
  outDir?: string;
  vertical?: boolean;
  captions?: boolean;
  subtitlePath?: string;
  glossary?: GlossaryEntry[];
  lexiconProfiles?: string[];
  asr?: SpeechRunOptions & { engineId?: string };
}

export async function exportSelectedClips(videoPath: string, selections: unknown, options: SelectedExportOptions) {
  if (!isAbsolute(videoPath)) throw new Error("videoPath 必须为绝对路径");
  const media = await probeMedia(videoPath);
  const selected = validateSelectedClips(selections, media.durationSec);
  if (options.outDir !== undefined && (!options.outDir.trim() || !isAbsolute(options.outDir))) throw new Error("outDir 必须为绝对路径");
  const stem = sanitizeFilename(basename(videoPath, extname(videoPath)), "video");
  const outDir = resolve(options.outDir ?? join(dirname(videoPath), `${stem}-selected-${randomUUID().slice(0, 8)}`));
  // Do not overwrite an earlier export or any source files.
  try {
    if ((await readdir(outDir)).length > 0) throw new Error("输出目录非空; 请指定新的空目录");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const captions = options.captions !== false;
  const rawTranscript = captions
    ? await transcribeCached(videoPath, options.modelsRoot, options.cacheDir, options.glossary, undefined, options.subtitlePath, options.asr)
    : undefined;
  const checked = rawTranscript ? checkDomainLexicon(rawTranscript, options.subtitlePath ? [] : options.lexiconProfiles) : undefined;
  const transcript = checked?.transcript;
  if (captions && !transcript?.segments.some((s) => s.words.length > 0)) throw new Error("转写为空，无法生成字幕; 可明确设置 captions=false 导出纯画面");
  await mkdir(outDir, { recursive: true });
  const lockPath = join(outDir, ".hotclip-export.lock");
  const lock = await open(lockPath, "wx");
  try {
    // Recheck after ASR and atomic reservation: another invocation may have exported meanwhile.
    if ((await readdir(outDir)).some((name) => name !== ".hotclip-export.lock")) throw new Error("输出目录非空; 请指定新的空目录");
    const clips: ExportClipSpec[] = selected.map((c, i) => ({
      id: i + 1, title: c.title, startSec: c.startSec, endSec: c.endSec,
      manualBounds: true,
      words: transcript ? sliceWords(transcript, c.startSec, c.endSec) : undefined,
    }));
    const exported = await exportClips(videoPath, clips, outDir, {
      vertical: options.vertical === true,
      captionStyle: captions ? "keyword" : undefined,
      subtitleFile: captions,
      timeline: true,
      jumpCut: false,
      cleanFillers: false,
      cutRetakes: false,
      titleCard: false,
      snapToShots: false,
      normalizeLoudness: true,
      // QA reports issues but must not silently shorten an agent-selected joke/reaction.
      qa: true,
      qaRepair: false,
      fontsDir: options.fontsDir,
      modelsRoot: options.modelsRoot,
      renderCacheDir: options.renderCacheDir,
      evidenceCacheDir: options.evidenceCacheDir,
    });
    const receipt = {
      outDir, selectionSource: "calling-agent", llmUsed: false,
      sourceDurationSec: media.durationSec,
      selections: selected,
      lexiconVersion: checked?.version,
      lexiconAudit: checked?.audit.filter((a) => selected.some((s) => a.endSec > s.startSec && a.startSec < s.endSec)) ?? [],
      exported,
      warnings: exported.flatMap((clip) => clip.qa?.status === "warn" ? [{ id: clip.id, issues: clip.qa.issues }] : []),
    };
    await writeFile(join(outDir, "selection.json"), JSON.stringify(receipt, null, 2), "utf8");
    return receipt;
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
