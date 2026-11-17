import { startStudio } from "../src/studio-server/server.js";
const args = process.argv.slice(2);
const roots = args.filter((a) => !a.startsWith("--"));
if (!roots.length)
  throw new Error(
    "用法：pnpm studio <已分析录播目录> [更多目录] [--dev] [--port=8767]",
  );
const port = Number(
  args.find((a) => a.startsWith("--port="))?.split("=")[1] || 8767,
);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("端口无效");
const studio = await startStudio(roots, port, { dev: args.includes("--dev") });
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void studio.close().then(() => process.exit(0));
  });
