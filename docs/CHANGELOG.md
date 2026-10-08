# 变更记录

本文件记录 `dsh-voice-mode-desktop` 的改动过程，按"在做什么的时候撞上什么"组织，便于同版本环境复现与排查。

第一次适配在 2026-09-30 ~ 10-01 完成，目标环境：Windows + DSH NEXT 桌面版 `2.0.17-next`（内部 `@deepseek-ai/* 0.2.0-rc.2`）。

---

## 1. 踩坑现场

| 当时在做的事 | 撞上的现象 | 根因 | 依据 |
|---|---|---|---|
| 把插件装进桌面版 profile、首次重启 | 插件持续 `failed to import` | 先用裸包名挂载第三方 profile 插件，在 0.2 下解析不到；随后发现依赖 `msedge-tts` 里的 `require("buffer/index")` 在 Electron 的 Node 模式下解析失败（`createRequire(...).resolve.paths` 对子路径返回空） | 宿主启动日志 + 独立复现脚本 |
| 插件刚能导入 | 桌面版进入 recovery，界面起不来 | 客户端服务 `settingsScope` 自 0.1.7-rc.1 起被移除，插件仍在 `inject` 中声明它；桌面版把"有 entry 未激活"当作致命错误 | 应用诊断 JSON：`runtime.phase=recovery`、`pending (waiting for service: settingsScope)` |
| 希望插件的配置项可见可改 | 插件列表里能看到，点进去是空的、无法修改 | 0.2 的插件配置表单只渲染 schema 中标了 `volatile` 的字段，而插件一个都没标 | schema 投影试验：未标时投影为空，标注后得到 `rate`/`mode` |
| 在设置里寻找配置入口 | 设置中没有对应页面 | 渲染插件配置表单的页面（`dsh-client-ui-plugin-manager`）在该部署中未挂载；第三方市场页也不提供配置入口 | 逐包核查设置区注册的页面列表 |
| 用户报告"朗读没有声音" | 日志中每次模型流都记录 `voice=null`（跳过朗读） | 朗读触发要求"模型流的会话号等于当前语音会话号"，而当时语音会话为空 | 宿主日志时间线比对 |

同批发现的两条属于其他插件，不在本仓库范围：默认搜索后端按模型调用计费；某个清理插件自身依赖未安装完整导致导入失败。

---

## 2. 改动时间线（2026-09-30 ~ 10-01，本机时间）

| 时间 | 动作 | 触发原因 | 验证方式 |
|---|---|---|---|
| 21:38 | 将上游 `dsh-voice-mode@0.7.15` 装入桌面 profile | 目标：在该桌面版使用该插件 | 安装成功、文件在位 |
| 21:56 | 重启后 `voice-mode: failed to import` | 见上表第 1 行 | 宿主启动日志 |
| 22:04–22:24 | 定位 Electron 下解析器行为；为 `msedge-tts` 打 `buffer` 补丁；改用相对路径挂载 | 同上 | 独立复现脚本 + 真实宿主启动无报错 |
| 22:24 | 回归：客户端半体进入启动树后 `settingsScope` 缺失，桌面版进入 recovery | 只处理了 host 半体，未同步客户端依赖 | 诊断 JSON |
| 22:33 | 修正客户端 `inject`，并为该访问加 `try`/`catch` | 上述回归 | 启动恢复正常 |
| 23:06–23:14 | 将 `rate`/`mode` 标为 `volatile`，读取点统一解包 | 配置项不可改、且在读取点必须拿到原始值 | 启动无错；投影得到 `rate`/`mode` |
| 23:19 | 确认宿主未挂载插件配置表单页面 | 需要自备设置入口 | 逐包代码核查 |
| 23:35–23:50 | 新增设置页（`plugins.item`）与 `POST /voice-mode/settings` | 目标：配置项可见可改 | 逐步点击 + "已保存"回显 |
| 23:50–00:10 | 状态条收窄、字幕宽度收窄、字幕显隐开关、设置页排版对齐宿主风格 | 界面问题 | 语法校验 + 重启确认 |
| 00:15 | 删除多余改动：两层重复校验、无证据的会话号放宽 | 评审结论：重复且无证据的防御属于劣化 | 模块加载 + 整机启动复验 |
| 00:53 | 归档旧 profile、清理临时脚本 | 桌面版已具备同等能力 | profile 列表与临时目录核对 |
| 01:1x | 固化为本仓库：改名、拆出脚本、补 LICENSE 与自检 | 从"本机改动"变为"可分发的包" | `node scripts/verify-compat.mjs` 全通过 |
| 01:25 | 修正客户端模块 id（`dsh-voice-mode` → `dsh-voice-mode-desktop`） | 包改名后客户端 bundle 仍用旧 id 注册，宿主按包名找不到它，界面上的语音按钮与状态条消失 | 新增自检项"客户端 bundle id 与包名一致"，14/14 通过 |
| 01:5x | 自研云端朗读客户端 `lib/edge-tts.js`，移除 `msedge-tts` 依赖与安装脚本 | 第三方库里的 `require("buffer/index")` 在桌面宿主上解析失败会导致整个插件无法加载；靠安装脚本修会被 pnpm 默认拦截，别人装了可能起不来 | 模块直测：合成 18576 / 10080 字节、音色 322 个；端到端：真实 host 上 `POST /voice-mode/preview` 返回 200 `audio/mpeg` 14544 字节，且此时 profile 内已无 `msedge-tts` |
| 02:3x | 发布 0.1.0 到 npm（作用域 `@nutshelllee`） | 目标：让用户能在插件页按包名安装 | 从 npm 装进空 profile，文件与依赖齐全 |
| 02:4x | **修正默认语速下的合成为空**：SSML 的 `<prosody>` 始终带上 pitch / rate / volume 三个属性，`lib/edge-tts.js` 发布为 0.1.1 | 自研客户端的 SSML 只在语速不等于 1 时才输出属性；服务端对没有属性的 `<prosody>` 直接断开连接、返回零音频。默认设置正好走这条路，因此"没改过语速"的用户会完全听不到朗读 | 自检改为覆盖不传语速、语速 1、语速 1.6 三种情况，全部合成成功；端到端 `POST /voice-mode/preview` 在不传语速时返回 200 `audio/mpeg` 8784 字节、语速 1.3 时 13392 字节 |
| 03:0x | 发布 0.1.2：设置页文案与侧栏项跟随界面语言（中文 / English），新增中文说明 `README.zh.md`，两版说明顶部互相切换 | 侧栏项名称与设置页文案此前写死为中文，英文界面的用户会看到中文；仓库此前只有英文说明，中文读者阅读成本高 | 语法检查通过；宿主兼容自检 14/14；改动后从 npm 安装并跑朗读自检 |
| 10-03 02:2x | **朗读前剥离链接**（0.1.3）：`sanitizeForTts` 把 Markdown 链接还原为链接文字、裸网址整段去掉 | 用户反馈朗读会把参考链接逐个念出来，听起来很累；原有清洗只替换 Markdown 符号，链接原样进入合成 | 等价输入输出对比：`[npm 页面](https://…)` → `npm 页面`，`文档在 https://… 这里` → `文档在这里`，`www.example.com` → 去掉；语法检查通过 |
| 10-08 22:2x | **抓到并修掉两个漏点**：① 客户端不再用渲染期快照拼整段再 `setDraft` 覆盖，改为 `inputActions.captureInsertion()` + `insertText(text, span)` 往实时光标处插入（带草稿版本号校验，冲突时拒绝而不是覆盖）；② `finalizeSegment` 的 `segmentEpoch !== epochSnapshot + 1` 守卫不再丢弃整段——改为"段的开合通知"（`config.onSegmentStart/onSegmentEnd`），输入框侧按段号升序排队落地，旧段回来晚了就等它、排在它应该在的位置；③ `submitDraftNow` 增加落地闸门，队列没清空就不发（宁可这次不自动发，也不发半截话），空值判断改用本轮已插入文本 + 快照兜底 | 22:34 那次复现的日志给出定论：`asr final epoch=18 … chars=91` 紧接 `diag final-dropped-epoch {"epoch":18,"now":20,"chars":91}`——整段 91 字被守卫丢弃，用户那轮只收到后一段"也不准确啊"。同轮 `submit-called {"snapshotLen":133,"cachedLen":100}` 另证快照确实滞后 33 字（第一处漏点的形态） | 语法检查通过；行为验证：重启后连说三段（其中一段偏长、说完立刻接下一句），日志中 `segment-open` / `segment-resolved` / `insert-ok` 的段号应升序且与 `asr final` 一一对应，消息里三段齐全、顺序正确 |
| 10-09 01:0x | **修掉自己引入的回归 + 一次减法**：① 22:2x 那次把"段号被顶掉就丢"换成了 `!active`（语音会话一结束就丢），结果"会话尾声说的那句话"被整段丢弃——用户当场遇到，日志两次 `final-dropped-inactive`（52 字与 79 字各丢一段，都只在状态条上一闪）。现改为只在插件界面已卸载时才丢（`config.isLive`），识别到什么就交给输入框，重试分支同步改；② 删掉"老宿主没有 `insertText` 就整段回退 `setDraft`"的兜底（本宿主不可达），并把每句话都会刷的成功日志删掉（`final-sent` / `insert-ok` / `submit-called` / `submit-retry-stop` / `autosend-scheduled` / `autosend-abort` / `autosend-fire`）。现役埋点 15 个，每句话 2 行 | 用户质问"改动是否夹带、是否删坏了功能"。逐行核对：本次删除的只有日志行与一段不可达兜底，控制流未变（`autosend-*` 只是把 `diag` + `return` 简化成 `return`）；`insertText` 在本宿主可用有当晚日志佐证（`insert-ok` 多次返回成功）。反思：写兜底与高频成功日志属于"先加上再说"，此场景下是过度 | 语法检查通过；变量无孤儿（`draftRef`/`retryCount`/`phaseRef` 等仍在用）；待运行时确认：会话尾声的句子能落地、日志每句话只剩 2 行 |
| 10-08 23:1x | **发布 0.1.4**：版本 0.1.3 → 0.1.4；`files` 补上 `lib/voice-dict.mjs` —— 代码在启动时就 import 它，此前却没有随包发布，从 npm 装这一版会直接加载失败；两版 README 各补两条限制：诊断会把识别原文写进本机日志、纠错词表是本地文件不入库 | 推到公共仓库前做的打包与隐私核对：仓库里没有用户名、路径、邮箱等个人信息；词条数据在 `~/.dsh/voice-dict.json`，在仓库之外 | 语法检查通过；`git ls-remote` 通；推送后核对仓库文件清单 |
| 10-08 19:5x | **只加诊断、不改行为**：host 半体新增 `POST {base}/diag`（把诊断事件转写成一行日志），客户端新增 `diag()`（发完即忘）并埋点 `finalize-skipped-playing` / `final-sent` / `final-dropped-epoch` / `final-empty` / `segment-open` / `segment-resolved` / `insert-*` / `submit-*` / `autosend-*`；`asr final` 由截断 40 字改为最多 400 字；客户端加载时发一条 `client-boot` 做通道自检 | 用户报告连续说话时"前面那截没进输入框"。客户端 `console.log` 根本不进应用日志（`lib/main.js` 的 `console-message` 只放行 `[next-ui-diagnostic]` 等固定标记），没有日志就无法判定丢在哪一步 | 已验证：日志出现 `[dsh-voice-mode] diag client-boot {"build":"4575aac"}`，通道通；复现一次后逐段对齐 `asr final` 与 `diag` 行，定位到上面那两个漏点 |

修掉的这两个漏点（先由日志判定，再动代码）：

1. **覆盖**：`engine.onSegment` 原来用渲染期快照 `draftRef.current` 做"读—改—写"再 `setDraft` 覆盖整段。快照只在界面重画时刷新，两段识别在同一个渲染窗口内落地时，后一段用陈旧的前值拼串，把前一段覆盖掉。现在写入交给宿主的 `insertText(text, span)`：位置来自 `captureInsertion()` 的实时取点，草稿版本号对不上时它返回失败而不是覆盖；失败就留在队首重试（每 150ms 一次，直到成功），绝不静默丢字，也不覆盖用户选中的内容。
2. **丢弃**：`finalizeSegment` 里 `segmentEpoch !== epochSnapshot + 1` 的两处守卫，会在"这段的响应回来时已经开始了新的一段"时把整段已识别文字丢掉（22:34 那次正是如此）。现在段在定稿开始时"开"、拿到文字或确认拿不到时"合"，输入框侧按段号升序排队：更早的段没落地就压住后面的，落地顺序永远与说话顺序一致；再加 30 秒超时兜底，防异常路径把队列卡死。
3. 顺带把 `submitDraftNow` 的落地闸门补上：队列没清空就不发消息，避免把半截话自动发出去。

宿主那条写入接口（`inputActions.captureInsertion()` / `insertText(text, span)`）与官方 `dsh-experimental-client-ui-voice-input` 用的是同一条，语义为"插在取点处、冲突即拒绝"。`insertText`/`captureInsertion` 不存在时会退回旧的整段覆盖写法，保证老版本宿主仍可用。

---

## 3. 被否决或回退的做法

- **裸包名挂载第三方 profile 插件**：在 0.2 下导入失败，改为 bundle patch 挂载本包。
- **"会话号不一致也朗读"的放宽**：无证据支撑（改动前朗读可用），已回退，仅保留一行诊断日志。
- **在读取点叠加两层速率/音色校验**：与入口解包重复，已删除。
- **依赖宿主官方插件配置表单**：该页面在此部署未挂载，路线作废，改为自带设置页。

---

## 4. 维护契约

1. **改动集中在 `lib/` 的两个文件**：`index.js`（host 半体：schema、设置端点、诊断日志）与 `client.js`（客户端半体：inject、设置页、字幕与状态条）。
2. **每条改动都能指到一次失败**：新增改动前先确认现象与日志；删除某条改动应当重新出现对应失败。
3. **`msedge-tts` 的补丁不进本仓库**：它是依赖包的本地修改，由 `scripts/fix-msedge.mjs` 在安装后处理。
4. **升级上游**：合并新版本时，对照本文件逐条确认改动是否仍需要（上游若已官方支持 0.2，对应改动可移除）。
