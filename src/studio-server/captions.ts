import type { StudioLine } from "../shared/studio";
import {
  stripCaptionPunctuation,
  joinCaptionWords,
} from "../shared/caption-text";
import lexicon from "../../resources/lexicons/zh-streaming.json";
import { rebuildWords } from "../shared/edit-transcript";
import { refineWordTimings } from "../core/align";
import type { TranscriptWord } from "../shared/api-types";

type Word = NonNullable<StudioLine["words"]>[number];
type Segment = {
  startSec: number;
  endSec: number;
  text: string;
  words: TranscriptWord[];
};
const clean = (s: string) => stripCaptionPunctuation(s).replace(/\s+/g, "");

/** Reuse real acoustic anchors. Same-length homophone corrections keep their
 * positions; insertions/deletions are flagged until audio is aligned again. */
export function attachWordTimings(
  lines: StudioLine[],
  segments: Segment[],
): StudioLine[] {
  const byTime = new Map(segments.map((s) => [`${s.startSec}:${s.endSec}`, s]));
  return lines.map((l) => {
    const seg = byTime.get(`${l.startSec}:${l.endSec}`);
    if (!seg?.words.length) return { ...l, timingStatus: "needs-alignment" };
    const target = rebuildWords(l.text, l.startSec, l.endSec);
    const same =
      target.length === seg.words.length &&
      target.every(
        (w, i) => clean(w.text).length === clean(seg.words[i].text).length,
      );
    const words = same
      ? target.map((w, i) => ({ ...seg.words[i], text: w.text }))
      : refineWordTimings(target, seg.words).words;
    return {
      ...l,
      words,
      sourceIds: [l.id],
      timingStatus: words.every((w) => w.timingSource === "aligned")
        ? "aligned"
        : "needs-alignment",
    };
  });
}

interface Unit {
  word: Word;
  line: StudioLine;
  index: number;
  breakAfter: boolean;
}
/** Acoustic pauses are primary boundaries; punctuation is only a soft hint.
 * ICU lexical boundaries prevent splitting 本声/终末地 midway. Dynamic programming
 * balances whole phrases, 8–20 characters and ~1–6 seconds, across ASR windows. */
export function segmentCaptions(lines: StudioLine[]): StudioLine[] {
  const units: Unit[] = [];
  for (const line of lines) {
    if (!line.words?.length) continue;
    line.words.forEach((word, index) => {
      if (clean(word.text))
        units.push({ word, line, index, breakAfter: false });
    });
  }
  if (!units.length) return lines;
  // Preserve English spaces while testing boundaries against UTF-16 indices.
  const full = units.map((u) => stripCaptionPunctuation(u.word.text)).join("");
  const boundaries = new Set(
    Array.from(
      new Intl.Segmenter("zh", { granularity: "word" }).segment(full),
      (s) => s.index + s.segment.length,
    ),
  );
  const protectedTerms = Object.values(lexicon.profiles).flatMap((p) => [
    ...p.groups.flatMap((g) => g.terms),
    ...p.rules.map((r) => r.right),
  ]);
  for (const term of protectedTerms) {
    let at = full.indexOf(term);
    while (at >= 0) {
      for (let i = at + 1; i < at + term.length; i++) boundaries.delete(i);
      at = full.indexOf(term, at + term.length);
    }
  }
  let offset = 0;
  for (const u of units) {
    offset += stripCaptionPunctuation(u.word.text).length;
    u.breakAfter = boundaries.has(offset);
  }
  const chunks: Unit[][] = [];
  let current: Unit[] = [];
  for (const u of units) {
    const prev = current.at(-1);
    if (
      prev &&
      (u.word.startSec - prev.word.endSec >= 0.65 ||
        (u.line.speakerRole ?? "unknown") !==
          (prev.line.speakerRole ?? "unknown") ||
        u.word.startSec < prev.word.startSec ||
        current.length >= 400)
    ) {
      chunks.push(current);
      current = [];
    }
    current.push(u);
  }
  if (current.length) chunks.push(current);
  const out: StudioLine[] = [];
  for (const block of chunks) {
    const n = block.length,
      cost = Array<number>(n + 1).fill(Infinity),
      next = Array<number>(n).fill(n);
    cost[n] = 0;
    for (let i = n - 1; i >= 0; i--) {
      let length = 0,
        crossed = 0;
      for (let j = i; j < n && j < i + 40; j++) {
        if (
          j > i &&
          length >= 4 &&
          /[。！？!?；;]$/.test(block[j - 1].word.text)
        )
          crossed += 4;
        if (j > i) {
          const pause = block[j].word.startSec - block[j - 1].word.endSec;
          if (pause >= 0.28) crossed += pause * 8;
        }
        length += Array.from(clean(block[j].word.text)).length;
        const duration = block[j].word.endSec - block[i].word.startSec;
        if (j > i && (length > 24 || duration > 7)) break;
        const gap =
          j + 1 < n ? block[j + 1].word.startSec - block[j].word.endSec : 1;
        const punctuation = /[。！？!?；;]$/.test(block[j].word.text)
          ? 3
          : /[，,、]$/.test(block[j].word.text)
            ? 1.2
            : 0;
        const penalty =
          4 +
          crossed +
          Math.pow((length - 14) / 8, 2) +
          Math.max(0, 1 - duration) * 4 +
          (j + 1 < n && !block[j].breakAfter ? 18 : 0) +
          (j + 1 < n && /[的把被和与在从向给]$/.test(clean(block[j].word.text))
            ? 5
            : 0) -
          Math.min(0.6, Math.max(0, gap)) * 7 -
          punctuation;
        if (cost[j + 1] + penalty < cost[i]) {
          cost[i] = cost[j + 1] + penalty;
          next[i] = j + 1;
        }
      }
    }
    for (let i = 0; i < n;) {
      const j = next[i],
        group = block.slice(i, j),
        first = group[0],
        last = group.at(-1)!;
      const sources = [
        ...new Map(group.map((u) => [u.line.id, u.line])).values(),
      ];
      const uncertainTiming = group.some(
        (u) => u.word.timingSource !== "aligned",
      );
      out.push({
        id: `${first.line.id}-w${first.index}`,
        startSec: first.word.startSec,
        endSec: last.word.endSec,
        text: stripCaptionPunctuation(
          joinCaptionWords(group.map((u) => u.word)),
        ),
        raw: sources.map((l) => l.raw).join(" "),
        uncertain: sources.some((l) => l.uncertain) || uncertainTiming,
        correctionReason: sources
          .map((l) => l.correctionReason)
          .filter(Boolean)
          .join("；"),
        sourceIds: [...new Set(sources.flatMap((l) => l.sourceIds ?? [l.id]))],
        words: group.map((u) => ({ ...u.word })),
        timingStatus: uncertainTiming ? "needs-alignment" : "aligned",
        reviewed: false,
        speakerRole: first.line.speakerRole ?? "unknown",
        speakerBasis: sources.every((l) => l.speakerBasis === "manual")
          ? "manual"
          : sources.some((l) => l.speakerBasis === "semantic-context")
            ? "semantic-context"
            : "unclassified",
        speakerReason: [
          ...new Set(sources.map((l) => l.speakerReason).filter(Boolean)),
        ].join("；"),
      });
      i = j;
    }
  }
  // Unalignable imported cues remain visible and explicitly flagged, not dropped.
  return [
    ...out,
    ...lines
      .filter((l) => !l.words?.length)
      .map((l) => ({
        ...l,
        uncertain: true,
        timingStatus: "needs-alignment" as const,
      })),
  ].sort((a, b) => a.startSec - b.startSec);
}
