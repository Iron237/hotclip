# 主播聊天自动切片

使用 MCP `clip_chat_video`。这条流程按**话题**选段，不把同一主播说的所有内容都视为同一话题。例如，回答完“念哥哥”的请求之后开始说“刚才错过了什么剧情”，应在回答收束处结束。

## 固定流程与模型

1. 本地 Qwen3-ASR 1.7B + Qwen3-ForcedAligner 0.6B；保留原始转写和字词时间。
2. 默认启用终末地、B站直播词库。只自动改已确认且语境匹配的词，其他候选交给校核。
3. 默认运行 pyannote segmentation + 3D-Speaker ERes2Net 音色聚类；按 5 分钟窗口处理以限制内存。speaker ID 仅在窗口内有效，不能把声音簇当作已确认的真实身份。混音、叠音和主播为角色配音仍可能混淆。
4. **`gpt-6.1-terra` / `high`** 进行跨段字幕校核、断句、主播/游戏角色推断、话题选择。转写按约 2 分钟分批，前后各带约 45 秒语境；长录播的话题候选分批筛选再汇总，不直接截断后半场。音色簇只作为辅助，读弹幕、回应、游戏对白及话题转换均需要语义判断。
5. 选中片段中的疑难句带前后各 3 秒重新识别，交给 Terra high 对照两次结果；证据仍冲突则保留待核，不凭句意补写。文字有实质修改时重新做 Qwen 时间对齐。内部文本保留标点帮助断句，**烧录字幕与 SRT 在排版后去句读标点**，保留数值中的小数点、比例符号和负号，避免改变数字含义。不会删除真实口头语来制造原本不存在的顺畅表达。
6. 按完整提问、铺垫、回答、同话题反应选段。入点尽量留约 0.8 秒，尾部尽量留约 1.2 秒；实际空隙不足时让位于下一句话，不把下一话题混进来。边界间隙过短、时间插值、未确认字句会写入复核记录。
7. 可选 **`gpt-6.1-sol` / `high`** 视觉校验：每片抽查开头、中间、结尾，配对原片和成片。只判断可见的字幕及新增画面缺陷，不冒充全片观看或音频听校。
8. 输出 MP4、无标点 SRT、EDL、封面、渲染 QA、字幕/上下文 CSV 与 JSON，以及模型审稿、话题边界和音色聚类证据。

ASR 和渲染在本机。校核通过已登录的 Codex CLI 运行，文字和选中的画面会作为 Codex 模型输入，使用相应额度；不需要另配 LLM API key。模型不可用会报错，不自动换成其他模型。该流程与上游通用 `clip_video` 分开，后者仍使用 `HOTCLIP_LLM_*` 配置。

## 调用

```json
{
  "videoPath": "C:/BiliRecordings/recording.mp4",
  "outDir": "C:/BiliRecordings/exports/chat-job-001",
  "brief": "选完整聊天互动与笑点 排除游戏剧情和话题结束后的游戏解说",
  "maxClips": 3,
  "diarize": true,
  "visualCheck": true
}
```

`outDir` 必须是尚不存在的目录，父目录应已存在。默认横屏、不跳剪、不删停顿、不加标题卡；`vertical: true` 才转竖屏。

工具未刷新时：

```powershell
node tools/mcp-call.mjs clip_chat_video args.json result.json
# 或同一核心流程的命令行入口
node node_modules/tsx/dist/cli.mjs tools/chat-clip.mts args.json
```

`字幕与上下文对照.csv` 为 UTF-8 BOM，可直接用 Excel 打开。包含原始 ASR、词库稿、校核断句、无标点字幕、前后文、话题、推断角色、声音簇、是否入片、待复核理由、模型和源时间。JSON 同时保存结构化记录。被排除的剧情仍在表中，方便检查边界。

## 本地 Qwen

已有环境和权重时可直接运行：

```powershell
python tools/qwen-speech-server.py --model 1.7B --device cuda:0 --model-path "D:/models/Qwen3-ASR-1.7B" --aligner-path "D:/models/Qwen3-ForcedAligner-0.6B"
```

仅监听 `127.0.0.1:8766`。本地路径模式关闭 Hugging Face 联网下载。默认 ASR 已在共享 headless 管线和桌面默认选择中改为 `qwen3`；旧桌面设置迁移保留密钥，只切换引擎选择。

Windows 可在 `%APPDATA%/hotclip/qwen-service.json` 保存本机安装描述：

```json
{
  "python": "C:/path/to/venv/Scripts/python.exe",
  "script": "C:/path/to/hotclip/tools/qwen-speech-server.py",
  "modelPath": "D:/models/Qwen3-ASR-1.7B",
  "alignerPath": "D:/models/Qwen3-ForcedAligner-0.6B",
  "device": "cuda:0"
}
```

本地服务未启动时转写会按此描述隐藏启动；缺少描述时明确报服务不可用，不回落其他 ASR。Codex CLI 默认寻找 Windows npm 安装，可用 `HOTCLIP_CODEX_JS` 或 `HOTCLIP_CODEX_BIN` 指定其他安装路径。

## 已知限制

- 同一个声音可同时出现于主播互动和游戏配音；音色簇不等于身份。角色推断的证据级别在表中保留。
- 模型审稿和渲染 QA 通过不等于逐字人工听校。`chat-job.json` 中 `needs-review` 需看具体理由；不会静默删掉困难字句。
- 没有自动给 .37 录播器安装后台任务。当前工具可以接收录制结束后的文件路径；常驻目录监听仍需在录播端部署。
- 默认不加入合成静音尾巴。真实话题之间没有足够停顿时会提示，而不是把下一句话并入。
