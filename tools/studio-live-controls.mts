import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
const base = process.argv[2] ?? "http://127.0.0.1:8767";
const registry = await (await fetch(base + "/api/projects")).json();
const api = base + "/api/projects/" + registry.projects[0].id;
const before = await (await fetch(api)).json();
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1100 },
  });
  const page = await context.newPage();
  await page.route("**/draft", (route) => route.abort());
  await page.route("**/jobs", (route) =>
    route.request().method() === "POST" ? route.abort() : route.continue(),
  );
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await expect
    .poll(() => page.locator("video").evaluate((v) => v.readyState), {
      timeout: 30000,
    })
    .toBeGreaterThanOrEqual(2);
  await page.locator(".interest-card").filter({ hasText: "· M08" }).click();
  const track = page.locator(".trim-track");
  const view = async () => [
    Number(await track.getAttribute("data-low")),
    Number(await track.getAttribute("data-high")),
  ];
  const startHandle = page.getByRole("slider", { name: "入点拨钮" });
  const start = Number(await startHandle.inputValue());
  const end = Number(
    await page.getByRole("slider", { name: "出点拨钮" }).inputValue(),
  );
  for (let i = 0; i < 6; i++)
    await page.getByRole("button", { name: "放大时间轴" }).click();
  await page.getByRole("button", { name: "定位入点", exact: true }).click();
  const zoomed = await view();
  assert.ok(zoomed[1] - zoomed[0] < 5);
  await startHandle.scrollIntoViewIfNeeded();
  const box = (await startHandle.boundingBox())!;
  const bounds = (await track.boundingBox())!;
  const x =
    bounds.x + ((start - zoomed[0]) / (zoomed[1] - zoomed[0])) * bounds.width;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.keyboard.down("Shift");
  await page.mouse.down();
  await page.mouse.move(x + 60, y, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  const changed = Number(await startHandle.inputValue());
  const expected = (60 / bounds.width) * (zoomed[1] - zoomed[0]) * 0.1;
  assert.ok(
    Math.abs(changed - start - expected) < 0.003,
    "fine drag uses frozen viewport and tenth speed",
  );
  assert.deepEqual(await view(), zoomed, "release must not move viewport");
  await page.keyboard.press("Shift+ArrowRight");
  assert.ok(
    Math.abs(Number(await startHandle.inputValue()) - changed - 0.001) < 0.0001,
  );
  const beforeModeSwitch = Number(await startHandle.inputValue());
  const nextX =
    bounds.x +
    ((beforeModeSwitch - zoomed[0]) / (zoomed[1] - zoomed[0])) * bounds.width;
  await page.mouse.move(nextX, y);
  await page.mouse.down();
  await page.mouse.move(nextX + 20, y, { steps: 4 });
  const coarse = Number(await startHandle.inputValue());
  await page.keyboard.down("Shift");
  await page.mouse.move(nextX + 40, y, { steps: 4 });
  const fine = Number(await startHandle.inputValue());
  await page.mouse.up();
  await page.keyboard.up("Shift");
  assert.ok(
    fine > coarse,
    "entering fine mode mid-drag must not jump backward",
  );
  assert.ok(
    Math.abs(fine - coarse - (coarse - beforeModeSwitch) * 0.1) < 0.003,
  );
  const pan = page.getByRole("button", { name: "平移时间轴", exact: true });
  await pan.focus();
  await page.keyboard.press("ArrowRight");
  assert.ok((await view())[0] > zoomed[0]);
  const current = Number(await startHandle.inputValue());
  const panBox = (await pan.boundingBox())!;
  await page.mouse.move(panBox.x + panBox.width * 0.75, panBox.y + 15);
  await page.mouse.down();
  await page.mouse.move(panBox.x + panBox.width * 0.65, panBox.y + 15, {
    steps: 5,
  });
  await page.mouse.up();
  assert.ok(
    Math.abs(Number(await startHandle.inputValue()) - current) < 0.001,
    "panning must not edit the in point (native range step rounding)",
  );
  const beforeWheel = await view();
  await page.mouse.wheel(0, -200);
  await expect
    .poll(async () => {
      const v = await view();
      return v[1] - v[0];
    })
    .toBeLessThan(beforeWheel[1] - beforeWheel[0]);
  await page.getByRole("button", { name: "适合选段", exact: true }).click();
  assert.equal(
    Number(await page.getByRole("slider", { name: "出点拨钮" }).inputValue()),
    end,
  );
  // Global keys operate the actual source clock, not a UI time counter.
  await page.locator(".trim-heading strong").click();
  const clock = await page.locator("video").evaluate((v) => v.currentTime);
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() => page.locator("video").evaluate((v) => v.currentTime))
    .toBeCloseTo(clock + 5, 2);
  await page.keyboard.press("Space");
  await expect
    .poll(() => page.locator("video").evaluate((v) => v.paused))
    .toBe(false);
  await page.keyboard.press("Space");
  await expect
    .poll(() => page.locator("video").evaluate((v) => v.paused))
    .toBe(true);
  await page.keyboard.press("f");
  await expect
    .poll(() => page.evaluate(() => !!document.fullscreenElement))
    .toBe(true);
  await page.keyboard.press("f");
  await expect
    .poll(() => page.evaluate(() => !!document.fullscreenElement))
    .toBe(false);
  await page.getByText("播放快捷键", { exact: true }).click();
  await page.getByLabel("启用播放快捷键").uncheck();
  await page.locator(".trim-heading strong").click();
  const pausedClock = await page
    .locator("video")
    .evaluate((v) => v.currentTime);
  await page.keyboard.press("k");
  assert.equal(await page.locator("video").evaluate((v) => v.paused), true);
  assert.equal(
    await page.locator("video").evaluate((v) => v.currentTime),
    pausedClock,
  );
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  assert.deepEqual(
    axe.violations.map((v) => v.id),
    [],
  );
  await mkdir("studio-test-results", { recursive: true });
  await page.screenshot({
    path: "studio-test-results/live-controls.png",
    fullPage: true,
  });
  assert.deepEqual((await (await fetch(api)).json()).draft, before.draft);
  assert.deepEqual(errors, []);
  await writeFile(
    "studio-test-results/live-controls-receipt.json",
    JSON.stringify(
      {
        success: true,
        draftUnchanged: true,
        sourceSpan: end - start,
        zoomedSpan: zoomed[1] - zoomed[0],
        fineDragDelta: changed - start,
        keyboardPlayback: true,
        fullscreen: true,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS · real recording zoom, pan, precision drag, playback keys, fullscreen, accessibility; draft unchanged",
  );
} finally {
  await browser.close();
}
