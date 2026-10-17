# scripts/ 自检与回归

三条命令，覆盖从环境到端到端：

| 命令 | 查什么 | 耗时 | 依赖 |
| --- | --- | --- | --- |
| `npm run verify` | 宿主契约：DSH 版本、配置 schema、API 形态 | 秒级 | 需要已装好的 DSH |
| `npm run check:env` | 推理环境：Python 3.10 / torch 2.10+cu128 / transformers 5.17 / TensorRT 10.13 + 依赖导入 | 秒级 | 需要推理环境 |
| `npm run check:asr` | 识别第 1 层端到端：worker 就绪（nano-gpu）、夹具识别、中文编码、端到端耗时 | 约 10 秒（含加载 6 秒） | 需要推理环境 + `funasr-nano-hf` 模型 |
| `npm run check:tts` | 朗读云端链路（edge）：默认语速与改速合成、音色列表 | 秒级 | 需要联网 |
| `npm run check` | 依次跑 env + asr | 约 10 秒 | 同上 |

## 判读

每行以 `PASS` / `FAIL` 开头，退出码 0 表示全过。失败时按标签定位：

- `解释器存在` / `Python 版本` / `torch 版本` 等 → 环境装错或路径指错，用参数或环境变量覆盖：
  `node scripts/check-env.mjs <python.exe>`、`DSH_VOICE_PYTHON`。
- `worker 就绪` 失败 → 看 stderr；常见是显卡不可用或 TensorRT 版本不符。
- `文本符合预期` 失败 → 模型换了或夹具被替换，比对输出里给出的期望/实得。
- `中文编码正常` 失败 → Python 的 stdout 编码又回了系统默认（cp936），检查 worker 顶部的 `reconfigure` 和 spawn 时的 `PYTHONUTF8`。

## 什么时候跑

- 装完环境、换机器、升级任意一个关键版本（torch / transformers / TensorRT / sherpa）之后。
- 改过 `lib/asr-nano-worker.py` 或识别链路之后。
- 发版前。

性能与音质这类"慢指标"（语料词准确率、UTMOS 配对）不在这里，它们是按需跑的回归，见文档《ASR优化与预热方案》。


## 装环境（一键）

```
node scripts/install-env.mjs            # 装到 %LOCALAPPDATA%\dsh-voice-mode\runtimes\py310-cu128
node scripts/install-env.mjs --no-models # 只装环境，不下载模型
node scripts/install-env.mjs <python.exe> # 指定 Python 3.10
```

它做的事：找到 Python 3.10 → 建虚拟环境 → 按基线装 torch（CUDA 12.8 轮子）、ASR 与 TTS 依赖、
piper_phonemize、TensorRT 10.13 → 下载识别模型 → 跑 `check-env` 自检。
幂等：重复跑只会补齐缺的部分。

国内网络可以加镜像：

```
DSH_VOICE_PIP_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple HF_ENDPOINT=https://hf-mirror.com node scripts/install-env.mjs
```


## 覆盖范围

现有自检与回归只覆盖**按住说话**这条主路径（含朗读中途开口即停的打断行为）。
持续聆听 + 自动打断（全双工）依赖回声消除与端点判断，时序受设备和房间影响，
没有纳入自动化回归；改动那部分时必须人工验一遍。
