# 终末地 / B站直播 ASR 校核词库

版本：2026-11-17。词库文件：[zh-streaming.json](../resources/lexicons/zh-streaming.json)。这是有来源的首批词汇和可扩展纠错规则，不是完整游戏数据库，也不表示字幕已经逐句听校。

## 来源和用途

- [终末地角色列表](https://zmdwiki.com/user_list)：管理员、佩丽卡、陈千语、莱万汀、骏卫、黎风等 23 个去重名称。
- [BWIKI 游戏资料](https://wiki.biligame.com/zmd/MediaWiki:CharCulture.json)：终末地工业、宏山城、武陵科学发展区、源石技艺等名称，以及页面目录中的系统术语。
- [物品资料](https://www.endfield.games/zh-Hans/items/)：帝江号、四号谷地、武陵、拉冬。
- [B站大航海说明](https://live.bilibili.com/p/html/live-app-guard/index-center.html)：舰长、提督、总督、大航海、舰队、粉丝勋章。
- [B站开播指南](https://live.bilibili.com/blackboard/era/u4EPvXpDYUMv7hYJ.html)、[醒目留言说明](https://live.bilibili.com/blackboard/live-superchat-intro-web.html)：直播用语、SC、醒目留言。

词库里 canonical terms 是核对拼写用的参考表；规则中的错误写法是人工整理的同音候选，不是来自官方的错误词汇，也不代表已有误识别频率统计。游戏资料站属于社区资料，应随版本继续核验。角色昵称、普通词（如“别离”“武林”）和不确定专名只提示复核，不做全局替换。“上剑→上舰”由用户确认，再加局部直播语境和武器用语排除条件后自动修正。“本身→本声”为配音话题复核项。

## 接入

在 `transcribe_video` 和 `export_selected_clips` 两步使用相同参数：

```json
{"lexiconProfiles": ["endfield", "bili-live"]}
```

这是显式启用的 ASR 后处理；不假装是解码器热词，也不会默认改其他题材。用户导入的 SRT/VTT 视为已编辑文本，不再自动改写。

JSON 转写返回 `lexiconAudit`，分页对应当前页；导出将所选时间段的校核记录写入 `selection.json`。记录包含原词、建议词、句时间、处理状态和理由。原始 ASR 缓存不改写，查看稿和导出使用同一校核逻辑。

只有等长替换、字词拼接与原句一致时才自动修正，所有原字词时间保持不变。其他情况进入 `review`。新增错误写法默认设为 `review`；只有得到确认且能明确限定语境，才添加 `context` 规则。

词库不能替代回听：漏字、游戏对白与主播叠音、整句错识别、说话人混淆仍需单独处理。音近但证据不足时，不得根据剧情常识补写对白。
