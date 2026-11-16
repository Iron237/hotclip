/** Small stdio client for smoke checks and clients that have not refreshed MCP yet.
 * node tools/mcp-call.mjs --list
 * node tools/mcp-call.mjs TOOL args.json [result.json]
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const [name, argsPath, outputPath] = process.argv.slice(2);
if (!name || (name !== "--list" && !argsPath)) throw new Error("Usage: mcp-call.mjs --list | TOOL args.json [result.json]");
const args = argsPath ? JSON.parse(await readFile(argsPath, "utf8")) : {};
const child = spawn(process.execPath, [resolve(root, "node_modules/tsx/dist/cli.mjs"), resolve(root, "src/mcp/server.ts")], {
  cwd: root, stdio: ["pipe", "pipe", "inherit"], windowsHide: true,
});
const pending = new Map();
let id = 0;
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  try {
    const msg = JSON.parse(line);
    const request = pending.get(msg.id);
    if (request) { pending.delete(msg.id); msg.error ? request.reject(new Error(msg.error.message)) : request.resolve(msg.result); }
  } catch { process.stderr.write(`Unexpected MCP stdout: ${line.slice(0, 200)}\n`); }
});
const fail = (error) => { for (const p of pending.values()) p.reject(error); pending.clear(); };
child.on("error", fail);
child.on("exit", (code) => fail(new Error(`MCP server exited: ${code}`)));
const timer = setTimeout(() => { fail(new Error("MCP request timed out after 30 minutes")); child.kill(); }, 30 * 60 * 1000);
const request = (method, params) => new Promise((resolvePromise, reject) => {
  pending.set(++id, { resolve: resolvePromise, reject });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
try {
  await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "hotclip-smoke", version: "1" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const result = await request(name === "--list" ? "tools/list" : "tools/call", name === "--list" ? {} : { name, arguments: args });
  const json = JSON.stringify(result, null, 2) + "\n";
  if (outputPath) { await writeFile(outputPath, json, "utf8"); process.stdout.write(`${resolve(outputPath)}\n`); }
  else process.stdout.write(json);
  if (result.isError) process.exitCode = 1;
} finally {
  clearTimeout(timer); lines.close(); child.stdin.end(); child.kill();
}
