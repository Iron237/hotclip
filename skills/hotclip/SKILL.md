---
name: hotclip
description: Transcribe local recordings, let the calling agent select complete conversations, and export captioned clips through HotClip MCP. Use for livestream clipping, 切片, highlights, subtitles, or local transcription. No separate highlight-model API key is needed for agent-selected export.
---

# HotClip — local AI clipping pipeline

HotClip（AGPL-3.0 开源）在本机转写、加字幕和渲染。This fork lets the calling agent select clips from transcripts without calling another LLM. Any transcript or frame read by the agent becomes input to that agent. See `docs/CODEX_MCP.md` for registration and exact defaults.

## Setup (once)

1. Repo + deps (skip what already exists):
   ```bash
   git clone https://github.com/xixihhhh/hotclip.git && cd hotclip
   pnpm install   # ffmpeg/ffprobe are bundled npm binaries — nothing else to install
   ```
2. Prefer the MCP `transcribe_video` → calling-agent selection → `export_selected_clips` route; no LLM environment variables are needed. Only if the user chooses the original automatic `highlights` / `clip` tools, configure an OpenAI-compatible endpoint:
   ```bash
   export HOTCLIP_LLM_BASE_URL=http://localhost:11434/v1   # local Ollama (no key needed)
   export HOTCLIP_LLM_MODEL=qwen3:8b
   # cloud endpoints additionally need: export HOTCLIP_LLM_API_KEY=sk-...
   ```
   If these are missing for the original automatic tools, ask which endpoint to use. They are not required for calling-agent selection; never guess keys.
3. First `transcribe`/`clip` run auto-downloads the ASR model (~1GB, CN mirror first). Warn the user it may take a few minutes once.

## Commands (run from the repo root)

```bash
pnpm cli transcribe <video>                    # on-device word-level ASR (cached; instant on re-run)
pnpm cli highlights <video> [--max-clips N] [--reference REF] [--json]   # AI highlight candidates — review before cutting
pnpm cli clip <video> [--max-clips N] [--reference REF] [--no-vertical] [--no-captions] [--out DIR] [--json]
                                               # fully managed: transcribe → detect → export + render-QA
```

`--reference <video>`: hand in a viral clip to model after — its pacing (duration / speech rate / shot-cut frequency / hook shape) is measured locally and steers candidate selection as a preference (never a hard rule). Use when the user says "切得像这条" / "learn from this clip".

Input: MP4 / MKV / MOV / FLV / TS, or audio-only (podcasts get an auto-generated waveform video). Paths with spaces need quoting.

## Recommended workflow

先理解整场录播或用户要求结构化上下文时，调用 `structure_recording`。它生成直播背景、并行事件、弹幕关联、话题、兴趣点和对照表，不直接剪片。用 `read_recording_context` 按时间、episodeId 或 eventIds 回查，跟随 nextOffset 分页；不要把整场事件反复塞入模型。`candidate` 关联不能写成已确认事实；未匹配的弹幕请求保留缺失。视觉只在传入 `visualTimes` 时执行，未观察画面保持未知。详见 `docs/STRUCTURED_CONTEXT_WORKFLOW.md`。

0. **用户的聊天自动切片默认流程**：优先调用 `clip_chat_video`，默认 Qwen3-ASR 1.7B、终末地/B站词库、本地音色聚类；字幕校核固定 `gpt-6.1-terra` / `high`，主分析及话题选择固定 `gpt-6.1-sol` / `high`。需要视觉抽查时 `visualCheck: true`，固定 `gpt-6.1-sol` / `high`，配对比较源片与成片。字幕排版后去标点，内部断句稿保留；同步导出 SRT、`字幕与上下文对照.csv`、JSON 审计。无需另配 LLM API key，复用用户 Codex CLI 登录。详见 `docs/CHAT_CLIPPING.md`。读 `chat-job.json` 中的边界、时间、角色及视觉告警；不得把 needs-review 说成已人工听校。

   **当前话题边界优先于说话人连续性**：主播回答完后转回游戏解说属于新话题，即使音色相同也排除。保留的是同一话题的反应，不是后面所有反应。音色聚类仅辅助语境判断，不等于已确认身份；声纹相似、游戏配音和叠音仍要标不确定。真实停顿不足时不能为了增加尾气口引入下一句。

1. **Transcript-first**: call `transcribe_video` with `format: "json"`, follow `nextOffset`, and choose complete topics or setup/payoff sequences from source timestamps. For chat recordings, visual analysis is optional and limited to candidates; use dsh-see-now if available. Then call `export_selected_clips` with `clips: [{title, startSec, endSec, reason}]`, the same ASR engine or subtitle input, and a fresh output directory. User authorization to try clipping is sufficient to export a local sample. The defaults retain landscape framing and pauses. Do not claim an interesting highlight solely because rendering succeeded.
2. **Read the output receipt**: the export folder contains one mp4 + cover JPG + `.post.txt` (publish copy) per clip, plus `clips.json` — per-clip evidence chain (`render`: what the pipeline did) and **`qa`: render-QA report** (`status: pass|warn` with issues like black frames, long silences, loudness deviation, duration mismatch, mid-word cuts, and **platform-risk words** in title/copy/captions via a local rule lint — `qa.contentHits` lists each term and where it appeared).
3. **Self-repair is automatic**: fixable warnings (leading/trailing silence or black frames → edge-trim; loudness deviation → second normalize pass) are repaired and re-checked in one pass; `qa.repair` records what was done (`actions`, `applied`). A repair is only kept when the re-check strictly improves.
4. **Surface QA warnings**: if any clip still has `qa.status === "warn"`, tell the user which clip and why; content-lint hits mean the copy/captions may be throttled or rejected by 抖音/小红书/视频号 — suggest rewording before publishing. Never silently ship a warned clip.

## Hard rules

- **领域词校核**：终末地 / B站直播素材，在转写与导出同时设置 `lexiconProfiles: ["endfield", "bili-live"]`。查看 `lexiconAudit`，已确认的“上剑→上舰”只在匹配语境时自动修正；其余待核项结合前后文与回听判断，不得把同音候选视为已确认。词库与来源见 `resources/lexicons/zh-streaming.json`、`docs/ASR_LEXICON.md`。用户导入字幕不自动改写。
- **完整互动与气口**：聊天候选先扩读前后至少 30–60 秒，必要时继续读到话题收束；保留观众提问、铺垫、回答、后续反应。最终入点尽量在首句前 0.5–1 秒的自然间隙，出点尽量在末句后 1–2 秒的自然间隙。用音频/VAD复核不清楚的边界；ASR的最后一个字可能被拉长到整段静音。不能贴字切断、只保留观点而漏掉互动，也不能机械加时把下一句切进一半。时长服从内容完整，`export_selected_clips` 只执行已选好的最终边界。
- **Never guess timestamps.** Derive topic boundaries from the timed transcript and verify surrounding speech gaps before choosing final cut points; do not invent start/end seconds or hand-roll ffmpeg cuts when the pipeline covers it.
- **Local-first**: ASR and rendering are local. The agent may read task-relevant transcripts and selected frames to do the requested analysis; do not send media to unrelated external services.
- Exports land next to the source video in `<name>-hotclip/` unless `--out` is given; tell the user the absolute path when done.

## MCP alternative

The local stdio MCP server exposes `clip_video`, `detect_highlights`, `transcribe_video`, and `export_selected_clips`. Prefer it when available. For a client that has not refreshed its tool catalog, `node tools/mcp-call.mjs TOOL args.json result.json` performs the same real MCP call. No automatic background clipping is scheduled merely by registering the server.
