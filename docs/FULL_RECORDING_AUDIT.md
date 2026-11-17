# 全片兴趣点初审：先列候选，再选片

主分析和视觉固定 `gpt-6.1-sol high`，ASR 文字校核固定 `gpt-6.1-terra high`，本地转写为 Qwen3。此流程输出兴趣点表，不调用视频渲染器。用户挑选编号后，再对选中范围做原音复核、字幕精校、词对齐和完整话题切片。

长录播采用流式处理：Qwen 按 28 秒写可恢复的识别窗口；Terra 每 14 分钟通读全部句子，只输出有依据的修订；Sol 阅读完整的校核稿及前后各 90 秒语境，按连续区间归纳话题并找候选。覆盖校验拒绝遗漏或重复的原句。可提前校核后续分块以减少等待，不因长视频而截掉后半场。

`bookmarks.json` 保存用户提供的源片时间和原标签，格式为 `[{"id":"M01","time":"02:49:04","sec":10144,"label":"猫来"}]`。标签是待核线索，模型不能从标签反造对白。用户标记全部保留；全片新增候选先去重排序，再结合前后文精查起止范围。

```powershell
# args.json: videoPath、outDir，可选 expectedBytes 验证复制完整性
node node_modules/tsx/dist/cli.mjs tools/transcribe-full-recording.mts args.json
# source.json 建立且首个识别窗口可用后，可与上一步并行启动
node node_modules/tsx/dist/cli.mjs tools/audit-full-recording.mts D:/runs/recording
# 可选：提前准备后续 Terra 修订，最后的数字为从 0 开始的分块编号
node node_modules/tsx/dist/cli.mjs tools/audit-full-recording.mts D:/runs/recording --corrections-only 3
# 可选：全片转写与 Terra 校核完成后，提前核对用户标记，缓存供最终表格复用
node node_modules/tsx/dist/cli.mjs tools/refine-recording-interests.mts D:/runs/recording --markers-only
# 等待扫描完成，逐条核对用户标记并生成表格
node node_modules/tsx/dist/cli.mjs tools/refine-recording-interests.mts D:/runs/recording
```

全片扫描最多同时处理两个分块。已有通过校验的分块可恢复，模型缓存按输入、schema、模型和图片内容寻址。此工具链是本机 CLI 工作流，尚未单独包装成一个 MCP 工具。

ASR 若因时间戳校验中止，先用 `tools/inspect-qwen-window.mts ROOT WINDOW_INDEX` 对失败的 28 秒窗口独立复识，检查保存的原始响应。不要放宽时间戳校验或跳过该段；确认后归档 `asr-error.json`，以原参数重跑转写，自动从已完成窗口接续。受影响的提前校核进程也应归档其错误回执并从对应分块继续。

`observe-recording-markers.mts ROOT SEE_VIDEO_HELPER` 是本次样片的视觉辅助入口，使用 dsh-see-now 的指定时刻抽帧功能，对 M01/M03/M04/M05/M06/M07/M12/M13 的前后 8 秒及标记时刻进行观察。它是针对这组标记的预设，其他录播需要调整目标 ID。每帧 1280 像素长边；静帧不证明连续动作或音频。

最终产物包括 `兴趣点待选表.md`、`兴趣点待选表.csv`、`selection/interest-candidates.json`、`audit/ASR与上下文对照.csv` 和完整的识别、校核、分段扫描证据。`M` 编号来自用户标记，`A` 编号是全片新增候选。

初审中的主播/游戏内容归类来自语境，没有运行全片音色聚类，不能宣称已确认音源。全片文字校核没有直接听原音；冲突内容保留不确定标记。气口以相邻 ASR 句间隙估算，最终出片前仍需复核原音与边界。没有匹配、画面未核实、关键 ASR 不确定、录播截断或需外扩的候选必须在表中展示，不能凑成已确认的名场面。
