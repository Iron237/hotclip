import { describe, expect, it } from "vitest";
import { clampWindow, zoomWindow } from "../../shared/timeline-window";
describe("timeline viewport", () => {
  it("keeps the time under the cursor fixed while zooming", () => {
    const before: [number, number] = [100, 200];
    const after = zoomWindow(before, 0.25, 0.2, 1000);
    expect(after).toEqual([115, 140]);
    expect(after[0] + (after[1] - after[0]) * 0.2).toBe(120);
  });
  it("clamps panning at the recording limits without shrinking the viewport", () => {
    expect(clampWindow(-20, 50, 1000)).toEqual([0, 50]);
    expect(clampWindow(990, 50, 1000)).toEqual([950, 1000]);
    expect(zoomWindow([100, 200], 1000, 0.5, 1000)).toEqual([0, 1000]);
    const v = zoomWindow([100, 200], 0.00001, 0.5, 1000);
    expect(v[1] - v[0]).toBe(1);
  });
});
