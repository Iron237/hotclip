# 录播 → 结构化上下文工作流

已实现独立 MCP 工具 `structure_recording` 和查询工具 `read_recording_context`。这条流程负责建立上下文及兴趣点候选，不直接剪片。已有 `clip_chat_video` 的自动切片入口保留，二者共用 `prepare-chat.ts` 的 Qwen、词库、音色聚类和 Terra 字幕预处理。

## 运行顺序

1. Qwen ASR：原始字词和时间；终末地/B站词库校核。
2. 可选本地音色聚类（默认开启），仅生成窗口内匿名簇。
3. Terra high 跨段字幕校核；疑难句带音频上下文重新识别，再由 Terra high 核对。
4. 读取同名 XML/JSONL 的普通弹幕、SC、礼物和上舰事件，记录主播、房间、直播标题等录制元数据。用户传入的背景可补充或覆盖，但保留来源。
5. 用 `mediaSeconds = sourceChatSeconds × scale + offset` 归一化弹幕时间。默认保留同名文件的相对秒，明确标记尚未校准；不会把 epoch 时间误当成从零开始的弹幕。
6. 可选 Sol high 观察指定时刻的画面，识别画面状态、实际可读的角色名/字幕。不将单帧观察外推为整段剧情，也不据此判断主播正在说什么。
7. Terra high 将话语标记为主播/游戏/未知及读弹幕、回应观众、游戏对白、朗读游戏文本、点评游戏等行为，建立带证据的互动关系和话题。
8. 按触发、铺垫、回应/包袱和收束发现兴趣点。只引用真实事件 ID，不把独立游戏剧情当聊天兴趣点。
9. 输出完整证据、结构化 JSON、阅读稿、CSV 对照表及分页 ContextPacket。

## 输入示例

```json
{
  "videoPath": "C:/BiliRecordings/recording.mp4",
  "outDir": "C:/BiliRecordings/context/job-001",
  "background": {
    "gameName": "终末地",
    "notes": "聊天互动为主"
  },
  "diarize": true,
  "visualTimes": [145, 175],
  "maxInterests": 6
}
```

首次运行时 `outDir` 必须尚不存在，父目录需存在。失败后可用相同参数加 `"resume": true` 继续原目录；源文件大小/修改时间和处理配置必须一致，否则要求新目录。默认读取源视频同名 `.xml`，没有则查 `.jsonl`；也可传 `danmakuPath`。没有弹幕仍可完成转换，但会记录来源缺失。

`background` 只接受 `streamerName / roomId / title / gameName / gameChapter / notes`。未知字段留空，不从主播声音或游戏标题扩写身份经历。

`visualTimes` 最多 12 个，单位是源片秒；不传则不调用视觉模型，画面状态保持未知。`maxInterests` 为 0 时跳过兴趣点发现，默认 12，最大 50，不保证凑数。

若已知弹幕时钟偏移，可提供 `danmakuOffsetSec`，以及必要的 `danmakuScale`（0.9–1.1）。主播读弹幕有反应延迟，不能直接把“读出时间－发送时间”全部当成录制时钟偏移；当前不自动校准此偏移。

## MCP / CLI

```powershell
node tools/mcp-call.mjs structure_recording args.json result.json
# 独立命令行，走相同实现
node node_modules/tsx/dist/cli.mjs tools/structure-recording.mts args.json
```

按时间读取：

```json
{"contextDir":"C:/BiliRecordings/context/job-001","startSec":150,"endSec":220,"limit":60}
```

也可用 `episodeId` 读取完整话题，或 `eventIds` 精确回查最多 50 个事件。调用 `read_recording_context`，跟随 `nextOffset` 分页，读取不再调用模型。相关弹幕可以落在主查询时间之外，返回在 `relatedEvents` 中；被限额省略的关联明确计数，不冒充完整读取。

## 产物

| 文件 | 用途 |
|---|---|
| `session.json` | 背景、来源、媒体时钟、模型、告警 |
| `recording-context.json` | 完整上下文，固定 schemaVersion |
| `events.jsonl` | 时间排序的全部话语、弹幕与画面观察 |
| `relations.json` | 读出、回复、反应、引用的事件关系 |
| `episodes.json` | 话题、状态、参与事件、收束与未解问题 |
| `interest-candidates.json` | 兴趣点原因、铺垫/包袱/收束证据 |
| `上下文阅读稿.md` | 按话题阅读主播、游戏和关联弹幕 |
| `话语与上下文对照.csv` | 原始 ASR、词库稿、校核稿、无标点字幕、上下文、角色及关系 |
| `packets/`、`packet-index.json` | 两分钟窗口的分页上下文包 |
| `asr-raw.json`、`reviewed-turns.json` 等 | 可追溯的识别/校核证据与模型输出 |
| `structure-job.json` | 完成回执和产物数量 |

## 语义与校验约束

- `speaker.role` 表示实际说话者的角色；`activity` 表示正在做什么；`audioOrigin` 在混音录播中保持 `mixed-or-unknown`。主播读游戏台词仍然可以是 `host/read_game_text`。
- 游戏画面时间线和主播互动时间线并行，不要求二选一。角色无法归名时留未知，不把音色簇当作角色名。
- 弹幕发送者使用会话内匿名 ID；原始文字和源时间保留。音色簇只在各自五分钟窗口内有意义。
- `supported` 的读出关系要求时间合理且文字匹配；它表示文本证据支持，不等于人工确认因果。纯语义回复默认 `candidate`。同主题或最近时间不能单独证明回复关系。
- 找不到读出的原始弹幕时，保留 `read_chat` 和缺失提示，不绑定到后来的相似请求。
- 每条话语必须有分类，并恰好属于一个主要话题；可以引用其他话题事件形成交叉关系。未知 ID、重复分配、无证据收束、明显指向未来的关系会被拒绝并要求模型修正。
- 话题可为 `open/responding/resolved/suspended`。跨批继续尚未完成的话题时保留之前的事件引用；同一主播转回游戏仍可另起话题。
- 事件时间沿用 ASR 字词范围。转换流程不导出视频，不声称所有修订文本已完成最终成片级词对齐。
- 背景、弹幕、字幕和画面文字都是输入数据，不能成为模型的操作指令。

## 当前边界

支持单个录播文件及其弹幕；多分片会话的自动拼接、断流重连映射、稳定跨窗口人物识别和独立麦克风/桌面音轨融合尚未实现。当前不会自动创建 .37 的目录监听任务。

大弹幕文件上限 32 MiB。模型只读有界的弹幕代表集与聚合反应，全部弹幕仍保存在事件文件；普通弹幕向前召回 90 秒，SC/礼物等向前召回 15 分钟，以覆盖主播延迟读付费留言的情况。因此仍可能漏掉未被召回的弱语义关联。长话题兴趣点证据经过采样时会明确加待核标记。兴趣等级是模型编辑判断，不是经过统计校准的概率。

模型暂时容量不足时保持原模型重试两次，分别等待 10/30 秒；持续失败或结构修正后仍不合法则保存 `error.json`，不伪造成功。恢复任务会复用 ASR 缓存、声音簇、与原提示词一致的字幕校核及疑难句识别。后续模型结果以提示词、schema、模型和图片内容的哈希存储，输入变化会重新计算；复用结果仍经过结构校验。

`running.lock` 防止同一目录同时执行。正常完成/报错会释放；若进程被强制终止，需要确认该任务进程已结束后移除遗留锁，再恢复。当前没有自动调度重试队列，也不把本地修改时间校验宣称为源视频的完整内容哈希校验。
