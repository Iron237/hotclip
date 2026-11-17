import { mkdir, writeFile, stat, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { runFfmpeg } from "../src/studio-server/media.js";
import { startStudio } from "../src/studio-server/server.js";
const root = join(tmpdir(), "hotclip-studio-smoke-" + randomUUID()),
  screenshots = resolve("studio-test-results");
await mkdir(join(root, "audit"), { recursive: true });
await mkdir(join(root, "selection"));
await mkdir(screenshots, { recursive: true });
const source = join(root, "source.mp4");
await runFfmpeg([
  "-f",
  "lavfi",
  "-i",
  "color=c=0x182b3a:size=960x540:rate=25:duration=12",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=440:duration=12",
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  "-c:a",
  "aac",
  "-shortest",
  source,
]);
await writeFile(
  join(root, "source.json"),
  JSON.stringify({
    videoPath: source,
    size: (await stat(source)).size,
    media: {
      durationSec: 12,
      width: 960,
      height: 540,
      fps: 25,
      bitRate: 1000000,
    },
  }),
);
await writeFile(
  join(root, "selection", "interest-candidates.json"),
  JSON.stringify({
    items: [
      {
        id: "M01",
        source: "用户标记",
        candidate: {
          title: "测试完整话题",
          why: "验证实际入出点、字幕修改与弹幕渲染",
          notes: ["测试素材，不是用户选择"],
        },
        bounds: { startSec: 2, endSec: 8 },
        marker: { sec: 3 },
        status: "matched",
      },
      {
        id: "M02",
        marker: { sec: 10, label: "未定位标记" },
        status: "unmatched",
      },
    ],
  }),
);
await writeFile(
  join(root, "audit", "reviewed-lines.json"),
  JSON.stringify([
    {
      id: "s1",
      startSec: 2,
      endSec: 4,
      raw: "上剑啦，",
      text: "上舰啦",
      uncertain: true,
      correctionReason: "终末地词库校核",
    },
    {
      id: "s2",
      startSec: 4,
      endSec: 7,
      raw: "这是我的本身。",
      text: "这是我的本声",
      uncertain: false,
      correctionReason: "",
    },
  ]),
);
await writeFile(
  join(root, "audit", "danmaku.json"),
  JSON.stringify({
    background: { title: "交互验收 · 测试素材", streamerName: "测试主播" },
    events: [
      { id: "d1", kind: "chat", startSec: 1, text: "这是一条直播弹幕" },
      { id: "d2", kind: "chat", startSec: 3, text: "完整话题留下来了" },
    ],
  }),
);
const port = 8879,
  base = `http://127.0.0.1:${port}`;
const studio = await startStudio([root], port);
const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1080 },
});
const page = await context.newPage();
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(base);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("选片段");
  await expect(page.locator("video")).toHaveAttribute("src", /media/, {
    timeout: 60000,
  });
  await page.getByRole("button", { name: "精确设置入点", exact: true }).click();
  await page.getByLabel("原片时间 · HH:MM:SS.mmm").fill("00:00:02.500");
  await page.getByRole("button", { name: "设置并跳转" }).click();
  await expect(page.getByRole("slider", { name: "入点拨钮" })).toHaveValue(
    "2.5",
  );
  const handle = page.getByRole("slider", { name: "入点拨钮" });
  await handle.scrollIntoViewIfNeeded();
  const handleBox = (await handle.boundingBox())!;
  const handleMin = Number(await handle.getAttribute("min"));
  const handleMax = Number(await handle.getAttribute("max"));
  const handleX = handleBox.x + 7 + ((2.5 - handleMin) / (handleMax - handleMin)) * (handleBox.width - 14);
  await page.mouse.move(handleX, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleX + 30, handleBox.y + handleBox.height / 2, { steps: 5 });
  await page.mouse.up();
  assert.ok(Number(await handle.inputValue()) > 2.5, "native handle should drag");
  await page.getByRole("button", { name: "精确设置入点", exact: true }).click();
  await page.getByLabel("原片时间 · HH:MM:SS.mmm").fill("00:00:02.500");
  await page.getByRole("button", { name: "设置并跳转" }).click();
  await page.getByRole("slider", { name: "入点拨钮" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("slider", { name: "入点拨钮" })).toHaveValue(
    "2.51",
  );
  await page.getByRole("button", { name: "精确设置出点", exact: true }).click();
  await page.getByLabel("原片时间 · HH:MM:SS.mmm").fill("00:00:07.500");
  await page.getByRole("button", { name: "设置并跳转" }).click();
  await page.getByRole("button", { name: "加入输出列表", exact: true }).click();
  await expect(page.locator(".queue-row")).toHaveCount(1);
  await page.getByRole("button", { name: "试听结尾", exact: true }).click();
  await expect
    .poll(
      () =>
        page
          .locator("video")
          .evaluate((v) => v.paused && Math.abs(v.currentTime - 7.5) < 0.02),
      { timeout: 10000 },
    )
    .toBe(true);
  await expect(page.locator(".save-state")).toContainText("已保存");
  await page.reload();
  await expect(page.locator(".queue-row")).toHaveCount(1);
  await expect
    .poll(() => page.locator("video").evaluate((v) => v.readyState), {
      timeout: 15000,
    })
    .toBeGreaterThanOrEqual(2);
  await page.screenshot({
    path: join(screenshots, "01-select.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "审核字幕", exact: true }).click();
  await page
    .getByRole("textbox", { name: "字幕 s1", exact: true })
    .fill("上舰啦，测试！");
  await page
    .locator(".subtitle-row")
    .first()
    .getByRole("button", { name: "确认此句" })
    .click();
  await expect(
    page.getByRole("textbox", { name: "字幕 s1", exact: true }),
  ).toHaveValue("上舰啦测试");
  await expect(page.locator(".save-state")).toContainText("已保存");
  await page.screenshot({
    path: join(screenshots, "02-review.png"),
    fullPage: true,
  });
  const reviewAxe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  assert.deepEqual(reviewAxe.violations.map(v => v.id), []);
  await page.getByRole("button", { name: "导出设置", exact: true }).click();
  await page.getByRole("checkbox", { name: /渲染直播弹幕/ }).check();
  await page.screenshot({
    path: join(screenshots, "03-export.png"),
    fullPage: true,
  });
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  await writeFile(
    join(screenshots, "accessibility.json"),
    JSON.stringify(axe.violations, null, 2),
  );
  assert.deepEqual(
    axe.violations.map(
      (v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`,
    ),
    [],
  );
  await page.getByRole("button", { name: "开始导出 1 个片段" }).click();
  await expect(page.locator(".job-head")).toContainText("已完成", {
    timeout: 60000,
  });
  await expect(page.locator(".download-list a")).toHaveCount(4);
  const registry = await (await fetch(base + "/api/projects")).json();
  const id = registry.projects[0].id;
  const response = await fetch(`${base}/api/projects/${id}/media`, {
    headers: { Range: "bytes=0-99" },
  });
  assert.equal(response.status, 206);
  assert.equal((await response.arrayBuffer()).byteLength, 100);
  assert.equal(
    (
      await fetch(`${base}/api/projects/${id}/draft`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
    403,
  );
  const data = await (await fetch(`${base}/api/projects/${id}`)).json();
  const put = (draft: any) =>
    fetch(`${base}/api/projects/${id}/draft`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Studio-Token": registry.token,
      },
      body: JSON.stringify(draft),
    });
  const both = await Promise.all([put(data.draft), put(data.draft)]);
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 409]);
  assert.equal(
    (
      await put({
        ...data.draft,
        clips: [{ ...data.draft.clips[0], startSec: -1 }],
      })
    ).status,
    400,
  );
  const jobs = await (await fetch(`${base}/api/projects/${id}/jobs`)).json();
  const srtResponse = await fetch(
    base + jobs[0].files.find((f: any) => f.name.endsWith(".srt")).url,
  );
  assert.equal(
    srtResponse.headers.get("content-type"),
    "application/octet-stream",
  );
  const srt = await srtResponse.text();
  assert.ok(srt.includes("上舰啦测试"));
  assert.ok(!srt.includes("，"));
  const videoArtifact = jobs[0].files.find((f: any) => f.name.endsWith(".mp4"));
  assert.ok((await fetch(base + videoArtifact.url, { method: "HEAD" })).ok);
  const outputPath = join(
    root,
    "studio",
    "exports",
    jobs[0].id,
    "01",
    "测试完整话题.mp4",
  );
  await runFfmpeg([
    "-ss",
    "1",
    "-i",
    outputPath,
    "-frames:v",
    "1",
    join(screenshots, "rendered-frame.png"),
  ]);
  const ass = await readFile(
    join(root, "studio", "exports", jobs[0].id, "01", "overlay.ass"),
    "utf8",
  );
  assert.ok(ass.includes("上舰啦测试"));
  assert.ok(ass.includes("\\move("));
  const post = await fetch(`${base}/api/projects/${id}/jobs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Studio-Token": registry.token,
    },
    body: JSON.stringify(data.draft),
  });
  assert.equal(post.status, 202);
  const cancelled = await post.json();
  assert.equal(
    (
      await fetch(`${base}/api/projects/${id}/jobs/${cancelled.id}/cancel`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Studio-Token": registry.token,
        },
        body: "{}",
      })
    ).status,
    200,
  );
  await expect
    .poll(
      async () =>
        (await (await fetch(`${base}/api/projects/${id}/jobs`)).json()).find(
          (j: any) => j.id === cancelled.id,
        ).status,
    )
    .toBe("cancelled");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: join(screenshots, "04-mobile.png"),
    fullPage: true,
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    "mobile horizontal overflow",
  );
  assert.deepEqual(errors, []);
  await writeFile(
    join(screenshots, "receipt.json"),
    JSON.stringify(
      {
        root,
        rendered: outputPath,
        checks: [
          "precise time + keyboard slider",
          "audition stops at out point",
          "draft persists reload",
          "editable punctuationless subtitles",
          "export + download",
          "range requests",
          "CSRF guard",
          "revision conflict",
          "boundary validation",
          "ASS subtitles and chat",
          "cancellation",
          "axe export screen",
          "mobile layout",
          "no browser errors",
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS · Studio browser, API and actual FFmpeg export smoke test",
    root,
  );
} finally {
  await browser.close();
  await studio.close();
}
