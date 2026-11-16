import data from "../../resources/lexicons/zh-streaming.json";
import type { Transcript } from "../shared/api-types";

interface Rule { wrong: string; right: string; mode: string; require?: string; exclude?: string; note?: string }
export interface LexiconHit {
  segmentId: number; startSec: number; endSec: number; wrong: string; right: string;
  profile: string; status: "corrected" | "review"; reason: string;
}

export function checkDomainLexicon(input: Transcript, profiles: string[] = []) {
  const rules: Array<Rule & { profile: string }> = [];
  for (const profile of new Set(profiles)) {
    if (!Object.hasOwn(data.profiles, profile)) throw new Error(`未知词库: ${profile}`);
    const pack = data.profiles[profile as keyof typeof data.profiles];
    rules.push(...pack.rules.map((r) => ({ ...r, profile })));
  }
  const audit: LexiconHit[] = [];
  const segments = input.segments.map((segment) => {
    let text = segment.text;
    let words = segment.words.map((word) => ({ ...word }));
    for (const rule of rules) {
      let pos = 0;
      while ((pos = text.indexOf(rule.wrong, pos)) !== -1) {
        const context = text.slice(Math.max(0, pos - 24), pos + rule.wrong.length + 24);
        const eligible = rule.mode === "context" && rule.require && new RegExp(rule.require).test(context)
          && !(rule.exclude && new RegExp(rule.exclude).test(context));
        // Equal-length substitutions can retain every original word timestamp.
        const aligned = words.map((w) => w.text).join("") === text && rule.wrong.length === rule.right.length;
        const corrected = Boolean(eligible && aligned);
        audit.push({ segmentId: segment.id, startSec: segment.startSec, endSec: segment.endSec,
          wrong: rule.wrong, right: rule.right, profile: rule.profile,
          status: corrected ? "corrected" : "review",
          reason: corrected ? "用户确认的错词，局部语境匹配；保留原始词时间" : rule.note ?? "候选写法；需要语境或回听确认，未自动改写" });
        if (corrected) {
          text = text.slice(0, pos) + rule.right + text.slice(pos + rule.wrong.length);
          let cursor = 0;
          words = words.map((w) => {
            const out = { ...w, text: text.slice(cursor, cursor + w.text.length) };
            cursor += w.text.length;
            return out;
          });
        }
        pos += rule.wrong.length;
      }
    }
    return { ...segment, text, words };
  });
  return { transcript: { ...input, segments }, audit, version: data.version };
}
