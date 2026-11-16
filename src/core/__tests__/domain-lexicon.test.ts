import { expect, it } from "vitest";
import { checkDomainLexicon } from "../domain-lexicon";
import type { Transcript } from "../../shared/api-types";
function sample(text: string): Transcript {
  return { engine: "test", language: "zh", durationSec: 30, segments: [{ id: 1, startSec: 0, endSec: text.length,
    text, words: Array.from(text).map((text, i) => ({ text, startSec: i, endSec: i + 1 })) }] };
}
it("corrects the confirmed subscription phrase while retaining all word times and raw input", () => {
  const raw = sample("念了给你上剑，不用上剑啊");
  const result = checkDomainLexicon(raw, ["bili-live"]);
  expect(result.transcript.segments[0].text).toBe("念了给你上舰，不用上舰啊");
  expect(result.audit.map((a) => a.status)).toEqual(["corrected", "corrected"]);
  expect(result.transcript.segments[0].words.map((w) => [w.startSec, w.endSec])).toEqual(raw.segments[0].words.map((w) => [w.startSec, w.endSec]));
  expect(raw.segments[0].text).toContain("上剑");
});
it("does not change sword usage, ambiguous names or ordinary 本身", () => {
  for (const text of ["给你上剑法这个技能", "角色本身很好", "这一幕是别离"]) {
    const r = checkDomainLexicon(sample(text), ["bili-live", "endfield"]);
    expect(r.transcript.segments[0].text).toBe(text);
    expect(r.audit.every((a) => a.status === "review")).toBe(true);
  }
});
it("requires opt-in and refuses unknown profiles", () => {
  expect(checkDomainLexicon(sample("给你上剑")).audit).toEqual([]);
  expect(() => checkDomainLexicon(sample("test"), ["bad"])).toThrow();
});
it("corrects confirmed natural-voice phrases without changing ordinary 本身", () => {
  for (const text of ["只把这个声音留在游戏里，所以就是其实它不算是我的本身。", "但是我可以呃可以用本身说一句，谢谢大家。"]) {
    const raw = sample(text);
    const result = checkDomainLexicon(raw, ["bili-live"]);
    expect(result.transcript.segments[0].text).toBe(text.replace("本身", "本声"));
    expect(result.transcript.segments[0].words.map(w => [w.startSec, w.endSec])).toEqual(raw.segments[0].words.map(w => [w.startSec, w.endSec]));
  }
  expect(checkDomainLexicon(sample("游戏本身很好，声音也很好"), ["bili-live"]).transcript.segments[0].text).toBe("游戏本身很好，声音也很好");
});
it("does not invent word alignment if original word text differs", () => {
  const t = sample("给你上剑"); t.segments[0].words = [];
  const r = checkDomainLexicon(t, ["bili-live"]);
  expect(r.transcript.segments[0].text).toBe("给你上剑");
  expect(r.audit[0].status).toBe("review");
});
