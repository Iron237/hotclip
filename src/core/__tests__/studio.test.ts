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
} from "../../shared/studio";
import { byteRange } from "../../studio-server/media";
import { assText, encodingArgs } from "../../studio-server/render";
describe("studio boundary and media contracts", () => {
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
