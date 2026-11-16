import { spawn } from "child_process";
import { existsSync } from "fs";
import { mkdtemp, readFile, writeFile, rm } from "fs/promises";
import { join } from "path";
import { homedir, tmpdir } from "os";
import { CHAT_MODELS } from "./chat-review";

/** Uses the user's existing Codex login. Never substitutes a different model. */
export async function codexReview(prompt: string, schema: unknown, kind: "subtitle" | "visual" = "subtitle", images: string[] = [], signal?: AbortSignal) {
  if (prompt.length > 240_000 || images.length > 8) throw new Error("codex-review:input-limit");
  const temp = await mkdtemp(join(tmpdir(), "hotclip-review-"));
  const output = join(temp, "result.json"), schemaFile = join(temp, "schema.json");
  await writeFile(schemaFile, JSON.stringify(schema));
  const cli = process.env.HOTCLIP_CODEX_JS ?? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "npm/node_modules/@openai/codex/bin/codex.js");
  const executable = process.env.HOTCLIP_CODEX_BIN ?? (existsSync(cli) ? process.execPath : "codex");
  const prefix = !process.env.HOTCLIP_CODEX_BIN && existsSync(cli) ? [cli] : [];
  const args = [...prefix, "exec", "--ignore-user-config", "--model", CHAT_MODELS[kind], "-c", 'model_reasoning_effort="high"',
    "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "--color", "never", "--output-schema", schemaFile, "--output-last-message", output,
    ...images.flatMap(file => ["--image", file]), "-"];
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, args, { cwd: temp, stdio: ["pipe", "ignore", "pipe"], windowsHide: true, signal });
      let log = "";
      const timer = setTimeout(() => { child.kill(); reject(new Error("codex-review:timeout")); }, 900_000);
      child.stderr.on("data", data => { log = (log + data.toString()).slice(-4000); });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`codex-review:exit-${code}: ${log}`)); });
      child.stdin.on("error", () => {});
      child.stdin.end(prompt);
    });
    return JSON.parse(await readFile(output, "utf8")) as unknown;
  } finally { await rm(temp, { recursive: true, force: true }); }
}
