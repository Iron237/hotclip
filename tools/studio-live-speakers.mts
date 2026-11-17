import { chromium, expect } from "@playwright/test";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { subtitleFile } from "../src/shared/studio";
import assert from "node:assert/strict";
const base = process.argv[2] ?? "http://127.0.0.1:8767";
const registry = await (await fetch(base + "/api/projects")).json();
const project = await (
  await fetch(base + "/api/projects/" + registry.projects[0].id)
).json();
const host = project.lines.find(
  (l: any) =>
    l.speakerRole === "host" && l.startSec > 10118 && l.endSec < 10123,
);
const game = project.lines.find(
  (l: any) => l.speakerRole === "game" && l.endSec - l.startSec > 0.8,
);
const unknown = project.lines.find(
  (l: any) => l.speakerRole === "unknown" && l.endSec - l.startSec > 0.8,
);
const baseline = JSON.parse(
  await readFile(
    join(
      project.outputDirectory,
      "..",
      "voiceprints",
      "semantic-baseline.json",
    ),
    "utf8",
  ),
);
const formerlyUnknown = new Set(
  baseline.items.filter((l: any) => l.role === "unknown").map((l: any) => l.id),
);
const recovered = project.lines.find(
  (l: any) =>
    l.speakerRole === "host" &&
    l.speakerBasis === "voiceprint-context" &&
    (l.sourceIds ?? [l.id]).some((id: string) => formerlyUnknown.has(id)),
);
assert.ok(
  host && game && unknown && recovered,
  "requires completed real-source role analysis",
);
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1080 },
  });
  await page.goto(base);
  await expect
    .poll(() => page.locator("video").evaluate((v) => v.readyState), {
      timeout: 30000,
    })
    .toBeGreaterThanOrEqual(2);
  for (const cue of [game, unknown, host, recovered]) {
    const sec = (cue.startSec + cue.endSec) / 2;
    await page
      .getByRole("slider", { name: "全片播放位置" })
      .evaluate((el, sec) => {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )!.set!.call(el, String(sec));
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }, sec);
    await expect
      .poll(
        () =>
          page
            .locator("video")
            .evaluate(
              (v, t) => !v.seeking && Math.abs(v.currentTime - t) < 0.03,
              sec,
            ),
        { timeout: 30000 },
      )
      .toBe(true);
    if (cue.speakerRole === "host")
      await expect(page.locator(".caption-overlay")).toHaveText(cue.text);
    else await expect(page.locator(".caption-overlay")).toHaveCount(0);
  }
  const vtt = await page
    .locator("track")
    .evaluate(async (t) => fetch(t.src).then((r) => r.text()));
  const cueBody = (l: any) =>
    subtitleFile([l], 0, true).split("\n").slice(3).join("\n").trim();
  assert.ok(vtt.includes(cueBody(host)));
  assert.ok(vtt.includes(cueBody(recovered)));
  assert.ok(!vtt.includes(cueBody(game)));
  assert.ok(!vtt.includes(cueBody(unknown)));
  const after = await (
    await fetch(base + "/api/projects/" + project.id)
  ).json();
  assert.deepEqual(after.draft, project.draft);
  await writeFile(
    "studio-test-results/live-speakers-receipt.json",
    JSON.stringify(
      {
        success: true,
        examples: [host, game, unknown, recovered].map(
          ({ text, startSec, speakerRole }: any) => ({
            text,
            startSec,
            speakerRole,
          }),
        ),
        draftUnchanged: true,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS · real source host shown, game/unknown hidden, VTT filtered, draft unchanged",
  );
} finally {
  await browser.close();
}
