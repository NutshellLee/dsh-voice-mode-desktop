# 重启机制：调研、取舍与定稿（2026-10-18）

## 目标

- agent 为了继续手头的任务而重启后，能自动接上：语音模式恢复、待办回到上下文、识别引擎档位不丢。
- 用户手动关闭再打开应用时，什么都不自动做，不把功能强加给人。

## 结论（定稿）

**外部助手进程 + WMI**。其余路线全部不做。

## 调研过的五条路和代价

### 1. 应用内 Electron relaunch

期望：插件里调 `app.relaunch()` + `app.quit()`，一次调用干净重启。

实测失败：插件宿主不是 Electron 主进程，`createRequire(process.execPath)("electron")` 报
`Cannot find module 'electron'`。不可用。

### 2. 改 DSH 核心，加"无确认重启 IPC"

事实：主进程 `main.js` 里已有 `relaunchApp()`，渲染层也有 IPC command（type = restart / restart-app）。但：

- 这些命令会弹原生确认框（`confirmed(...)`），自动化场景下要人点一下；
- 工具跑在宿主子进程里，碰不到 IPC，必须经界面层转发。

代价：改的是 DSH 的 main.js / preload，应用一升级就被覆盖或冲突，接口也可能变。**放弃。**

### 3. Windows 计划任务（schtasks）拉起助手

代价：多一份系统常驻资源，只为一次重启不值得。**放弃。**

### 4. 社区重启插件（一键重启类，共两个候选）

机制：自带看门狗进程 + 带 token 的 HTTP 路由 + 一组配置项，等于把外部进程再包一层，零件更多。

现状：本机 profile 里的 `@dsh-restart/one-click-restart` 启动时导入失败——
`Cannot find package '@deepseek-ai/dsh-tools'`（从插件目录解析不到）。
补一个依赖链接后导入能过，但按代价评估不值得，**不采用**；链接已撤销。

### 5. 外部助手进程 + WMI（采用）

助手脚本：睡 Delay → 强杀 `DSH NEXT` → 循环等进程清空（≤60s）→ 等 3s →
写一次性标记 `agent-restart.flag` → `Start-Process` 应用；每步写 `restart.log`。

关键：助手必须用 **WMI** 创建（`Invoke-CimMethod Win32_Process Create`），
否则它会跟着应用一起被杀。

证据：`restart.log` 出现 helper2 / tool-restart 行，且应用进程启动时间变化。

## 重启后的自动恢复（机制，不靠对话记性）

- 启动侧只在看到 `agent-restart.flag`（10 分钟内有效）时才读 journal；读完删除标记。
  用户手动启动没有标记，所以不触发任何恢复。
- journal 的 pending 注入 system prompt 的【重启续做】段，新回合先做待办。
- `/voice-mode/config` 带 resumeVoice / resumeSessionId，客户端自动进语音模式；
  成功后 POST `/voice-mode/resume-ack`，journal 变 resumed。
- 识别引擎档位从 `%LOCALAPPDATA%\dsh-voice-mode\settings.json` 读回
  （这版 DSH 的 `ctx.settings.mutate` 不落盘，所以自己存一份）。

## 已知未闭环

- voice-mode 插件里的 `restart_harness` 工具会写 journal / 助手 / 启动器，
  但宿主进程里 spawn 启动器实测静默不生效：日志没有 tool-restart 行，应用进程启动时间不变。
  目前由 agent 在 pwsh 里直接发 WMI 调用完成重启。
- 待办：要么把工具的启动方式改成真正能脱离进程树的写法，要么让工具明确返回
  "已安排、需外部确认"，避免再给出假的 ok。

## 验收标准

四条同时满足才算跑通：

1. `restart.log` 出现这次重启对应的行；
2. 应用进程启动时间变化；
3. `restart-journal.json` 变成 resumed/done；
4. 新回合的 system prompt 出现【重启续做】。

## 自动续跑（2026-10-18 定稿）

重启会杀掉当前回合；而新回合只有被触发才会开始。所以待办要能自己开一个回合。

定稿做法：一次性。应用就绪（插件 apply）后 5 秒，agent-restart 用 ctx.get("sessionController").resolveAgent(sessionId) 拿到 agent，排一条来源标记为 restart 的消息（不是 user），调用 agent.followup(...) 并 flush，开一个新回合并接着做。失败每 3 秒重试，最多 6 次；成功后 journal 变 continued。

不建目标、不标完成、不注入系统提示、不做多轮续跑。干完自然结束。界面上这条消息走“收到执行请求”的系统提示样式，不是用户气泡。

为什么不用 goal：goal 的语义是“回合结束继续下一轮”，需要标完成才会停，还要管轮次上限；我们只要接一次，用它属于语义不匹配、额外加功能。

## 重启职责拆分（2026-10-18）

重启工具和待办注入从语音插件挪到独立小插件 @nutshelllee/dsh-agent-restart（D:\Study\dsh-agent-restart）：

- agent-restart：restart_harness 工具、journal、一次性标记、待办注入、自动续跑。
- voice-mode 插件：只保留语音本身；启动时读 voice-resume.json 这个交接文件决定要不要自动开语音。
- 两个插件之间只通过 %LOCALAPPDATA%\dsh-voice-mode\ 下的文件交接，不互相引用。
- 工具返回值如实：2.5 秒内 restart.log 没有新行就返回 ok=false，不再给假成功。

## 记录位置

- 技能库：`~/.dsh/skills/dsh-restart/SKILL.md`（精简版，跨会话生效）
- 全局规矩：`~/.dsh/AGENTS.md` 第 5 节（指向技能）
- 本文档：完整调研过程与取舍
