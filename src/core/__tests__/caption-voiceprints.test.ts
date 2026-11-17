import { describe, expect, it } from "vitest";
import { validateVoiceAssignments } from "../caption-voiceprints";
describe("voiceprint fusion coverage", () => {
  const a = { id: "a", role: "host", reason: "音频与互动支持" };
  const b = { id: "b", role: "unknown", reason: "重叠话语未分开" };
  it("rejects omissions, duplicates, invented IDs and unsupported roles before publication", () => {
    for (const invalid of [
      [a],
      [a, a],
      [a, { ...b, id: "outside-context" }],
      [a, { ...b, role: "probably-host" }],
      [a, null],
    ]) {
      expect(() =>
        validateVoiceAssignments(invalid, ["a", "b"], true),
      ).toThrow();
    }
    expect(() =>
      validateVoiceAssignments([a, { ...b, reason: "" }], ["a", "b"], true),
    ).toThrow();
  });
  it("allows unresolved overlapping speech without inventing a forced speaker choice", () => {
    expect(validateVoiceAssignments([b, a], ["a", "b"], true)).toEqual([b, a]);
  });
});
