import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { validateDraft } from "../src/shared/studio";
const base = process.argv[2] ?? "http://127.0.0.1:8767";
const registry = await (await fetch(base + "/api/projects")).json();
const apiBase = base + "/api/projects/" + registry.projects[0].id;
const before = await (await fetch(apiBase)).json();
const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1080 },
});
const page = await context.newPage();
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
let localDraft: any;
// Ephemeral UI exercise: all writes to the user's draft are intercepted.
await page.route("**/draft", async (route) => {
  localDraft = route.request().postDataJSON();
  validateDraft(localDraft, before.durationSec);
  await route.fulfill({ json: { revision: localDraft.revision + 1 } });
});
await page.route("**/jobs", async (route) => {
  if (route.request().method() === "POST")
    throw new Error("This check must never export user media");
  await route.continue();
});
try {
  await page.goto(base);
  for (const [name, value] of [
    ["入点", "02:48:38.300"],
    ["出点", "02:48:49.700"],
  ]) {
    await page
      .getByRole("button", { name: "精确设置" + name, exact: true })
      .click();
    await page.getByLabel("原片时间 · HH:MM:SS.mmm").fill(value);
    await page.getByRole("button", { name: "设置并跳转" }).click();
  }
  await page.getByRole("button", { name: "加入输出列表", exact: true }).click();
  await page.getByRole("button", { name: "审核字幕", exact: true }).click();
  await page
    .getByRole("button", { name: "按原声对齐并重新断句", exact: true })
    .click();
  await expect(page.getByText(/原声对齐完成 ·/)).toBeVisible({
    timeout: 180000,
  });
  await expect(page.locator(".save-state")).toContainText("已保存");
  assert.ok(localDraft.clips.at(-1).subtitles.length >= 4);
  validateDraft(localDraft, before.durationSec);
  assert.equal(
    localDraft.clips
      .at(-1)
      .subtitles.map((l: any) => l.text)
      .join(""),
    "坏了小猫来了你不要在这个时候闯入我的世界啊小猫咪坏得很呐挡住我了可可走开",
  );
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  assert.deepEqual(
    axe.violations.map((v) => v.id),
    [],
  );
  await page.screenshot({
    path: "studio-test-results/live-sync-review.png",
    fullPage: true,
  });
  const after = await (await fetch(apiBase)).json();
  assert.deepEqual(after.draft, before.draft);
  assert.deepEqual(errors, []);
  await writeFile(
    "studio-test-results/live-sync-receipt.json",
    JSON.stringify(
      {
        success: true,
        draftUnchanged: true,
        captions: localDraft.clips.at(-1).subtitles,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS · real source / Qwen / browser alignment; user draft unchanged",
  );
} finally {
  await browser.close();
}
