import { stripCaptionPunctuation, joinCaptionWords } from "./caption-text";

export interface StudioLine {
  id: string;
  startSec: number;
  endSec: number;
  raw: string;
  text: string;
  uncertain: boolean;
  correctionReason: string;
  reviewed?: boolean;
  words?: {
    text: string;
    startSec: number;
    endSec: number;
    timingSource?: string;
  }[];
  sourceIds?: string[];
  timingStatus?: "aligned" | "needs-alignment" | "manual";
  boundaryPartial?: boolean;
  speakerRole?: "host" | "game" | "unknown";
  speakerBasis?: "semantic-context" | "voiceprint-context" | "manual" | "unclassified";
  speakerReason?: string;
}
/** Missing attribution is not permission to display game dialogue. */
export function hostCaptionLines(lines: StudioLine[]): StudioLine[] {
  return lines.filter((l) => l.speakerRole === "host");
}
export interface StudioInterest {
  id: string;
  title: string;
  origin: string;
  startSec: number | null;
  endSec: number | null;
  markerSec: number;
  why: string;
  notes: string[];
  needsReview: boolean;
}
export interface StudioChat {
  id: string;
  startSec: number;
  text: string;
}
export interface StudioClip {
  id: string;
  interestId?: string;
  title: string;
  startSec: number;
  endSec: number;
  subtitles: StudioLine[];
  // Uncropped source-clock cues survive repeated shrink/expand operations.
  subtitleSource?: StudioLine[];
  subtitleCoverage?: { startSec: number; endSec: number };
}
export interface StudioSettings {
  quality: "auto" | "small" | "high" | "bitrate";
  bitrateMbps: number;
  resolution: "source" | "1080" | "720";
  burnSubtitles: boolean;
  burnDanmaku: boolean;
  danmakuOpacity: number;
  danmakuSize: number;
}
export interface StudioDraft {
  revision: number;
  clips: StudioClip[];
  settings: StudioSettings;
}
export interface StudioProject {
  id: string;
  title: string;
  streamer: string;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  bitRate: number;
  interests: StudioInterest[];
  lines: StudioLine[];
  chat: StudioChat[];
  draft: StudioDraft;
  outputDirectory: string;
}
export interface StudioJob {
  id: string;
  projectId: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  progress: number;
  message: string;
  createdAt: string;
  files: { name: string; url: string }[];
  clips: StudioClip[];
  settings: StudioSettings;
}
export const defaultStudioSettings: StudioSettings = {
  quality: "auto",
  bitrateMbps: 6,
  resolution: "source",
  burnSubtitles: true,
  burnDanmaku: false,
  danmakuOpacity: 0.85,
  danmakuSize: 34,
};
export function timecode(sec: number, precise = false): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  return (
    [
      Math.floor(ms / 3600000),
      Math.floor(ms / 60000) % 60,
      Math.floor(ms / 1000) % 60,
    ]
      .map((n) => String(n).padStart(2, "0"))
      .join(":") + (precise ? "." + String(ms % 1000).padStart(3, "0") : "")
  );
}
export function parseTimecode(value: string): number | null {
  const parts = value.trim().split(":");
  if (
    !parts.length ||
    parts.length > 3 ||
    !parts.every((p) => /^\d+(\.\d{1,3})?$/.test(p))
  )
    return null;
  if (
    parts.slice(0, -1).some((p) => p.includes(".")) ||
    parts.slice(1).some((p) => Number(p) >= 60)
  )
    return null;
  const n = parts.reduce((total, p) => total * 60 + Number(p), 0);
  return Number.isFinite(n) ? n : null;
}
export function clipLines(
  lines: StudioLine[],
  start: number,
  end: number,
): StudioLine[] {
  if (end <= start) return [];
  return lines
    .filter((l) => l.endSec > start && l.startSec < end)
    .flatMap((l) => {
      const cropped = l.startSec < start || l.endSec > end;
      const validWords =
        l.words?.length &&
        stripCaptionPunctuation(l.words.map((w) => w.text).join("")).replace(
          /\s/g,
          "",
        ) === stripCaptionPunctuation(l.text).replace(/\s/g, "");
      const words = validWords
        ? l.words!.filter(
            (w) =>
              (w.startSec + w.endSec) / 2 >= start &&
              (w.startSec + w.endSec) / 2 < end,
          )
        : undefined;
      if (words && !words.length) return [];
      const partial =
        cropped &&
        (!validWords ||
          l.words!.some(
            (w) =>
              (w.startSec < start && w.endSec > start) ||
              (w.startSec < end && w.endSec > end),
          ));
      return [
        {
          ...l,
          startSec: Math.max(start, words?.[0]?.startSec ?? l.startSec),
          endSec: Math.min(end, words?.at(-1)?.endSec ?? l.endSec),
          text: stripCaptionPunctuation(
            cropped && words ? joinCaptionWords(words) : l.text,
          ),
          words: words?.map((w) => ({
            ...w,
            startSec: Math.max(start, w.startSec),
            endSec: Math.min(end, w.endSec),
          })),
          boundaryPartial: partial,
          uncertain: l.uncertain || partial,
          reviewed: cropped ? false : l.reviewed,
        },
      ];
    });
}

/** Resize in the source clock. Never reconstruct already edited cues from ASR. */
export function resizeClip(
  lines: StudioLine[],
  old: StudioClip | undefined,
  bounds: Pick<
    StudioClip,
    "id" | "title" | "startSec" | "endSec" | "interestId"
  >,
): StudioClip {
  const kept = old?.subtitleSource ?? old?.subtitles ?? [];
  const coverage =
    old?.subtitleCoverage ??
    (old
      ? { startSec: old.startSec, endSec: old.endSec }
      : { startSec: bounds.startSec, endSec: bounds.startSec });
  const extra = old
    ? [
        ...clipLines(
          lines,
          bounds.startSec,
          Math.min(bounds.endSec, coverage.startSec),
        ),
        ...clipLines(
          lines,
          Math.max(bounds.startSec, coverage.endSec),
          bounds.endSec,
        ),
      ]
    : lines.filter(
        (l) => l.endSec > bounds.startSec && l.startSec < bounds.endSec,
      );
  const source = [
    ...kept,
    ...extra.filter((l) => !kept.some((k) => k.id === l.id)),
  ]
    .map((l) => structuredClone(l))
    .sort((a, b) => a.startSec - b.startSec);
  return {
    ...bounds,
    subtitleSource: source,
    subtitleCoverage: {
      startSec: Math.min(
        bounds.startSec,
        coverage.startSec,
        ...source.map((l) => l.startSec),
      ),
      endSec: Math.max(
        bounds.endSec,
        coverage.endSec,
        ...source.map((l) => l.endSec),
      ),
    },
    subtitles: clipLines(source, bounds.startSec, bounds.endSec),
  };
}

export function editClipLine(
  clip: StudioClip,
  id: string,
  patch: Partial<StudioLine>,
): StudioClip {
  const edit = (l: StudioLine, changes = patch): StudioLine => {
    if (l.id !== id) return l;
    const changedText =
      changes.text !== undefined &&
      stripCaptionPunctuation(changes.text) !== stripCaptionPunctuation(l.text);
    const changedTime =
      (changes.startSec !== undefined && changes.startSec !== l.startSec) ||
      (changes.endSec !== undefined && changes.endSec !== l.endSec);
    return {
      ...l,
      ...changes,
      ...(changes.speakerRole !== undefined
        ? {
            speakerBasis: "manual" as const,
            speakerReason: "人工指定字幕声音来源",
            reviewed: false,
          }
        : {}),
      ...(changedText || changedTime
        ? {
            words: undefined,
            timingStatus: changedText
              ? ("needs-alignment" as const)
              : ("manual" as const),
            reviewed: false,
            uncertain: true,
          }
        : {}),
    };
  };
  const visible = clip.subtitles.find((l) => l.id === id);
  const source = (clip.subtitleSource ?? clip.subtitles).flatMap((l) => {
    if (
      l.id !== id ||
      !visible ||
      (l.startSec === visible.startSec && l.endSec === visible.endSec)
    )
      return [edit(l)];
    if (
      patch.text !== undefined &&
      stripCaptionPunctuation(patch.text) !==
        stripCaptionPunctuation(visible.text)
    ) {
      return [
        ...clipLines([l], 0, visible.startSec).map((t) => ({
          ...t,
          id: `before-${t.id}`,
        })),
        edit(visible),
        ...clipLines([l], visible.endSec, Number.MAX_SAFE_INTEGER).map((t) => ({
          ...t,
          id: `after-${t.id}`,
        })),
      ];
    }
    // Confirmation of a visible excerpt is not a rewrite of its full source cue.
    const changes = { ...patch, reviewed: false };
    delete changes.text;
    return [edit(l, changes)];
  });
  return {
    ...clip,
    subtitles: clip.subtitles.map((l) => edit(l)),
    subtitleSource: source,
  };
}
/** Replace only the aligned interval; preserve both excluded tails for later expansion. */
export function replaceClipCaptions(
  clip: StudioClip,
  lines: StudioLine[],
): StudioClip {
  const old = clip.subtitleSource ?? clip.subtitles;
  const preserved = [
    ...clipLines(old, 0, clip.startSec).map((l) => ({
      ...l,
      id: `left-${l.id}`,
    })),
    ...clipLines(old, clip.endSec, Number.MAX_SAFE_INTEGER).map((l) => ({
      ...l,
      id: `right-${l.id}`,
    })),
  ];
  const source = [
    ...preserved,
    ...clipLines(lines, clip.startSec, clip.endSec),
  ].sort((a, b) => a.startSec - b.startSec);
  return {
    ...clip,
    subtitleSource: source,
    subtitles: clipLines(lines, clip.startSec, clip.endSec),
  };
}
export function subtitleFile(
  lines: StudioLine[],
  offset = 0,
  vtt = false,
): string {
  const timestamp = (sec: number) =>
    timecode(Math.max(0, sec - offset), true).replace(".", vtt ? "." : ",");
  return (
    (vtt ? "WEBVTT\n\n" : "") +
    lines
      .filter((l) => l.text.trim())
      .map(
        (l, i) =>
          `${i + 1}\n${timestamp(l.startSec)} --> ${timestamp(l.endSec)}\n${stripCaptionPunctuation(l.text).replace(/\r?\n/g, " ")}\n`,
      )
      .join("\n")
  );
}
export function validateDraft(
  value: unknown,
  duration: number,
): asserts value is StudioDraft {
  const d = value as StudioDraft;
  const range = (a: number, b: number) =>
    Number.isFinite(a) &&
    Number.isFinite(b) &&
    a >= 0 &&
    b > a &&
    b <= duration + 0.001;
  if (
    !d ||
    !Number.isInteger(d.revision) ||
    d.revision < 0 ||
    !Array.isArray(d.clips) ||
    d.clips.length > 100
  )
    throw new Error("切片列表格式无效");
  const ids = new Set<string>();
  for (const c of d.clips) {
    if (
      !c ||
      typeof c.id !== "string" ||
      !/^[\w-]{1,80}$/.test(c.id) ||
      ids.has(c.id) ||
      typeof c.title !== "string" ||
      !c.title.trim() ||
      c.title.length > 200 ||
      !range(c.startSec, c.endSec) ||
      c.endSec - c.startSec < 0.1 ||
      !Array.isArray(c.subtitles) ||
      c.subtitles.length > 10000
    )
      throw new Error("切片名称、时间或编号无效");
    ids.add(c.id);
    if (
      c.subtitleSource !== undefined &&
      (!Array.isArray(c.subtitleSource) || c.subtitleSource.length > 10000)
    )
      throw new Error("字幕源格式无效");
    if (
      c.subtitleCoverage &&
      !range(c.subtitleCoverage.startSec, c.subtitleCoverage.endSec)
    )
      throw new Error("字幕源时间范围无效");
    const lineIds = new Set<string>();
    for (const l of c.subtitles) {
      if (
        !l ||
        typeof l.id !== "string" ||
        lineIds.has(l.id) ||
        typeof l.text !== "string" ||
        l.text.length > 4000 ||
        typeof l.raw !== "string" ||
        l.raw.length > 4000 ||
        !range(l.startSec, l.endSec) ||
        l.startSec < c.startSec - 0.001 ||
        l.endSec > c.endSec + 0.001
      )
        throw new Error("字幕时间须位于切片入点和出点之间");
      lineIds.add(l.id);
    }
    const sorted = [...c.subtitles].sort((a, b) => a.startSec - b.startSec);
    if (
      sorted.some((l, i) => i > 0 && l.startSec < sorted[i - 1].endSec - 0.001)
    )
      throw new Error("字幕不能重叠，请调整相邻句时间");
    const sourceIds = new Set<string>();
    for (const l of c.subtitleSource ?? []) {
      if (
        !l ||
        typeof l.id !== "string" ||
        sourceIds.has(l.id) ||
        typeof l.text !== "string" ||
        typeof l.raw !== "string" ||
        l.text.length > 4000 ||
        l.raw.length > 4000 ||
        !range(l.startSec, l.endSec)
      )
        throw new Error("字幕源格式或时间无效");
      sourceIds.add(l.id);
    }
    for (const l of [...c.subtitles, ...(c.subtitleSource ?? [])]) {
      if (
        l.speakerRole !== undefined &&
        !["host", "game", "unknown"].includes(l.speakerRole)
      )
        throw new Error("字幕说话人类型无效");
      if (l.words !== undefined) {
        if (!Array.isArray(l.words) || l.words.length > 4000)
          throw new Error("字词时间格式无效");
        let end = l.startSec;
        for (const w of l.words) {
          if (
            !w ||
            typeof w.text !== "string" ||
            w.text.length > 4000 ||
            !range(w.startSec, w.endSec) ||
            w.startSec < end - 0.001 ||
            w.endSec > l.endSec + 0.001
          )
            throw new Error("字词时间须有序且在字幕范围内");
          end = w.endSec;
        }
      }
    }
  }
  const s = d.settings;
  if (
    !s ||
    !["auto", "small", "high", "bitrate"].includes(s.quality) ||
    !["source", "1080", "720"].includes(s.resolution) ||
    !Number.isFinite(s.bitrateMbps) ||
    s.bitrateMbps < 0.5 ||
    s.bitrateMbps > 50 ||
    typeof s.burnSubtitles !== "boolean" ||
    typeof s.burnDanmaku !== "boolean" ||
    !Number.isFinite(s.danmakuOpacity) ||
    s.danmakuOpacity < 0.2 ||
    s.danmakuOpacity > 1 ||
    !Number.isFinite(s.danmakuSize) ||
    s.danmakuSize < 20 ||
    s.danmakuSize > 60
  )
    throw new Error("导出设置无效");
}

// A fixed logical 1920×1080 stage makes browser preview and ASS export share
// deterministic lanes. Reserve each lane until the previous message has left:
// conservative admission prevents long, faster comments overtaking short ones.
export interface ChatCue extends StudioChat {
  endSec: number;
  lane: number;
  width: number;
}
export function scheduleChat(chat: StudioChat[], size: number): ChatCue[] {
  const free = Array<number>(8).fill(-Infinity);
  return [...chat]
    .sort((a, b) => a.startSec - b.startSec)
    .flatMap((c) => {
      const lane = free.findIndex((t) => t <= c.startSec);
      if (lane < 0 || !c.text.trim()) return [];
      const text = c.text.replace(/\s+/g, " ").slice(0, 80);
      const width = Array.from(text).reduce(
        (w, char) => w + (char.charCodeAt(0) < 128 ? 0.65 : 1.05) * size,
        0,
      );
      free[lane] = c.startSec + 9;
      return [{ ...c, text, endSec: c.startSec + 9, lane, width }];
    });
}
export function visibleChat(cues: ChatCue[], time: number): ChatCue[] {
  let lo = 0,
    hi = cues.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cues[mid].startSec <= time - 9) lo = mid + 1;
    else hi = mid;
  }
  const out: ChatCue[] = [];
  for (let i = lo; i < cues.length && cues[i].startSec <= time; i++)
    if (cues[i].endSec > time) out.push(cues[i]);
  return out;
}
