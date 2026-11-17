import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile, writeFile, mkdir, rename, stat } from "node:fs/promises";
import { resolve, join, basename } from "node:path";
import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import {
  defaultStudioSettings,
  validateDraft,
  type StudioProject,
  type StudioDraft,
  type StudioJob,
} from "../shared/studio";
import { runFfmpeg, serveFile } from "./media";
import { renderClip } from "./render";
import { attachWordTimings, segmentCaptions } from "./captions";
import { alignCaptions } from "./align-captions";
import {
  applySpeakerRoles,
  loadSpeakerRoles,
  hydrateDraftRoles,
} from "./caption-speakers";

interface Loaded {
  root: string;
  source: string;
  project: StudioProject;
  preview: {
    status: "preparing" | "ready" | "failed";
    progress: number;
    error?: string;
  };
  previewFile: string;
  jobs: StudioJob[];
  tasks: Map<string, AbortController>;
  thumbs: Map<number, Promise<string>>;
  thumbQueue: Promise<void>;
  draftLock: Promise<void>;
  alignment: { busy: boolean; done: number; total: number };
}
const readJson = async (p: string) => JSON.parse(await readFile(p, "utf8"));
async function atomicJson(file: string, value: unknown) {
  const temp = file + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(value, null, 2));
  await rename(temp, file);
}
function send(res: ServerResponse, code: number, data: unknown) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}
async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const b of req) {
    size += b.length;
    if (size > 12 * 1024 * 1024) throw new Error("请求过大");
    chunks.push(b);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
async function exists(p: string) {
  return stat(p).then(
    () => true,
    () => false,
  );
}

export async function loadStudioProject(root: string): Promise<Loaded> {
  root = resolve(root);
  const [source, selected, lines, danmaku] = await Promise.all([
    readJson(join(root, "source.json")),
    readJson(join(root, "selection", "interest-candidates.json")),
    readJson(join(root, "audit", "reviewed-lines.json")),
    readJson(join(root, "audit", "danmaku.json")).catch((e) => {
      if (e.code === "ENOENT") return { events: [], background: {} };
      throw e;
    }),
  ]);
  const sourcePath = resolve(root, source.videoPath);
  const info = await stat(sourcePath);
  if (source.size && source.size !== info.size)
    throw new Error(`源视频大小与分析数据不一致：${root}`);
  const store = join(root, "studio");
  await mkdir(store, { recursive: true });
  const draftFile = join(store, "draft.json");
  const roles = await loadSpeakerRoles(root, lines);
  const attributedLines = lines.map((l: any) => applySpeakerRoles(l, roles));
  const storedDraft: StudioDraft = (await exists(draftFile))
    ? await readJson(draftFile)
    : { revision: 0, clips: [], settings: { ...defaultStudioSettings } };
  const draft = hydrateDraftRoles(storedDraft, roles);
  validateDraft(draft, source.media.durationSec);
  const id = createHash("sha256").update(root).digest("hex").slice(0, 12);
  const project: StudioProject = {
    id,
    title: danmaku.background?.title || basename(root),
    streamer:
      danmaku.background?.streamerName ||
      danmaku.background?.streamer ||
      "未标注主播",
    ...source.media,
    interests: selected.items.map((i: any) => ({
      id: i.id,
      title: i.candidate?.title || i.marker?.label || i.title || i.id,
      origin: i.source || (i.id.startsWith("M") ? "用户标记" : "自动发现"),
      startSec: i.bounds?.startSec ?? null,
      endSec: i.bounds?.endSec ?? null,
      markerSec: i.marker?.sec ?? i.bounds?.startSec ?? 0,
      why: i.candidate?.why || i.markerExplanation || "",
      notes: [
        ...(i.candidate?.notes || []),
        ...(i.notes || []),
        ...(i.markerExplanation ? [i.markerExplanation] : []),
      ],
      needsReview:
        i.bounds?.boundaryReview ||
        i.status !== "matched" ||
        !!i.bounds?.uncertainIds?.length,
    })),
    lines: await readJson(join(root, "asr-raw.json"))
      .then((asr) =>
        segmentCaptions(attachWordTimings(attributedLines, asr.segments)),
      )
      .catch((e) => {
        if (e.code === "ENOENT") return attributedLines;
        throw e;
      }),
    chat: danmaku.events
      .filter((e: any) => e.kind === "chat" && Number.isFinite(e.startSec))
      .map((e: any) => ({ id: e.id, startSec: e.startSec, text: e.text })),
    draft,
    outputDirectory: join(store, "exports"),
  };
  const jobsFile = join(store, "jobs.json");
  const jobs: StudioJob[] = (await exists(jobsFile))
    ? await readJson(jobsFile)
    : [];
  for (const j of jobs)
    if (j.status === "running" || j.status === "queued") {
      j.status = "failed";
      j.message = "服务重启中断了任务，请重新导出";
    }
  await atomicJson(jobsFile, jobs);
  const signature = createHash("sha256")
    .update(`${sourcePath}:${info.size}:${info.mtimeMs}`)
    .digest("hex")
    .slice(0, 16);
  const previewFile = join(store, `preview-${signature}.mp4`);
  const loaded: Loaded = {
    root,
    source: sourcePath,
    project,
    preview: { status: "preparing", progress: 0 },
    previewFile,
    jobs,
    tasks: new Map(),
    thumbs: new Map(),
    thumbQueue: Promise.resolve(),
    draftLock: Promise.resolve(),
    alignment: { busy: false, done: 0, total: 0 },
  };
  if (await exists(previewFile))
    loaded.preview = { status: "ready", progress: 1 };
  return loaded;
}

export async function startStudio(
  roots: string[],
  port = 8767,
  options: { dev?: boolean; webRoot?: string } = {},
) {
  const projects = await Promise.all(roots.map(loadStudioProject));
  const token = randomUUID();
  const controllers = new Set<AbortController>();
  let shuttingDown = false;
  let exportQueue: Promise<void> = Promise.resolve();
  const vite = options.dev
    ? await (
        await import("vite")
      ).createServer({
        configFile: resolve("vite.studio.config.ts"),
        server: { middlewareMode: true },
      })
    : null;
  const tasks: Promise<unknown>[] = [];
  for (const p of projects)
    if (p.preview.status !== "ready") {
      const controller = new AbortController();
      controllers.add(controller);
      const partial = p.previewFile.replace(".mp4", ".partial.mp4");
      tasks.push(
        runFfmpeg(
          [
            "-i",
            p.source,
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            "-progress",
            "pipe:1",
            partial,
          ],
          {
            signal: controller.signal,
            progress: (s) => {
              p.preview.progress = Math.min(0.98, s / p.project.durationSec);
            },
          },
        )
          .then(async () => {
            await rename(partial, p.previewFile);
            p.preview = { status: "ready", progress: 1 };
          })
          .catch((e) => {
            p.preview = { status: "failed", progress: 0, error: String(e) };
          })
          .finally(() => controllers.delete(controller)),
      );
    }
  const persistJobs = (p: Loaded) =>
    atomicJson(join(p.root, "studio", "jobs.json"), p.jobs);
  const server = createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    try {
      const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!allowedHosts.includes(req.headers.host || "")) {
        send(res, 403, { error: "只允许本机访问" });
        return;
      }
      const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
      const mutate = !["GET", "HEAD"].includes(req.method || "");
      if (mutate) {
        const origin = req.headers.origin;
        const supplied = String(req.headers["x-studio-token"] || "");
        if (
          (origin && !allowedHosts.some((h) => origin === `http://${h}`)) ||
          supplied.length !== token.length ||
          !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
        ) {
          send(res, 403, { error: "会话已过期，请刷新页面" });
          return;
        }
        if (
          !(req.headers["content-type"] || "").startsWith("application/json")
        ) {
          send(res, 415, { error: "需要 JSON" });
          return;
        }
      }
      if (url.pathname === "/api/projects" && req.method === "GET") {
        send(res, 200, {
          token,
          projects: projects.map((p) => ({
            id: p.project.id,
            title: p.project.title,
            streamer: p.project.streamer,
            durationSec: p.project.durationSec,
          })),
        });
        return;
      }
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] === "api" && parts[1] === "projects") {
        const p = projects.find((p) => p.project.id === parts[2]);
        if (!p) {
          send(res, 404, { error: "项目不存在" });
          return;
        }
        const route = parts[3];
        if (route === "alignment" && req.method === "GET") {
          send(res, 200, p.alignment);
          return;
        }
        if (route === "alignment" && req.method === "POST") {
          const value = await body(req);
          validateDraft(value, p.project.durationSec);
          if (
            value.clips.length !== 1 ||
            value.clips[0].endSec - value.clips[0].startSec > 1800
          )
            throw new Error("请选择一个不超过 30 分钟的切片");
          if (p.alignment.busy) {
            send(res, 409, { error: "音频对齐正在进行" });
            return;
          }
          p.alignment = { busy: true, done: 0, total: 0 };
          const controller = new AbortController();
          controllers.add(controller);
          res.on("close", () => {
            if (!res.writableEnded) controller.abort();
          });
          try {
            const lines = await alignCaptions(
              p.source,
              p.root,
              value.clips[0],
              p.project.durationSec,
              controller.signal,
              (done, total) => {
                p.alignment = { busy: true, done, total };
              },
            );
            send(res, 200, { lines });
          } finally {
            p.alignment.busy = false;
            controllers.delete(controller);
          }
          return;
        }
        if (!route && req.method === "GET") {
          send(res, 200, p.project);
          return;
        }
        if (route === "preview" && req.method === "GET") {
          send(res, 200, p.preview);
          return;
        }
        if (route === "media" && ["GET", "HEAD"].includes(req.method!)) {
          if (p.preview.status !== "ready") {
            send(res, 503, p.preview);
            return;
          }
          await serveFile(req, res, p.previewFile, "video/mp4");
          return;
        }
        if (route === "thumbnail" && ["GET", "HEAD"].includes(req.method!)) {
          const t = Number(url.searchParams.get("time"));
          if (!Number.isFinite(t) || t < 0 || t >= p.project.durationSec)
            throw new Error("缩略图时间无效");
          const second = Math.floor(t);
          const file = join(p.root, "studio", `thumb-${second}.jpg`);
          if (!(await exists(file))) {
            if (!p.thumbs.has(second)) {
              const task = p.thumbQueue
                .then(() =>
                  runFfmpeg([
                    "-ss",
                    String(second),
                    "-i",
                    p.source,
                    "-frames:v",
                    "1",
                    "-vf",
                    "scale=384:-2",
                    "-q:v",
                    "3",
                    file,
                  ]),
                )
                .then(() => file)
                .finally(() => p.thumbs.delete(second));
              p.thumbs.set(second, task);
              p.thumbQueue = task.then(
                () => {},
                () => {},
              );
            }
            await p.thumbs.get(second);
          }
          await serveFile(req, res, file, "image/jpeg");
          return;
        }
        if (route === "draft" && req.method === "PUT") {
          const draft = await body(req);
          validateDraft(draft, p.project.durationSec);
          const update = p.draftLock.then(async () => {
            if (draft.revision !== p.project.draft.revision) {
              send(res, 409, { error: "另一个页面修改了项目，请刷新后继续" });
              return;
            }
            const next = { ...draft, revision: draft.revision + 1 };
            await atomicJson(join(p.root, "studio", "draft.json"), next);
            p.project.draft = next;
            send(res, 200, { revision: next.revision });
          });
          p.draftLock = update.catch(() => {});
          await update;
          return;
        }
        if (route === "jobs" && req.method === "GET" && !parts[4]) {
          send(
            res,
            200,
            p.jobs.map(({ clips, settings, ...j }) => j),
          );
          return;
        }
        if (route === "jobs" && req.method === "POST" && !parts[4]) {
          const value = await body(req);
          validateDraft(value, p.project.durationSec);
          if (!value.clips.length) throw new Error("请先添加切片");
          if (p.jobs.some((j) => ["running", "queued"].includes(j.status))) {
            send(res, 409, { error: "已有导出任务运行，请等待完成或取消" });
            return;
          }
          const job: StudioJob = {
            id: randomUUID(),
            projectId: p.project.id,
            status: "queued",
            progress: 0,
            message: "等待导出",
            createdAt: new Date().toISOString(),
            files: [],
            clips: structuredClone(value.clips),
            settings: structuredClone(value.settings),
          };
          const controller = new AbortController();
          p.tasks.set(job.id, controller);
          controllers.add(controller);
          p.jobs.unshift(job);
          await persistJobs(p);
          const work = exportQueue.then(async () => {
            try {
              if (controller.signal.aborted || shuttingDown) {
                job.status = "cancelled";
                job.message = "已取消";
                return;
              }
              job.status = "running";
              await persistJobs(p);
              const total = job.clips.reduce(
                (n, c) => n + c.endSec - c.startSec,
                0,
              );
              let done = 0;
              for (const [index, clip] of job.clips.entries()) {
                if (controller.signal.aborted) throw new Error("Cancelled");
                const folder = String(index + 1).padStart(2, "0");
                job.message = `正在导出 ${index + 1}/${job.clips.length} · ${clip.title}`;
                const files = await renderClip(
                  p.project,
                  p.source,
                  clip,
                  job.settings,
                  join(p.project.outputDirectory, job.id, folder),
                  controller.signal,
                  (seconds) => {
                    job.progress = Math.min(0.99, (done + seconds) / total);
                  },
                );
                for (const name of files)
                  job.files.push({
                    name: `${folder} · ${name}`,
                    url: `/api/projects/${p.project.id}/jobs/${job.id}/files/${folder}/${encodeURIComponent(name)}`,
                  });
                done += clip.endSec - clip.startSec;
                await persistJobs(p);
              }
              job.status = "completed";
              job.progress = 1;
              job.message = "导出完成 · 视频、SRT 和上下文对照已保存";
            } catch (e) {
              job.status = controller.signal.aborted ? "cancelled" : "failed";
              job.message = controller.signal.aborted
                ? "已取消，已完成的文件仍可下载"
                : String(e);
            } finally {
              p.tasks.delete(job.id);
              controllers.delete(controller);
              await persistJobs(p);
            }
          });
          exportQueue = work.catch((e) =>
            console.error("Job persistence error", e),
          );
          tasks.push(exportQueue);
          send(res, 202, { id: job.id });
          return;
        }
        if (
          route === "jobs" &&
          parts[5] === "cancel" &&
          req.method === "POST"
        ) {
          const c = p.tasks.get(parts[4]);
          if (!c) throw new Error("任务已结束");
          c.abort();
          send(res, 200, { ok: true });
          return;
        }
        if (
          route === "jobs" &&
          parts[5] === "files" &&
          ["GET", "HEAD"].includes(req.method!)
        ) {
          const job = p.jobs.find((j) => j.id === parts[4]);
          const artifact = job?.files.find((f) => f.url === url.pathname);
          if (!job || !artifact) {
            send(res, 404, { error: "文件不存在或尚未完成" });
            return;
          }
          const name = decodeURIComponent(parts[7]);
          await serveFile(
            req,
            res,
            join(p.project.outputDirectory, job.id, parts[6], name),
            name.endsWith(".mp4") ? "video/mp4" : "application/octet-stream",
            name,
          );
          return;
        }
        send(res, 404, { error: "接口不存在" });
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        send(res, 404, { error: "接口不存在" });
        return;
      }
      if (vite) {
        vite.middlewares(req, res);
        return;
      }
      const webRoot = resolve(options.webRoot || "dist-studio");
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const file = resolve(webRoot, relative || "index.html");
      if (!file.startsWith(webRoot + "/") && !file.startsWith(webRoot + "\\")) {
        send(res, 403, { error: "路径无效" });
        return;
      }
      if (!(await exists(file))) {
        send(res, 404, { error: "页面不存在，请运行 pnpm studio:build" });
        return;
      }
      if (file.endsWith(".html")) res.setHeader("Cache-Control", "no-store");
      await serveFile(
        req,
        res,
        file,
        file.endsWith(".js")
          ? "text/javascript"
          : file.endsWith(".css")
            ? "text/css"
            : "text/html",
      );
    } catch (e) {
      if (!res.headersSent)
        send(res, 400, { error: e instanceof Error ? e.message : String(e) });
      else res.destroy();
    }
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolveListen);
  });
  console.log(
    `HotClip Studio: http://127.0.0.1:${port} · ${projects.length} project(s)`,
  );
  return {
    server,
    projects,
    close: async () => {
      shuttingDown = true;
      controllers.forEach((c) => c.abort());
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await Promise.allSettled(tasks);
      await vite?.close();
    },
  };
}
