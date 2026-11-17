import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
export const ffmpeg = require("ffmpeg-static") as string;
export function runFfmpeg(
  args: string[],
  options: {
    cwd?: string;
    signal?: AbortSignal;
    progress?: (seconds: number) => void;
    child?: (p: ChildProcess) => void;
  } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, ["-hide_banner", "-nostdin", "-y", ...args], {
      cwd: options.cwd,
      windowsHide: true,
      signal: options.signal,
    });
    options.child?.(p);
    let error = "",
      pending = "";
    p.stderr.on("data", (b) => {
      error = (error + b).slice(-5000);
    });
    p.stdout.on("data", (b) => {
      pending += b.toString();
      const rows = pending.split("\n");
      pending = rows.pop() ?? "";
      for (const row of rows) {
        const m = row.match(/^out_time_us=(\d+)/);
        if (m) options.progress?.(Number(m[1]) / 1e6);
      }
    });
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(error || `FFmpeg exited ${code}`)),
    );
  });
}
export function byteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (!m[1] && !m[2])) throw new Error("Invalid range");
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1]
    ? m[2]
      ? Math.min(Number(m[2]), size - 1)
      : size - 1
    : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start >= size ||
    start > end
  )
    throw new Error("Unsatisfiable range");
  return { start, end };
}
export async function serveFile(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
  type: string,
  download?: string,
): Promise<void> {
  const info = await stat(file);
  let range: ReturnType<typeof byteRange>;
  try {
    range = byteRange(req.headers.range, info.size);
  } catch {
    res.writeHead(416, { "Content-Range": `bytes */${info.size}` });
    res.end();
    return;
  }
  res.setHeader("Content-Type", type);
  res.setHeader("Accept-Ranges", "bytes");
  if (!res.hasHeader("Cache-Control"))
    res.setHeader("Cache-Control", "private, max-age=3600");
  if (download)
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(download)}`,
    );
  if (range) {
    res.statusCode = 206;
    res.setHeader(
      "Content-Range",
      `bytes ${range.start}-${range.end}/${info.size}`,
    );
  }
  res.setHeader(
    "Content-Length",
    range ? range.end - range.start + 1 : info.size,
  );
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = createReadStream(file, range ?? undefined);
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}
