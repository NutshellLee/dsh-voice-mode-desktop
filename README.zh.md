# dsh-voice-mode-desktop

[English](./README.md) | 中文

为 **DeepSeek Harness 0.2 桌面版**提供的全双工语音模式：说话时文字实时流入草稿，停顿后自动发送，回复按句朗读，朗读期间再次开口会立刻打断。附带一个应用内设置页，可调朗读语速、录音方式与字幕显示。

本项目是 [`dsh-voice-mode`](https://github.com/qishuilalala/dsh-voice-mode) 0.7.15 的适配分叉（它又源自 [`haoku123/dsh-voice`](https://github.com/haoku123/dsh-voice)）。三者均为 MIT 许可，见 [LICENSE](./LICENSE)。

**这个分叉做了什么：** 让上述插件能在 DSH 0.2 桌面版上运行——适配它依赖的客户端接口、补一个应用内设置页、把云端朗读的第三方依赖换成仓库内自带的实现。识别、打断、本地朗读这些引擎都是上游原样代码，未作改动。

- 上游声明的兼容范围到 DSH 0.1.7-rc.1，代码按 0.1 的客户端接口编写。
- 本分叉面向 DSH **0.2.0-rc.2**（DSH NEXT 桌面版 `2.0.17-next` 随附的版本）：该版本移除了客户端服务 `settingsScope`，插件配置表单也只渲染标了 `volatile` 的字段。
- 已在 Windows、DSH NEXT 桌面版 `2.0.17-next`、`@deepseek-ai/* 0.2.0-rc.2` 上验证。其他版本未测。

## 能做什么

- **语音输入**：按住说话或持续聆听，识别结果实时进入可编辑的草稿，停顿后自动发送。
- **语音输出**：按句朗读（默认走 Edge 云端合成，可选本地 VITS / Kokoro），带实时字幕。
- **全双工**：朗读期间开口即打断播放并取消当前回合。
- **设置页**：朗读语速（0.5–2.0）、录音方式（按住说话 / 持续聆听）、字幕显隐，以及一键试听自检。入口在侧栏「插件」页里的「语音模式」一项。自检特意把合成与播放分开，听不到声音时能判断是引擎的问题还是输出设备的问题。

## 一次对话的流程

1. 按住快捷键说话，识别结果实时写进可编辑的草稿。
2. 松手提交，agent 开始回复。
3. 回复按句合成朗读，字幕同步显示。
4. 朗读过程中再开口，会立刻打断播放，进入下一轮。
5. 什么时候说完、什么时候让它动，都由松手这一个动作决定。

## 使用方式：推荐按住说话

这个插件的日常用法是**按住说话**：按住快捷键说一句，松手提交。语音会话里把「录音方式」选成按住说话，把「打断方式」选成手动。

**全双工（持续聆听 + 自动打断）不是推荐的日常用法，也基本没做回归测试。** 原因很实在：它把节奏交给了模型。它可能在你还没说完就开始动作，也可能你已经说完它还在听；你想控制"什么时候停、什么时候做"，反而控制不住。按住说话把这两个决定都留给你——松手才算说完，说完才允许它动作。

- 想稳定可控：按住说话 + 手动打断（推荐）。
- 想试全双工：可以开，但请当实验特性。遇到"抢话"或"该停不停"，先切回按住说话再判断是不是插件的问题。

## 识别引擎（三档）

| 档位 | 模型 | 跑在哪 | 速度 | 资源 | 备注 |
|---|---|---|---|---|---|
| 显卡优先 | Nano bf16 | 显卡 | 约 0.4 秒/句 | 首次加载约 6～9 秒，常驻约 1.9G 显存 | 最准，默认 |
| 仅 CPU | Nano int8 | CPU | 约 0.9 秒/句 | 不占显存，不需要 Python | 慢一点但稳 |
| 仅 SenseVoice | SenseVoice int8 | CPU | 快 | 最省资源 | 英文术语较弱 |

在设置页切换后立即生效并写入磁盘，重启应用后保持。设置页状态行会显示当前档位、显卡层状态和最近一次识别耗时。

## 朗读引擎

| 引擎 | 位置 | 特点 | 速度 |
|---|---|---|---|
| Edge | 云端 | 音色多，需要联网 | 受网络影响 |
| ZipVoice | 本地显卡 | 克隆音色、中英混合自然 | 约 0.6 秒/句，配合时域拼接可播到 2 倍速 |
| VITS | 本地 CPU | 轻量离线 | 慢于显卡方案 |
| Kokoro | 本地 | 轻量离线备选 | 快，但英文单词读不准 |

切换朗读引擎之后第一次合成会慢几秒（加载模型），之后按句合成。

## 与上游 `dsh-voice-mode` 0.7.15 的差异

| 方面 | 改动 | 原因 |
|---|---|---|
| 客户端半体 | `inject` 不再声明 `settingsScope`，对该服务的访问用 `try`/`catch` 兜住 | `settingsScope` 已从 DSH 客户端接口移除；宿主把"有 entry 未激活"当作致命错误，桌面版会直接进恢复模式 |
| 配置 schema | `rate` 与 `mode` 标为 `volatile`，并在所有读取点解包 | DSH 0.2 的插件表单只渲染 `volatile` 字段；把包装对象直接交给合成引擎会让朗读静默失败 |
| 设置界面 | 新增应用内设置页（侧栏插件 → 语音模式）与宿主接口 `POST /voice-mode/settings`；排版对齐宿主官方设置页，颜色使用宿主主题变量 | 上游的设置卡片依赖已移除的客户端接口；渲染插件配置表单的宿主页面在这个桌面部署里没有挂载 |
| 字幕 | 增加显示 / 隐藏开关，字幕最大宽度收紧（默认档 420 像素） | 字幕是可选项，原先的默认宽度会占满大半个窗口 |
| 状态条 | 宽度按内容收缩、居中、上限 480 像素 | 原先会铺满整个输入区 |
| 诊断 | 当模型流因语音会话不匹配而被跳过时输出一行日志 | 让"没有朗读"这类静默问题可以从日志复现 |
| 打包 | 重命名包；挂载补丁用包内相对路径引用本包 | 让适配变成一个可安装的包，而不是一堆本地改动；同时绕开宿主对 profile 级第三方插件的裸包名解析 |
| 云端合成 | 用仓库内的 Edge 朗读客户端（`lib/edge-tts.js`）替代 `msedge-tts` 依赖 | `msedge-tts` 里的 `require("buffer/index")` 在 DSH 桌面宿主上解析失败，导致插件整体无法加载。自带这个约一百八十行的客户端后，安装是一步到位，不需要再给依赖打补丁 |

其余部分——识别、合成引擎、打断、唤醒词、让位语义、模型校验——都是上游代码，未改。

### 改动范围

基线：npm 上的 `dsh-voice-mode@0.7.15`（其本身源自 `haoku123/dsh-voice`）。本分叉触及的文件：

| 文件 | 改动性质 |
|---|---|
| `lib/index.js` | 宿主半体：schema 的 `volatile` 字段、`POST /voice-mode/settings`、一行诊断日志；Edge 引擎改为调用仓库内的客户端 |
| `lib/client.js` | 客户端半体：`inject` 列表、`settingsScope` 守卫、设置页、字幕显隐与宽度、状态条宽度 |
| `lib/edge-tts.js` | 本分叉新增 |
| `cordis.patch.yml`、`package.json` | 挂载点与打包信息（重命名包、不含安装脚本） |
| `scripts/verify-compat.mjs`、`scripts/check-tts.mjs` | 本分叉新增 |

`lib/sense-worker.mjs` 与 `lib/tts-vits-worker.cjs` 为上游文件，逐字节一致。上游项目保有自己的提交历史、测试与构建流程；本仓库是兼容适配，不是重写。

## 安装

这是一个 DSH bundle，装进某个 profile：

```bash
# 从 npm 仓库安装
dsh plugin add @nutshelllee/dsh-voice-mode-desktop

# 或从本地检出安装
dsh plugin add link:/path/to/dsh-voice-mode-desktop

# 或不经过包仓库，直接用仓库地址：
#   dependency: "@nutshelllee/dsh-voice-mode-desktop": "git+https://github.com/NutshellLee/dsh-voice-mode-desktop.git"
```

然后在 profile 清单（`dsh.profile.bundles`）里启用它，需要的话在 profile 补丁里覆盖默认值：

```yaml
- id: voice-mode
  config:
    enabled: true
    voice: zh-CN-XiaoxiaoNeural
    rate: 1.1
    mode: hold          # hold = 按住说话，toggle = 持续聆听
    ttsEngine: edge     # edge | vits | kokoro
    bargeInMode: detect
    silenceMs: 1500
    autoSend: true
    spokenFormat: true
```

首次安装后重启应用，然后打开「插件 → 语音模式」调整设置，或在一段对话里按 `Ctrl+Shift+V`。

### 云端朗读

Edge 引擎由 `lib/edge-tts.js` 直接与微软的朗读接口通信（WebSocket 握手、SSML 请求、接收 MP3 分片），不涉及任何第三方合成封装，因此安装不需要安装脚本，也不需要给依赖打补丁。想确认这台机器上是否可用：

```bash
node scripts/check-tts.mjs
```

朗读连接会自动带上代理：先看环境变量 `HTTPS_PROXY` / `HTTP_PROXY`，没有就读 Windows 设置里的系统代理（即 `reg query` 里那个 `ProxyServer`）。微软对来源 IP 敏感——某些网络直连会被直接回 403，走代理就能恢复，而 `ws` 默认不认系统代理，所以这一步必须自己做。想强制直连：把 `NO_PROXY` 设成 `speech.platform.bing.com`。

## 自检

```bash
node scripts/verify-compat.mjs [DSH 应用目录]
```

检查本分叉依赖的几项契约：DSH 应用存在、九个客户端注入目标齐全、宿主不再提供 `settingsScope`、插件客户端半体没有声明缺失的服务、`rate`/`mode` 能作为可编辑字段投影出来。退出码为 0 表示全部通过。

## 模型

仓库内不含模型文件。插件在第一次用到某项能力时自行下载，之后复用本地副本。

| 能力 | 何时下载 | 来源仓库 |
|---|---|---|
| 流式识别（默认） | 首次语音输入 | `csukuangfj/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30`（encoder / decoder / joiner / tokens） |
| 静音检测 | 首次语音输入 | Silero VAD（`silero_vad.onnx`） |
| SenseVoice 识别（`senseVoice: true`） | 首次语音输入 | SenseVoice int8（`model.int8.onnx` 与词表） |
| 本地 VITS 朗读（`ttsEngine: vits`） | 首次用该引擎朗读 | `csukuangfj/sherpa-onnx-vits-zh-ll` |
| 本地 Kokoro 朗读（`ttsEngine: kokoro`） | 首次用该引擎朗读 | Kokoro int8 模型集 |

- **下载源**：优先 `huggingface.co`，失败时用 `hf-mirror.com`。除非在 profile 补丁里设置 `allowCustomHost: true`，否则只接受这两个域名（含 `hf.co`）。可以用 `modelHost` 固定某个镜像。
- **缓存目录**：Windows 上是 `%LOCALAPPDATA%\dsh-voice-mode\models`，其他系统是 `~/.cache/dsh-voice-mode/models`。
- **校验**：每个文件在使用前都会比对固定的 SHA-256；未完成的下载先写成临时文件，校验通过后才改名。
- **进度**：下载与加载进度显示在语音状态条上；失败会在对话里提示，而不是静默忽略。
- **离线**：识别需要模型文件，`ttsEngine: edge` 每次朗读都需要联网。要完全离线，请预先填充缓存目录并改用 `vits` / `kokoro`。

## 已知限制

- **编译产物**：`lib/` 是上游的构建输出加本分叉的改动，并非从源码重新构建；请对照 `dsh-voice-mode@0.7.15` 看差异，不要期待可读的源码结构。
- **默认使用云端合成**：`ttsEngine: edge` 会把朗读文本发送给微软。需要完全本地合成请改用 `vits` 或 `kokoro`。
- **外放时的打断**依赖浏览器的回声消除；在 Windows 上，按住说话或戴耳机最可靠。
- **设置持久化**只覆盖 `rate` 与 `mode` 这两个 `volatile` 字段；其他选项在启动时从 profile 补丁读取。
- **诊断会写本机日志**：为了定位"说过的话整段丢失"，插件把每段识别结果（最多 400 字）和一组链路事件写进 DSH 的应用日志（`desktop-next.log`）。日志只落在本机，诊断接口只监听回环地址（`POST /voice-mode/diag`，同时校验同源）；但它记录的就是你的口述原文，介意的话请定期清理日志，也别把它装在共享账号的机器上。
- **语音纠错词表是本地文件**：词条保存在 `~/.dsh/voice-dict.json`（可用环境变量 `DSH_VOICE_DICT` 覆盖），不随本包发布；仓库里只有匹配逻辑，不含任何人的词条。
- **全双工没有自动化回归**：持续聆听 + 自动打断依赖回声消除和语音端点判断，时序受设备与房间影响。仓库里的自检和语料回归只覆盖按住说话这条主路径，全双工只有人工可用性检查；改动那部分时请手工验一遍。

## 兼容矩阵

| DSH（`@deepseek-ai/*`） | 桌面壳 | 状态 |
|---|---|---|
| 0.2.0-rc.2 | DSH NEXT `2.0.17-next`（Windows） | 已验证（加载、设置、合成、识别） |
| 0.1.7-rc.1 及更早 | — | 请用上游 `dsh-voice-mode` |
| 其他 | — | 未测 |

## 许可与归属

MIT。上游项目的版权声明保留在 [LICENSE](./LICENSE) 中。本分叉为非官方适配，未获上游作者背书；包名与上游不同是刻意为之。

完整的适配记录——按顺序记录了什么失败、每次改动如何验证——见 [docs/CHANGELOG.md](./docs/CHANGELOG.md)。
