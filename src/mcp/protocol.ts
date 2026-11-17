/**
 * HotClip MCP 协议层(stdio JSON-RPC 2.0,零依赖手写):
 * 「本地 MCP 切片器」——让 Claude 等 Agent 直接驱动本地切片管线:
 * "给我这个 4 小时录播,切 10 条爆点" → 转写/检测/出片全在用户机器上跑。
 *
 * 只实现 MCP 需要的最小面:initialize / tools/list / tools/call / ping。
 * 本文件是纯逻辑(消息进→响应出,工具执行通过注入),可完整单测;
 * stdin/stdout 与真实管线在 server.ts。
 */

import { describeSubtitleImportError } from "../shared/subtitle-import";
import { GENRE_PRESETS } from "../core/genre";
import { CLIP_LENGTH_RANGES } from "../shared/detection-options";

/** MCP 协议版本(2024-11-05 基线,客户端普遍兼容)。 */
export const MCP_PROTOCOL_VERSION = "2024-11-05";

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** 工具执行注入点:返回给 Agent 的文本(抛错→isError 响应)。 */
export type ToolExecutor = (name: string, args: Record<string, unknown>) => Promise<string>;

const selectionProperties = {
  genre: { type: "string", enum: GENRE_PRESETS.map((g) => g.id), description: "直播品类,默认 auto;同时用于检测证据与导出跳剪节奏" },
  genreCustom: { type: "string", description: "自定义爆点判据;非空时覆盖内置判据,最多 1200 字" },
  clipLength: { type: "string", enum: Object.keys(CLIP_LENGTH_RANGES), description: "目标时长:short 10-30s / standard 8-40s / long 40-90s / extended 60-120s;默认 standard" },
};

export const MCP_TOOLS: McpToolDef[] = [
  {
    name:"structure_recording",
    description:"把录播转换为结构化上下文，不剪片。默认Qwen转写/词库/音色聚类、Terra high校核与互动理解；读同名XML/JSONL弹幕，输出背景、主播/游戏话语、弹幕、互动关系、话题、带证据的兴趣点、分页上下文包和CSV对照表。画面观察仅在提供visualTimes时由gpt-6.1-sol high执行。候选关联和未知来源保留不确定性。",
    inputSchema:{type:"object",properties:{
      videoPath:{type:"string",description:"源录播绝对路径"},outDir:{type:"string",description:"尚不存在的输出目录绝对路径"},
      resume:{type:"boolean",description:"继续相同outDir的失败任务；源文件及处理选项必须一致，复用已完成的转写、聚类和模型结果"},
      danmakuPath:{type:"string",description:"可选弹幕XML/JSONL绝对路径；默认查找视频同名文件"},
      danmakuOffsetSec:{type:"number",description:"弹幕相对秒到视频时间的偏移；默认0，不冒充已校准"},
      danmakuScale:{type:"number",description:"显式时钟缩放校准，默认1，范围0.9–1.1"},
      background:{type:"object",description:"用户已知直播背景；未知留空",properties:{streamerName:{type:"string"},roomId:{type:"string"},title:{type:"string"},gameName:{type:"string"},gameChapter:{type:"string"},notes:{type:"string"}},additionalProperties:false},
      visualTimes:{type:"array",items:{type:"number"},maxItems:12,description:"可选画面观察时刻，源片秒；不填不进行视觉推断"},
      diarize:{type:"boolean",description:"默认true，本地音色聚类辅助角色推断"},
      maxInterests:{type:"number",description:"最多兴趣点候选，默认12，0关闭，最大50；不保证凑足数量"},
      subtitlePath:{type:"string",description:"可选已有SRT/VTT原稿，仍进行语境校核，原字词时间可能是估算"},
      localServiceUrl:{type:"string",description:"Qwen本机服务默认http://127.0.0.1:8766"},
    },required:["videoPath"]},
  },
  {
    name:"read_recording_context",
    description:"按源时间或话题ID读取已结构化录播的上下文包，无模型调用。返回事件、相关弹幕/关系、话题、兴趣点和证据引用；用nextOffset翻页，避免整场一次输入。",
    inputSchema:{type:"object",properties:{contextDir:{type:"string",description:"structure_recording输出目录绝对路径"},startSec:{type:"number"},endSec:{type:"number"},episodeId:{type:"string"},eventIds:{type:"array",items:{type:"string"},maxItems:50,description:"按事件ID精确回查证据，最多50个"},offset:{type:"number",description:"默认0"},limit:{type:"number",description:"每页1–100条，默认60"}},required:["contextDir"]},
  },
  {
    name: "clip_chat_video",
    description: "聊天录播自动切片：默认 Qwen3 ASR → 终末地/B站词库 → Codex gpt-6.1-terra high 跨段字幕和话题校核 → 时间对齐 → 无标点字幕和完整话题切片。排除话题结束后的游戏剧情/游戏解说，保留自然气口。同步导出 SRT、字幕与上下文 CSV/JSON 对照表及审计记录。视觉校验可选，固定 gpt-6.1-sol high。需要运行本地 Qwen 服务和已登录的 Codex CLI，不需额外 LLM API key。说话人角色由本地音色聚类辅助语境推断，簇不代表已确认身份。",
    inputSchema: { type: "object", properties: {
      videoPath: { type: "string", description: "本地源视频绝对路径" },
      outDir: { type: "string", description: "新建任务目录的绝对路径，必须尚不存在" },
      brief: { type: "string", description: "关注的话题与排除内容；默认完整聊天话题，排除游戏剧情" },
      maxClips: { type: "number", description: "最多切片数量，1–12，默认6" },
      visualCheck: { type: "boolean", description: "抽查成片画面，使用 gpt-6.1-sol high；默认false" },
      diarize: { type: "boolean", description: "默认true：本地音色聚类辅助角色判断；簇不代表已确认身份" },
      subtitlePath: { type: "string", description: "可选已有原文SRT/VTT，仍经过聊天流程字幕校核；句内时间为估算" },
      vertical: { type: "boolean", description: "默认保留横屏；true导出竖屏" },
      localServiceUrl: { type: "string", description: "Qwen本机服务默认 http://127.0.0.1:8766" },
    }, required: ["videoPath"] },
  },
  {
    name: "clip_video",
    description:
      "全托管切片:把一个本地长视频(播客/直播回放/课程)转写、AI 找爆点并导出为可发布的竖屏短视频(烧字幕/跳剪/表情信号),返回输出目录与每条切片的标题/评分/时间码。未提供 subtitlePath 时,首次运行会自动下载本地 ASR 模型。需要环境变量 HOTCLIP_LLM_BASE_URL/HOTCLIP_LLM_MODEL(以及非本地端点的 HOTCLIP_LLM_API_KEY)。",
    inputSchema: {
      type: "object",
      properties: {
        videoPath: { type: "string", description: "本地视频文件的绝对路径" },
        engineId: { type: "string", enum: ["sensevoice", "paraformer", "fireredasr", "qwen3"], description: "本地 ASR 引擎，默认 qwen3；需要运行本地 Qwen 语音服务。" },
        localServiceUrl: { type: "string", description: "Qwen3 本地服务地址，仅 127.0.0.1 / ::1，默认 http://127.0.0.1:8766。" },
        restart: { type: "boolean", description: "重新转写，不复用本次素材的当前引擎分段进度；默认自动续跑。" },
        subtitlePath: { type: "string", description: "可选:与当前素材对齐的 UTF-8 SRT/WebVTT 单轨原文字幕绝对路径(最大 5 MB、无重叠)。跳过 ASR,保留原句时间;句内字词时间为估算,需复核。" },
        maxClips: { type: "number", description: "最多导出几条(1-12,默认 6)" },
        ...selectionProperties,
        vertical: { type: "boolean", description: "竖屏 9:16 输出(默认 true)" },
        captions: { type: "boolean", description: "烧录动态字幕(默认 true)" },
        autoEnhance: { type: "boolean", description: "本地测量最终保留画面并克制修正明显偏暗/灰/过饱和素材(默认 false;不下载模型)" },
        denoiseMode: { type: "string", enum: ["basic", "smart"], description: "可选音频清理:basic 固定滤镜;smart 48kHz 本地人声模型(失败自动回退 basic)" },
        outDir: { type: "string", description: "输出目录(默认源视频旁 <名>-hotclip/)" },
        referencePath: { type: "string", description: "对标爆款视频的本地路径(可选):实测其时长/语速/句长/镜头频率/钩子形态,选段向对标节奏靠拢(偏好不是硬约束);分析失败按无参考继续" },
      },
      required: ["videoPath"],
    },
  },
  {
    name: "detect_highlights",
    description:
      "只找爆点不出片:转写并用 LLM 挑出爆点候选,返回每条的时间码/标题/钩子/评分/理由/AI复评意见 JSON。适合先审后剪的流程。需要 HOTCLIP_LLM_* 环境变量。",
    inputSchema: {
      type: "object",
      properties: {
        videoPath: { type: "string", description: "本地视频文件的绝对路径" },
        engineId: { type: "string", enum: ["sensevoice", "paraformer", "fireredasr", "qwen3"], description: "本地 ASR 引擎，默认 qwen3；需要运行本地 Qwen 语音服务。" },
        localServiceUrl: { type: "string", description: "Qwen3 本地服务地址，仅 127.0.0.1 / ::1，默认 http://127.0.0.1:8766。" },
        restart: { type: "boolean", description: "重新转写，不复用本次素材的当前引擎分段进度；默认自动续跑。" },
        subtitlePath: { type: "string", description: "可选:与当前素材对齐的 UTF-8 SRT/WebVTT 单轨原文字幕绝对路径(最大 5 MB、无重叠)。跳过 ASR,保留原句时间;句内字词时间为估算,需复核。" },
        maxClips: { type: "number", description: "最多几条候选(1-12,默认 6)" },
        ...selectionProperties,
        referencePath: { type: "string", description: "对标爆款视频的本地路径(可选):实测其节奏画像,候选向对标节奏靠拢;分析失败按无参考继续" },
      },
      required: ["videoPath"],
    },
  },
  {
    name: "transcribe_video",
    description:
      "字幕接入或本地转写:提供 subtitlePath 时导入已有字幕并估算字词时间;否则用本地 Qwen3 ASR把视频/音频转成带时间戳的逐句稿。结果有缓存,同一文件二次调用秒回。不需要 LLM 配置。",
    inputSchema: {
      type: "object",
      properties: {
        videoPath: { type: "string", description: "本地视频/音频文件的绝对路径" },
        engineId: { type: "string", enum: ["sensevoice", "paraformer", "fireredasr", "qwen3"], description: "本地 ASR 引擎，默认 qwen3；需要运行本地 Qwen 语音服务。" },
        localServiceUrl: { type: "string", description: "Qwen3 本地服务地址，仅 127.0.0.1 / ::1，默认 http://127.0.0.1:8766。" },
        restart: { type: "boolean", description: "重新转写，不复用本次素材的当前引擎分段进度；默认自动续跑。" },
        subtitlePath: { type: "string", description: "可选:导入已有 UTF-8 SRT/WebVTT 原文字幕,跳过 ASR(最大 5 MB、无重叠)。句内字词时间为估算,需复核。" },
        lexiconProfiles: { type: "array", items: { type: "string", enum: ["endfield", "bili-live"] }, description: "可选领域词库；按语境修正已确认错词，其他同音候选只报告待核。保留词时间；不改用户导入字幕。" },
        format: { type: "string", enum: ["text", "json"], description: "json 返回分页逐句稿，包含精确 startSec/endSec，便于调用方自己选段；默认 text。" },
        offset: { type: "number", description: "JSON 分页起始句索引，默认 0，非负整数。" },
        limit: { type: "number", description: "JSON 每页句数，默认 50，范围 1–100。" },
      },
      required: ["videoPath"],
    },
  },
  {
    name: "export_selected_clips",
    description: "按调用方已核实的源片时间段导出，不调用选段 LLM，不需要 API Key。聊天先扩读前后文，保留提问、回答和后续反应；提交的起止点须已包含自然气口，不能贴字切断，工具不自动外扩。默认保留横屏、完整停顿和已选边界，烧录字幕并附 SRT、EDL、封面、clips.json 质检报告。先用 transcribe_video(format=json) 读起止时间，必要时核对音频或画面；不要编造时间或对白。",
    inputSchema: {
      type: "object",
      properties: {
        videoPath: { type: "string", description: "本地源视频绝对路径" },
        lexiconProfiles: { type: "array", items: { type: "string", enum: ["endfield", "bili-live"] }, description: "可选领域词库；按语境修正已确认错词，其他同音候选只报告待核。保留词时间；不改用户导入字幕。" },
        clips: {
          type: "array", minItems: 1, maxItems: 12,
          items: {
            type: "object", required: ["title", "startSec", "endSec"],
            properties: {
              title: { type: "string", maxLength: 120 },
              startSec: { type: "number", minimum: 0, description: "源片绝对秒数，允许小数" },
              endSec: { type: "number", description: "大于 startSec，且不能超过源片时长" },
              reason: { type: "string", maxLength: 1200, description: "调用方观察到的选段依据" },
            },
          },
        },
        outDir: { type: "string", description: "绝对路径，必须尚不存在或为空；缺省在源片旁新建独立目录" },
        captions: { type: "boolean", description: "烧录字幕并生成 SRT，默认 true；无转写时首次下载本地模型" },
        vertical: { type: "boolean", description: "裁成竖屏，默认 false；游戏建议保留横屏" },
        engineId: { type: "string", enum: ["sensevoice", "paraformer", "fireredasr", "qwen3"] },
        localServiceUrl: { type: "string", description: "Qwen3 本地 ASR 服务地址，仅 loopback" },
        subtitlePath: { type: "string", description: "可选 UTF-8 SRT/VTT，需与源片对齐；句内词时间为估算" },
      },
      required: ["videoPath", "clips"],
    },
  },
];

/** 参数校验:必填与类型(浅校验够用——工具实现里还有业务检查)。 */
export function validateToolArgs(tool: McpToolDef, args: Record<string, unknown>): string | null {
  const schema = tool.inputSchema as { properties?: Record<string, { type?: string; enum?: unknown[] }>; required?: string[] };
  for (const key of schema.required ?? []) {
    if (args[key] === undefined || args[key] === null || args[key] === "") return `缺少必填参数 ${key}`;
  }
  for (const [key, value] of Object.entries(args)) {
    const spec = schema.properties?.[key];
    if (!spec?.type || value === undefined) continue;
    const actual = typeof value;
    if (spec.type === "number" && actual !== "number") return `参数 ${key} 应为 number`;
    if (spec.type === "string" && actual !== "string") return `参数 ${key} 应为 string`;
    if (spec.type === "boolean" && actual !== "boolean") return `参数 ${key} 应为 boolean`;
    if (spec.type === "array" && !Array.isArray(value)) return `参数 ${key} 应为 array`;
    if (spec.enum && !spec.enum.includes(value)) return `参数 ${key} 应为 ${spec.enum.join("|")}`;
  }
  return null;
}

function result(id: JsonRpcMessage["id"], payload: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, result: payload };
}

function rpcError(id: JsonRpcMessage["id"], code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function toolText(text: string, isError = false): Record<string, unknown> {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

/**
 * 处理一条 JSON-RPC 消息;返回响应对象,通知(无 id 的 notification)返回 null。
 */
export async function handleMcpMessage(
  msg: JsonRpcMessage,
  execute: ToolExecutor,
  serverVersion: string
): Promise<Record<string, unknown> | null> {
  const method = msg.method ?? "";
  // 通知不需要响应(initialized / cancelled 等)
  if (msg.id === undefined && method.startsWith("notifications/")) return null;

  switch (method) {
    case "initialize":
      return result(msg.id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "hotclip", version: serverVersion },
      });
    case "ping":
      return result(msg.id, {});
    case "tools/list":
      return result(msg.id, { tools: MCP_TOOLS });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      const tool = MCP_TOOLS.find((t) => t.name === name);
      if (!tool) return result(msg.id, toolText(`未知工具: ${name}`, true));
      const invalid = validateToolArgs(tool, args);
      if (invalid) return result(msg.id, toolText(invalid, true));
      try {
        return result(msg.id, toolText(await execute(name, args)));
      } catch (e) {
        return result(msg.id, toolText(describeSubtitleImportError(e), true));
      }
    }
    default:
      return rpcError(msg.id, -32601, `method not found: ${method}`);
  }
}
