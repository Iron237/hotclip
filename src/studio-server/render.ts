import { mkdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { stripCaptionPunctuation } from "../shared/caption-text";
import {
  scheduleChat,
  subtitleFile,
  timecode,
  hostCaptionLines,
  type StudioClip,
  type StudioProject,
  type StudioSettings,
} from "../shared/studio";
import { runFfmpeg } from "./media";

const assTime = (s: number) =>
  timecode(s, true)
    .slice(0, -1)
    .replace(/^0(?=\d:)/, "");
// ASS override syntax must never be accepted from subtitles or live chat.
export const assText = (s: string) =>
  s
    .replace(/\\/g, "＼")
    .replace(/\{/g, "｛")
    .replace(/\}/g, "｝")
    .replace(/[\r\n]+/g, " ");
export function makeAss(
  project: StudioProject,
  clip: StudioClip,
  settings: StudioSettings,
): string {
  const alpha = Math.round((1 - settings.danmakuOpacity) * 255)
    .toString(16)
    .padStart(2, "0");
  const head = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Caption,Microsoft YaHei,48,&H00FFFFFF,&H00FFFFFF,&H00111111,&H80000000,-1,0,0,0,100,100,0,0,1,2.5,1,2,80,80,54,1\nStyle: Chat,Microsoft YaHei,${settings.danmakuSize},&H${alpha}FFFFFF,&H00FFFFFF,&H${alpha}111111,&H80000000,-1,0,0,0,100,100,0,0,1,1.5,0,7,0,0,0,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const rows: string[] = [];
  if (settings.burnSubtitles)
    for (const l of hostCaptionLines(clip.subtitles))
      if (l.text.trim())
        rows.push(
          `Dialogue: 1,${assTime(l.startSec - clip.startSec)},${assTime(l.endSec - clip.startSec)},Caption,,0,0,0,,${assText(stripCaptionPunctuation(l.text))}`,
        );
  if (settings.burnDanmaku)
    for (const c of scheduleChat(project.chat, settings.danmakuSize)) {
      if (c.endSec <= clip.startSec || c.startSec >= clip.endSec) continue;
      const start = Math.max(c.startSec, clip.startSec),
        end = Math.min(c.endSec, clip.endSec);
      const x = (t: number) =>
        Math.round(1920 - ((t - c.startSec) / 9) * (1920 + c.width));
      const y = 28 + c.lane * (settings.danmakuSize + 16);
      rows.push(
        `Dialogue: 0,${assTime(start - clip.startSec)},${assTime(end - clip.startSec)},Chat,,0,0,0,,{\\q2\\move(${x(start)},${y},${x(end)},${y},0,${Math.round((end - start) * 1000)})}${assText(c.text)}`,
      );
    }
  return head + rows.join("\n") + "\n";
}
export function encodingArgs(settings: StudioSettings): string[] {
  return [
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    ...(settings.quality === "bitrate"
      ? [
          "-b:v",
          `${settings.bitrateMbps}M`,
          "-maxrate",
          `${settings.bitrateMbps * 1.3}M`,
          "-bufsize",
          `${settings.bitrateMbps * 2}M`,
        ]
      : ["-crf", String({ auto: 20, small: 25, high: 17 }[settings.quality])]),
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
  ];
}
export async function renderClip(
  project: StudioProject,
  source: string,
  clip: StudioClip,
  settings: StudioSettings,
  dir: string,
  signal: AbortSignal,
  progress: (seconds: number) => void,
): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const stem =
    clip.title
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
      .replace(/[ .]+$/g, "")
      .slice(0, 75) || clip.id;
  const files = [
    `${stem}.mp4`,
    `${stem}.srt`,
    `${stem}-字幕上下文.csv`,
    `${stem}-上下文.json`,
  ];
  await writeFile(
    join(dir, "overlay.ass"),
    makeAss(project, clip, settings),
    "utf8",
  );
  const height =
    settings.resolution === "source"
      ? project.height
      : Math.min(project.height, Number(settings.resolution));
  const filters = [`scale=-2:${Math.floor(height / 2) * 2}`];
  if (settings.burnSubtitles || settings.burnDanmaku)
    filters.push("ass=overlay.ass");
  await runFfmpeg(
    [
      "-ss",
      String(clip.startSec),
      "-i",
      source,
      "-t",
      String(clip.endSec - clip.startSec),
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-vf",
      filters.join(","),
      ...encodingArgs(settings),
      "-movflags",
      "+faststart",
      "-progress",
      "pipe:1",
      "render.partial.mp4",
    ],
    { cwd: dir, signal, progress },
  );
  await rename(join(dir, "render.partial.mp4"), join(dir, files[0]));
  await writeFile(
    join(dir, files[1]),
    subtitleFile(hostCaptionLines(clip.subtitles), clip.startSec),
    "utf8",
  );
  const cell = (value: unknown) => {
    let s = String(value ?? "");
    if (/^[=+@-]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const csv = [
    [
      "原片入点",
      "原片出点",
      "片内入点",
      "ASR原文",
      "校核字幕",
      "人工已核",
      "原有疑点",
      "上一句",
      "下一句",
      "说话人",
      "进入字幕",
      "归属依据",
    ],
    ...clip.subtitles.map((l, i) => [
      timecode(l.startSec, true),
      timecode(l.endSec, true),
      timecode(l.startSec - clip.startSec, true),
      l.raw,
      stripCaptionPunctuation(l.text),
      l.reviewed ? "是" : "否",
      l.correctionReason,
      clip.subtitles[i - 1]?.text ?? "",
      clip.subtitles[i + 1]?.text ?? "",
      l.speakerRole ?? "unknown",
      l.speakerRole === "host" ? "是" : "否",
      l.speakerReason ?? "未分类",
    ]),
  ];
  await writeFile(
    join(dir, files[2]),
    "\ufeff" + csv.map((row) => row.map(cell).join(",")).join("\r\n"),
    "utf8",
  );
  await writeFile(
    join(dir, files[3]),
    JSON.stringify(
      {
        clip,
        settings,
        interest: project.interests.find((i) => i.id === clip.interestId),
        background: { title: project.title, streamer: project.streamer },
        chat: project.chat.filter(
          (c) => c.startSec >= clip.startSec && c.startSec < clip.endSec,
        ),
      },
      null,
      2,
    ),
  );
  return files;
}
