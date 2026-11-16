import type { Transcript } from "../shared/api-types";

/** Bounded, exact-second transcript pages for the calling agent's own selection. */
export function transcriptPage(transcript: Transcript, offset: unknown = 0, limit: unknown = 50) {
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) throw new Error("offset 必须为非负整数");
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("limit 必须为 1–100 的整数");
  const segments = transcript.segments.slice(offset, offset + limit).map((s) => ({
    startSec: s.startSec, endSec: s.endSec, text: s.text,
  }));
  const next = offset + segments.length;
  return {
    engine: transcript.engine, language: transcript.language, durationSec: transcript.durationSec,
    totalSegments: transcript.segments.length, offset,
    nextOffset: next < transcript.segments.length ? next : null,
    segments,
  };
}
