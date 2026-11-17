import { describe, expect, it } from "vitest";
import {
  clipLines,
  defaultStudioSettings,
  parseTimecode,
  scheduleChat,
  subtitleFile,
  timecode,
  validateDraft,
  visibleChat,
  resizeClip,
  editClipLine,
  replaceClipCaptions,
} from "../../shared/studio";
import { byteRange } from "../../studio-server/media";
import { assText, encodingArgs } from "../../studio-server/render";
import { makeAss } from "../../studio-server/render";
import { segmentCaptions } from "../../studio-server/captions";
import type { StudioLine, StudioProject } from "../../shared/studio";
describe("studio boundary and media contracts", () => {
  const cue = (
    id: string,
    startSec: number,
    endSec: number,
    text: string,
  ): StudioLine => ({
    id,
    startSec,
    endSec,
    text,
    raw: text,
    uncertain: false,
    correctionReason: "",
  });
  it("preserves manual timing and text through repeated trim/expand and reload", () => {
    const lines = [cue("a", 10, 12, "前一句"), cue("b", 12, 16, "后一句")];
    let clip = resizeClip(lines, undefined, {
      id: "clip",
      title: "test",
      startSec: 10,
      endSec: 16,
    });
    clip = editClipLine(clip, "b", { startSec: 12.5, text: "修改过的后一句" });
    clip = resizeClip(lines, clip, { ...clip, startSec: 13, endSec: 15 });
    expect(clip.subtitles[0].startSec).toBe(13);
    clip = resizeClip(lines, JSON.parse(JSON.stringify(clip)), {
      ...clip,
      startSec: 9,
      endSec: 17,
    });
    expect(clip.subtitles.map((l) => l.id)).toEqual(["a", "b"]);
    expect(clip.subtitles[1]).toMatchObject({
      startSec: 12.5,
      endSec: 16,
      text: "修改过的后一句",
    });
  });
  it("trims actual words instead of displaying removed speech at a new in point", () => {
    const line = {
      ...cue("a", 10, 14, "今天上舰啦"),
      words: [
        { text: "今天", startSec: 10, endSec: 11 },
        { text: "上舰", startSec: 12, endSec: 13 },
        { text: "啦", startSec: 13, endSec: 14 },
      ],
    };
    expect(clipLines([line], 11.5, 13)[0]).toMatchObject({
      text: "上舰",
      startSec: 12,
      endSec: 13,
    });
    expect(clipLines([line], 12.3, 14)[0].boundaryPartial).toBe(true);
    expect(clipLines([line], 14, 12)).toEqual([]);
  });
  it("keeps excluded subtitle tails when realigning a cropped interval", () => {
    const line = {
      ...cue("a", 10, 14, "今天上舰啦"),
      words: [
        { text: "今天", startSec: 10, endSec: 11 },
        { text: "上舰", startSec: 12, endSec: 13 },
        { text: "啦", startSec: 13, endSec: 14 },
      ],
    };
    let clip = resizeClip([line], undefined, {
      id: "clip",
      title: "test",
      startSec: 11.5,
      endSec: 13,
    });
    clip = replaceClipCaptions(clip, [cue("aligned", 12, 13, "上舰")]);
    clip = resizeClip([line], JSON.parse(JSON.stringify(clip)), {
      ...clip,
      startSec: 10,
      endSec: 14,
    });
    expect(clip.subtitles.map((l) => l.text).join("")).toBe("今天上舰啦");
    expect(() =>
      validateDraft(
        { revision: 0, clips: [clip], settings: defaultStudioSettings },
        20,
      ),
    ).not.toThrow();
  });
  it("confirming or editing a cropped cue does not erase its excluded words", () => {
    const original = {
      ...cue("a", 0, 3, "一二三"),
      words: [
        { text: "一", startSec: 0, endSec: 1 },
        { text: "二", startSec: 1, endSec: 2 },
        { text: "三", startSec: 2, endSec: 3 },
      ],
    };
    const clip = resizeClip([original], undefined, {
      id: "c",
      title: "t",
      startSec: 1,
      endSec: 3,
    });
    const confirmed = editClipLine(clip, "a", { text: "二三", reviewed: true });
    expect(
      resizeClip([original], confirmed, { ...clip, startSec: 0 })
        .subtitles.map((l) => l.text)
        .join(""),
    ).toBe("一二三");
    const edited = editClipLine(clip, "a", { text: "两三" });
    expect(
      resizeClip([original], edited, { ...clip, startSec: 0 })
        .subtitles.map((l) => l.text)
        .join(""),
    ).toBe("一两三");
  });
  it("joins artificial ASR breaks, respects acoustic silence and preserves every word", () => {
    const lines = [
      cue("a", 0, 1, "是我们所有。"),
      cue("b", 1, 2, "人共同努力的果。"),
      cue("c", 4, 5, "谢谢大家"),
    ].map((l) => {
      const chars = Array.from(l.text.replace(/[。]/g, ""));
      return {
        ...l,
        words: chars.map((text, i) => ({
          text,
          startSec: l.startSec + (i * (l.endSec - l.startSec)) / chars.length,
          endSec:
            l.startSec + ((i + 1) * (l.endSec - l.startSec)) / chars.length,
          timingSource: "aligned",
        })),
      };
    });
    const captions = segmentCaptions(lines);
    expect(captions[0].text).toBe("是我们所有人共同努力的果");
    expect(captions.map((c) => c.text).join("")).toBe(
      "是我们所有人共同努力的果谢谢大家",
    );
    expect(captions.at(-1)?.startSec).toBe(4);
  });
  it("exports crossing danmaku at its existing position without restarting at clip entry", () => {
    const project = {
      chat: [{ id: "d", startSec: 100, text: "跨入点弹幕" }],
    } as StudioProject;
    const clip = {
      id: "c",
      title: "t",
      startSec: 104,
      endSec: 108,
      subtitles: [cue("s", 105, 106, "字幕")],
    };
    const ass = makeAss(project, clip, {
      ...defaultStudioSettings,
      burnDanmaku: true,
    });
    expect(ass).toContain("0:00:01.00,0:00:02.00,Caption");
    const c = scheduleChat(project.chat, 34)[0],
      x = Math.round(1920 - (4 / 9) * (1920 + c.width));
    expect(ass).toContain(`\\move(${x},28,`);
    expect(subtitleFile(clip.subtitles, 104)).toContain(
      "00:00:01,000 --> 00:00:02,000",
    );
    expect(visibleChat([c], 105)[0].startSec).toBe(100);
  });
  it("rejects overlapping cues and corrupt source word timestamps", () => {
    const clip = {
      id: "c",
      title: "t",
      startSec: 0,
      endSec: 10,
      subtitles: [cue("a", 1, 4, "一"), cue("b", 3, 5, "二")],
    };
    expect(() =>
      validateDraft(
        { revision: 0, clips: [clip], settings: defaultStudioSettings },
        10,
      ),
    ).toThrow(/重叠/);
    expect(() =>
      validateDraft(
        {
          revision: 0,
          clips: [
            {
              ...clip,
              subtitles: [],
              subtitleSource: [
                {
                  ...cue("a", 1, 4, "一"),
                  words: [{ text: "一", startSec: 1, endSec: NaN }],
                },
              ],
            },
          ],
          settings: defaultStudioSettings,
        },
        10,
      ),
    ).toThrow(/字词/);
  });
  it("round trips millisecond times and rejects impossible clocks", () => {
    for (const n of [0, 2.123, 3600, 14750.598])
      expect(parseTimecode(timecode(n, true))).toBe(n);
    for (const s of ["1:60", "-1", "Infinity", "0.5:01", "1:1:1:1"])
      expect(parseTimecode(s)).toBeNull();
  });
  it("clamps subtitles to clip bounds while preserving numeric punctuation", () => {
    const lines = clipLines(
      [
        {
          id: "x",
          startSec: 1,
          endSec: 5,
          text: "你好，3.5！",
          raw: "你好3.5",
          uncertain: true,
          correctionReason: "",
        },
      ],
      2,
      4,
    );
    expect(lines[0]).toMatchObject({ startSec: 2, endSec: 4, text: "你好3.5" });
    expect(subtitleFile(lines, 2)).toContain(
      "00:00:00,000 --> 00:00:02,000\n你好3.5",
    );
    const draft = {
      revision: 0,
      clips: [
        { id: "clip", title: "test", startSec: 2, endSec: 4, subtitles: lines },
      ],
      settings: defaultStudioSettings,
    };
    expect(() => validateDraft(draft, 10)).not.toThrow();
    expect(() =>
      validateDraft(
        { ...draft, clips: [{ ...draft.clips[0], endSec: 3 }] },
        10,
      ),
    ).toThrow();
    expect(() =>
      validateDraft({ ...draft, clips: [draft.clips[0], draft.clips[0]] }, 10),
    ).toThrow();
  });
  it("supports seeking byte ranges without accepting malformed requests", () => {
    expect(byteRange("bytes=4-10", 8)).toEqual({ start: 4, end: 7 });
    expect(byteRange("bytes=-3", 8)).toEqual({ start: 5, end: 7 });
    expect(byteRange("bytes=2-", 8)).toEqual({ start: 2, end: 7 });
    for (const h of [
      "bytes=8-",
      "bytes=4-2",
      "bytes=0-1,3-4",
      "bytes=-0",
      "bytes=-",
    ])
      expect(() => byteRange(h, 8)).toThrow();
  });
  it("rebuilds seeked chat without overlap or stale off-screen messages", () => {
    const chat = Array.from({ length: 20 }, (_, i) => ({
      id: String(i),
      startSec: i,
      text: "测试",
    }));
    const cues = scheduleChat(chat, 34);
    expect(cues.filter((c) => c.startSec < 9)).toHaveLength(8);
    const visible = visibleChat(cues, 10);
    expect(visible.every((c) => c.startSec <= 10 && c.endSec > 10)).toBe(true);
    expect(new Set(visible.map((c) => c.lane)).size).toBe(visible.length);
    expect(visibleChat(cues, 1).map((c) => c.id)).toEqual(["0", "1"]);
    expect(visibleChat(cues, 100)).toEqual([]);
  });
  it("prevents subtitle ASS commands and uses actual selected encoding settings", () => {
    expect(assText("{\\pos(0,0)}\nhello")).toBe("｛＼pos(0,0)｝ hello");
    expect(encodingArgs(defaultStudioSettings)).toContain("20");
    expect(
      encodingArgs({
        ...defaultStudioSettings,
        quality: "bitrate",
        bitrateMbps: 3,
      }),
    ).toContain("3M");
  });
});
