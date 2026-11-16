import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { exportSelectedClips, validateSelectedClips } from "../selected-clips";
import { exportClips } from "../export";
import { transcribeCached } from "../pipeline";
import { transcriptPage } from "../transcript-page";
import { handleMcpMessage } from "../../mcp/protocol";
import type { Transcript } from "../../shared/api-types";

vi.mock("../probe", () => ({ probeMedia: vi.fn(async () => ({ durationSec: 60 })) }));
vi.mock("../export", () => ({
  sanitizeFilename: (s: string) => s,
  exportClips: vi.fn(async () => [{ id: 1, title: "topic", path: "/out/1.mp4", durationSec: 10.5, sizeBytes: 1, qa: { status: "warn", issues: ["quiet"] } }]),
}));
vi.mock("../pipeline", () => ({ transcribeCached: vi.fn() }));

const transcript: Transcript = { engine: "test", language: "zh", durationSec: 60, segments: [
  { id: 1, startSec: 1.25, endSec: 3.75, text: "开头", words: [{ text: "开头", startSec: 1.25, endSec: 3.75 }] },
  { id: 2, startSec: 9.125, endSec: 11.75, text: "回应", words: [{ text: "回应", startSec: 9.125, endSec: 11.75 }] },
] };

describe("calling-agent selection", () => {
  let dir: string;
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv("HOTCLIP_LLM_BASE_URL", "");
    vi.stubEnv("HOTCLIP_LLM_MODEL", "");
    vi.mocked(transcribeCached).mockResolvedValue(transcript);
    dir = await mkdtemp(join(tmpdir(), "hotclip-selected-test-"));
  });
  afterEach(async () => { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

  it.each([
    [], [{ title: "", startSec: 1, endSec: 2 }], [{ title: "x", startSec: -1, endSec: 2 }],
    [{ title: "x", startSec: 2, endSec: 2 }], [{ title: "x", startSec: 5, endSec: 61 }],
    [{ title: "x", startSec: NaN, endSec: 2 }], [{ title: "x", startSec: "1", endSec: 2 }],
  ])("rejects invalid/unsupported source ranges: %j", (...items) => {
    expect(() => validateSelectedClips(items, 60)).toThrow();
  });

  it("exports exact agent bounds and captions without an LLM, keeping pauses and QA warnings", async () => {
    const selected = [{ title: "topic", startSec: 1.25, endSec: 11.75, reason: "setup and reply" }];
    const result = await exportSelectedClips(join(dir, "source.mp4"), selected, { modelsRoot: dir, cacheDir: dir, fontsDir: dir, outDir: join(dir, "out") });
    expect(exportClips).toHaveBeenCalledWith(expect.any(String), [expect.objectContaining({ startSec: 1.25, endSec: 11.75, manualBounds: true, words: transcript.segments.flatMap((s) => s.words) })], join(dir, "out"), expect.objectContaining({ vertical: false, jumpCut: false, cleanFillers: false, qaRepair: false, subtitleFile: true }));
    expect(result).toMatchObject({ llmUsed: false, selections: selected, warnings: [{ id: 1, issues: ["quiet"] }] });
    expect(JSON.parse(await readFile(join(dir, "out", "selection.json"), "utf8")).selectionSource).toBe("calling-agent");
  });

  it("rejects nonempty output before ASR or rendering and preserves existing files", async () => {
    await writeFile(join(dir, "keep.txt"), "keep");
    await expect(exportSelectedClips(join(dir, "source.mp4"), [{ title: "x", startSec: 0, endSec: 2 }], { modelsRoot: dir, cacheDir: dir, fontsDir: dir, outDir: dir })).rejects.toThrow("非空");
    expect(transcribeCached).not.toHaveBeenCalled();
    expect(exportClips).not.toHaveBeenCalled();
    expect(await readFile(join(dir, "keep.txt"), "utf8")).toBe("keep");
  });

  it("skips ASR only when captions are explicitly disabled", async () => {
    await exportSelectedClips(join(dir, "source.mp4"), [{ title: "x", startSec: 0, endSec: 2 }], { modelsRoot: dir, cacheDir: dir, fontsDir: dir, outDir: join(dir, "out"), captions: false });
    expect(transcribeCached).not.toHaveBeenCalled();
  });
});

it("paginates transcript boundaries without rounding or silently dropping the rest", () => {
  const page = transcriptPage(transcript, 0, 1);
  expect(page).toMatchObject({ nextOffset: 1, totalSegments: 2, segments: [{ startSec: 1.25, endSec: 3.75, text: "开头" }] });
  expect(transcriptPage(transcript, 1, 1).nextOffset).toBeNull();
  expect(() => transcriptPage(transcript, -1)).toThrow();
  expect(() => transcriptPage(transcript, 0, 101)).toThrow();
});

it("MCP refuses non-array clips before dispatch", async () => {
  const execute = vi.fn();
  const result = await handleMcpMessage({ id: 1, method: "tools/call", params: { name: "export_selected_clips", arguments: { videoPath: "/v.mp4", clips: "bad" } } }, execute, "test");
  expect(result).toMatchObject({ result: { isError: true } });
  expect(execute).not.toHaveBeenCalled();
});
