# Codex selects, HotClip renders

This fork supports a transcript-first workflow without a separate highlight-model API key.
HotClip runs speech recognition and rendering locally. The calling agent reads the transcript,
selects complete conversations, and submits source timestamps to `export_selected_clips`.
Transcripts and any frames the agent inspects become inputs to that agent; this is not a claim
that a cloud-hosted agent performs inference offline.

## Register with Codex

Install dependencies with `pnpm install --frozen-lockfile`. The first transcription downloads
the selected local ASR model. The default is SenseVoice; `fireredasr` is another supported engine.

Use absolute paths to Node, the local tsx entry point, and the server:

```powershell
codex mcp add hotclip -- "C:\Program Files\nodejs\node.exe" "C:\projects\hotclip\node_modules\tsx\dist\cli.mjs" "C:\projects\hotclip\src\mcp\server.ts"
```

In the resulting `[mcp_servers.hotclip]` section of `~/.codex/config.toml`, set
`startup_timeout_sec = 30` and `tool_timeout_sec = 1800` for longer local jobs.
Refresh the MCP connection if the current client still has the old tool catalog.
The server finds its bundled fonts relative to its source directory, independent of the client's cwd.
Launching Node directly also keeps package-manager banners out of JSON-RPC stdout.

## Workflow

1. Call `transcribe_video` with `format: "json"`. Read every needed page using `nextOffset`;
   the default page has 50 sentences and preserves fractional `startSec` / `endSec`.
   For Endfield / Bilibili streams, pass `lexiconProfiles: ["endfield", "bili-live"]` to both
   transcription and export. Read `lexiconAudit`: confirmed contextual fixes preserve word
   times, while ambiguous candidates remain for review. See [ASR lexicons](ASR_LEXICON.md).
2. Prefer standalone topics, clear setup/payoff, and complete replies. Expand the transcript
   context around candidates before deciding boundaries. Don't mistake game dialogue or
   background music for the streamer's speech; ASR text can contain errors.
   For chat clips, read at least 30–60 seconds on both sides and continue until the exchange
   resolves: include the viewer's request, the answer, and the follow-up reaction or punchline.
   Choose final cut points in nearby speech gaps, aiming for about 0.5–1 second of lead-in and
   1–2 seconds of natural tail room. Check audio/VAD evidence when boundaries are unclear;
   ASR word endings can be stretched across silence. Don't cut exactly at the last word or
   a sentence separator, and don't append padding that cuts into the next utterance. If a
   response continues, extend to its natural end rather than forcing a short duration.
3. Inspect frames only when needed to check a candidate. The separately installed dsh-see-now
   skill can provide deduplicated contact sheets or exact-time frames. This fork does not
   bundle that skill or automatically scan the whole video.
4. Call `export_selected_clips` with source-relative seconds and short reasons:

```json
{
  "videoPath": "C:/videos/chat.mp4",
  "engineId": "fireredasr",
  "clips": [{"title": "A complete topic", "startSec": 123.4, "endSec": 185.6, "reason": "Setup and reply both included"}],
  "outDir": "C:/videos/exports/topic-01",
  "vertical": false,
  "captions": true
}
```

The submitted times are final edit boundaries, already including context and breathing room;
the renderer does not add it automatically. The output directory must be new or empty.
This tool preserves selected boundaries and pauses:
no silence removal, filler deletion, automatic shot snapping, or QA edge trimming. It burns
subtitles and exports MP4, SRT, EDL, covers, `clips.json`, and `selection.json`. Inspect QA warnings
and the resulting subtitle text before calling the clip ready. A successful encode does not
prove that the topic is interesting or that transcription is accurate.

The original `detect_highlights` and `clip_video` still require `HOTCLIP_LLM_*`; they do not
implicitly use the calling agent's subscription. Unattended clipping after recording requires
an active orchestration worker; merely registering this MCP server does not schedule one.

## Smoke test / shell fallback

```powershell
node tools/mcp-call.mjs --list
node tools/mcp-call.mjs transcribe_video transcript-args.json transcript-result.json
node tools/mcp-call.mjs export_selected_clips export-args.json export-result.json
```

These commands perform a real stdio MCP initialize / tools call against the same server.
Arguments and outputs are local files. Keep recordings, transcripts, credentials, and private
machine configuration outside the Git repository.
