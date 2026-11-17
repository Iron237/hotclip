/**
 * HotClip MCP Server 入口(stdio):
 *   npx tsx src/mcp/server.ts
 * 在 Claude Code / Claude Desktop 里注册后,Agent 可直接调用本地切片管线
 * (转写/找爆点/出片全在本机,素材不出电脑)。协议逻辑见 protocol.ts,
 * 管线实现与桌面端/录播监听共用 core/pipeline.ts。
 *
 * LLM 配置走环境变量:HOTCLIP_LLM_BASE_URL / HOTCLIP_LLM_MODEL /
 * HOTCLIP_LLM_API_KEY(本地 Ollama 端点可省 key)。
 * 模型与转写缓存目录与桌面 App 共享(下载一次两边都能用)。
 */
import { createInterface } from "readline";
import { join, basename } from "path";
import { transcribeCached, detectForPipeline, autoClip, analyzeReferenceVideo } from "../core/pipeline";
import type { ReferenceProfile } from "../core/reference";
import { loadGlossary } from "../core/glossary-store";
import { userDataDir, modelsRoot, cacheDir, renderCacheDir, evidenceCacheDir, llmFromEnv } from "../core/appenv";
import { loadReviewMemory } from "../core/review-memory";
import { loadPerformanceMemory } from "../core/performance-memory";
import { handleMcpMessage, type JsonRpcMessage } from "./protocol";
import { parseGenre } from "../core/genre";
import { isClipLength } from "../shared/detection-options";
import { exportSelectedClips } from "../core/selected-clips";
import { checkDomainLexicon } from "../core/domain-lexicon";
import { transcriptPage } from "../core/transcript-page";
import { clipChatVideo } from "../core/chat-clip";
import { structureRecording,validateBackground } from "../core/structure-recording";
import { readRecordingContext } from "../core/context-packets";

// MCP clients need not launch from the repository directory.
const fontsDir = join(__dirname, "../../resources/fonts");

function fmtClock(sec: number): string {
  const m = Math.floor(sec / 60);
  return `${String(m).padStart(2, "0")}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
}

function clampClips(n: unknown): number | undefined {
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(1, Math.min(12, Math.round(v))) : undefined;
}

/**
 * 参考画像(与 CLI --reference 同一语义):用户显式给的输入,分析失败要在
 * 回执里说清并按无参考继续,不静默丢。note 直接拼进工具回执开头。
 */
async function loadReference(refPath: unknown): Promise<{ profile?: ReferenceProfile; note: string }> {
  if (typeof refPath !== "string" || !refPath.trim()) return { note: "" };
  try {
    const p = await analyzeReferenceVideo(refPath, {
      modelsRoot: modelsRoot(),
      cacheDir: cacheDir(),
      evidenceCacheDir: evidenceCacheDir(),
      glossary: await loadGlossary(userDataDir()),
    });
    const cuts = p.cutsPerMin !== null ? `·镜头 ${p.cutsPerMin} 切/分` : "";
    const unit = p.zh ? "字" : "词";
    return {
      profile: p,
      note: `参考画像:时长 ${Math.round(p.durationSec)}s·语速 ${p.speechRate}${unit}/秒·句长 ${p.avgSentenceLen}${unit}${cuts}·钩子「${p.hookLine.slice(0, 20)}」\n`,
    };
  } catch (e) {
    return { note: `⚠ 对标视频分析失败,按无参考继续:${e instanceof Error ? e.message : String(e)}\n` };
  }
}

/** 工具实现:返回给 Agent 的文本。 */
async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  if(name==="read_recording_context")return JSON.stringify(await readRecordingContext(String(args.contextDir),{
    startSec:typeof args.startSec==="number"?args.startSec:undefined,endSec:typeof args.endSec==="number"?args.endSec:undefined,
    episodeId:typeof args.episodeId==="string"?args.episodeId:undefined,eventIds:args.eventIds as string[]|undefined,offset:typeof args.offset==="number"?args.offset:undefined,limit:typeof args.limit==="number"?args.limit:undefined,
  }));
  const videoPath = String(args.videoPath);
  if(name==="structure_recording")return JSON.stringify(await structureRecording(videoPath,{
    modelsRoot:modelsRoot(),cacheDir:cacheDir(),
    outDir:typeof args.outDir==="string"?args.outDir:undefined,danmakuPath:typeof args.danmakuPath==="string"?args.danmakuPath:undefined,
    danmakuOffsetSec:typeof args.danmakuOffsetSec==="number"?args.danmakuOffsetSec:undefined,danmakuScale:typeof args.danmakuScale==="number"?args.danmakuScale:undefined,
    background:validateBackground(args.background),visualTimes:args.visualTimes as number[]|undefined,
    resume:args.resume===true,
    maxInterests:typeof args.maxInterests==="number"?args.maxInterests:undefined,diarize:args.diarize!==false,
    subtitlePath:typeof args.subtitlePath==="string"?args.subtitlePath:undefined,
    asr:{engineId:"qwen3",localServiceUrl:typeof args.localServiceUrl==="string"?args.localServiceUrl:undefined},
  }));
  if (name === "clip_chat_video") {
    return JSON.stringify(await clipChatVideo(videoPath, {
      modelsRoot: modelsRoot(), cacheDir: cacheDir(), fontsDir, renderCacheDir: renderCacheDir(), evidenceCacheDir: evidenceCacheDir(),
      outDir: typeof args.outDir === "string" ? args.outDir : undefined,
      maxClips: typeof args.maxClips === "number" ? args.maxClips : undefined,
      brief: typeof args.brief === "string" ? args.brief : undefined,
      visualCheck: args.visualCheck === true, vertical: args.vertical === true, diarize: args.diarize !== false,
      subtitlePath: typeof args.subtitlePath === "string" ? args.subtitlePath : undefined,
      asr: { engineId: "qwen3", localServiceUrl: typeof args.localServiceUrl === "string" ? args.localServiceUrl : undefined },
    }));
  }
  if (args.lexiconProfiles !== undefined && (!Array.isArray(args.lexiconProfiles) || args.lexiconProfiles.some((p) => !["endfield", "bili-live"].includes(String(p))))) throw new Error("lexiconProfiles: endfield | bili-live");
  const lexiconProfiles = (args.lexiconProfiles ?? []) as string[];

  if (name === "transcribe_video") {
    const raw = await transcribeCached(videoPath, modelsRoot(), cacheDir(), await loadGlossary(userDataDir()), undefined, typeof args.subtitlePath === "string" ? args.subtitlePath : undefined, { engineId: typeof args.engineId === "string" ? args.engineId : undefined, localServiceUrl: typeof args.localServiceUrl === "string" ? args.localServiceUrl : undefined, restart: args.restart === true });
    const checked = checkDomainLexicon(raw, args.subtitlePath ? [] : lexiconProfiles);
    const t = checked.transcript;
    if (args.format === "json") return JSON.stringify({ ...transcriptPage(t, args.offset, args.limit), lexiconVersion: checked.version, lexiconAudit: checked.audit.filter((a) => t.segments.slice(Number(args.offset ?? 0), Number(args.offset ?? 0) + Number(args.limit ?? 50)).some((s) => s.id === a.segmentId)), ...(args.subtitlePath ? { timingNote: "导入字幕的句内字词时间为估算，需复核。" } : {}) });
    const lines = t.segments.map((s) => `[${fmtClock(s.startSec)}] ${s.text}`).join("\n");
    const capped = lines.length > 60_000 ? `${lines.slice(0, 60_000)}\n…(截断)` : lines;
    return `来源:${t.engine} 语言:${t.language} 时长:${fmtClock(t.durationSec)} 共 ${t.segments.length} 句\n${args.subtitlePath ? "已导入字幕;句内字词时间为估算,需复核。\n" : ""}${capped}${checked.audit.length ? "\n词库校核:" + JSON.stringify(checked.audit) : ""}`;
  }

  if (name === "export_selected_clips") {
    return JSON.stringify(await exportSelectedClips(videoPath, args.clips, {
      modelsRoot: modelsRoot(), cacheDir: cacheDir(), fontsDir, lexiconProfiles,
      glossary: await loadGlossary(userDataDir()),
      renderCacheDir: renderCacheDir(), evidenceCacheDir: evidenceCacheDir(),
      outDir: typeof args.outDir === "string" ? args.outDir : undefined,
      vertical: args.vertical === true, captions: args.captions !== false,
      subtitlePath: typeof args.subtitlePath === "string" ? args.subtitlePath : undefined,
      asr: { engineId: typeof args.engineId === "string" ? args.engineId : undefined, localServiceUrl: typeof args.localServiceUrl === "string" ? args.localServiceUrl : undefined },
    }));
  }

  if (name === "detect_highlights") {
    const llm = llmFromEnv();
    const ref = await loadReference(args.referencePath);
    const transcript = await transcribeCached(videoPath, modelsRoot(), cacheDir(), await loadGlossary(userDataDir()), undefined, typeof args.subtitlePath === "string" ? args.subtitlePath : undefined, { engineId: typeof args.engineId === "string" ? args.engineId : undefined, localServiceUrl: typeof args.localServiceUrl === "string" ? args.localServiceUrl : undefined, restart: args.restart === true });
    const candidates = await detectForPipeline(videoPath, transcript, {
      modelsRoot: modelsRoot(),
      evidenceCacheDir: evidenceCacheDir(),
      llm,
      maxClips: clampClips(args.maxClips),
      genre: parseGenre(typeof args.genre === "string" ? args.genre : undefined, typeof args.genreCustom === "string" ? args.genreCustom : undefined),
      clipLength: isClipLength(args.clipLength) ? args.clipLength : undefined,
      reference: ref.profile,
      // 桌面审阅台积累的本机偏好,MCP 检测同享(只读)
      reviewMemory: await loadReviewMemory(userDataDir()),
      performanceMemory: await loadPerformanceMemory(userDataDir()),
    });
    if (candidates.length === 0) return `${ref.note}没有找到值得切的爆点候选。`;
    return ref.note + JSON.stringify(
      candidates.map((c) => ({
        id: c.id,
        start: fmtClock(c.startSec),
        end: fmtClock(c.endSec),
        startSec: c.startSec,
        endSec: c.endSec,
        title: c.title,
        hook: c.hook,
        score: c.score,
        reason: c.reason,
        recommended: c.recommended,
        reviewNote: c.reviewNote || undefined,
        visualEvidence: c.visualEvidence,
      })),
      null,
      2
    );
  }

  if (name === "clip_video") {
    const llm = llmFromEnv();
    const ref = await loadReference(args.referencePath);
    const outcome = await autoClip(videoPath, {
      modelsRoot: modelsRoot(),
      cacheDir: cacheDir(),
      renderCacheDir: renderCacheDir(),
      evidenceCacheDir: evidenceCacheDir(),
      llm,
      maxClips: clampClips(args.maxClips),
      genre: parseGenre(typeof args.genre === "string" ? args.genre : undefined, typeof args.genreCustom === "string" ? args.genreCustom : undefined),
      clipLength: isClipLength(args.clipLength) ? args.clipLength : undefined,
      vertical: args.vertical !== false,
      captions: args.captions !== false,
      autoEnhance: args.autoEnhance === true,
      denoiseMode: args.denoiseMode === "smart" ? "smart" : args.denoiseMode === "basic" ? "basic" : undefined,
      subtitlePath: typeof args.subtitlePath === "string" ? args.subtitlePath : undefined,
      asr: { engineId: typeof args.engineId === "string" ? args.engineId : undefined, localServiceUrl: typeof args.localServiceUrl === "string" ? args.localServiceUrl : undefined, restart: args.restart === true },
      outDir: typeof args.outDir === "string" && args.outDir.trim() ? args.outDir : undefined,
      fontsDir,
      glossary: await loadGlossary(userDataDir()),
      reference: ref.profile,
      reviewMemory: await loadReviewMemory(userDataDir()),
      performanceMemory: await loadPerformanceMemory(userDataDir()),
    });
    if (outcome.exported.length === 0) {
      return `${ref.note}AI 复评后没有建议发布的切片(候选都被判定为弱钩子)。可用 detect_highlights 查看全部候选与复评意见。`;
    }
    const list = outcome.exported
      .map((r) => {
        const c = outcome.candidates.find((x) => x.id === r.id);
        // 出片质检告警直接随条目回给 Agent——Agent 只需复核告警条,不用逐条回放
        const qaNote = r.qa && r.qa.status === "warn" ? `\n  ⚠ 质检:${r.qa.issues.join(";")}` : "";
        // 修复循环干过活也要说(裁边/响度重归一,机器改了什么必须可见)
        const fixNote = r.qa?.repair?.applied ? `\n  🔧 已自动修复:${r.qa.repair.actions.join("、")}` : "";
        const colorNote = r.colorConverted
          ? " · HDR→SDR"
          : r.colorConversionSkipped
            ? " · HDR 色彩路径不支持,未转换"
            : r.colorInspectionFailed
              ? " · 色彩信息检查失败"
              : "";
        const audioNote = r.audioEnhancement ? ` · 音频:${r.audioEnhancement}` : "";
        return `- ${basename(r.path)} (${Math.round(r.durationSec)}s, 评分 ${c?.score ?? "?"}${colorNote}${audioNote}) ${c?.title ?? ""}${qaNote}${fixNote}`;
      })
      .join("\n");
    const warned = outcome.exported.filter((r) => r.qa?.status === "warn").length;
    const qaLine =
      warned > 0
        ? `出片质检:${warned} 条有告警(详见条目与 clips.json 的 qa 字段)`
        : "出片质检:全部通过(黑屏/长静音/响度/时长/切点/违禁词复核)";
    return `${ref.note}已导出 ${outcome.exported.length} 条切片到 ${outcome.outDir}\n${list}\n${qaLine}\n附带 clips.json(标题/评分/时间码/回执/质检)与每条封面 JPG。`;
  }

  throw new Error(`未实现的工具: ${name}`);
}

// ---- stdio 主循环:一行一条 JSON-RPC ----
export function startServer(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const version = (require("../../package.json") as { version: string }).version;
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const text = line.trim();
    if (!text) return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(text) as JsonRpcMessage;
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`);
      return;
    }
    void handleMcpMessage(msg, executeTool, version).then((res) => {
      if (res) process.stdout.write(`${JSON.stringify(res)}\n`);
    });
  });
  process.stderr.write("hotclip mcp server ready (stdio)\n");
}

startServer();
