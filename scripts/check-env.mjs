// 本机推理环境自检。
//
//   node scripts/check-env.mjs [python 路径]
//
// 只检查"环境能不能用"，不加载模型；端到端冒烟见 check-asr.mjs。
// 装完环境、或者升级 torch / transformers / TensorRT 之后跑一次。
//
// 版本基线（对应文档《ASR优化与预热方案》第十一节）：
//   Python 3.10、torch 2.10+cu128、transformers 5.17、TensorRT 10.13.3.9

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_PY = join(
  process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
  "dsh-voice-mode", "runtimes", "py310-cu128", "Scripts", "python.exe"
);
const py = process.argv[2] ?? process.env.DSH_VOICE_PYTHON ?? DEFAULT_PY;

const PROBE = `
import json, sys
out = {"python": sys.version.split()[0]}
try:
    import torch
    out["torch"] = torch.__version__
    out["cuda"] = bool(torch.cuda.is_available())
    out["gpu"] = torch.cuda.get_device_name(0) if out["cuda"] else None
except Exception as e:
    out["torchError"] = str(e)[:200]
for name in ("transformers", "soundfile", "lhotse", "vocos", "jieba", "piper_phonemize", "numpy"):
    try:
        mod = __import__(name)
        out[name] = getattr(mod, "__version__", "ok")
    except Exception as e:
        out[name] = "MISSING: " + str(e)[:120]
try:
    import tensorrt
    out["tensorrt"] = tensorrt.__version__
except Exception as e:
    out["tensorrt"] = "MISSING: " + str(e)[:120]
print("PROBE_JSON " + json.dumps(out, ensure_ascii=False))
`;

let failed = 0;
const report = (ok, label, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "：" + detail : ""}`);
  if (!ok) failed += 1;
};

report(existsSync(py), "解释器存在", py);
if (!existsSync(py)) {
  console.log("提示：用 node scripts/check-env.mjs <python.exe> 或设 DSH_VOICE_PYTHON 指定路径。");
  process.exit(1);
}

const run = spawnSync(py, ["-c", PROBE], { encoding: "utf8", timeout: 120000 });
const line = (run.stdout ?? "").split(/\r?\n/).find((l) => l.startsWith("PROBE_JSON "));
if (!line) {
  report(false, "探针执行", (run.stderr ?? "").trim().slice(0, 300) || "无输出");
  process.exit(1);
}
const info = JSON.parse(line.slice("PROBE_JSON ".length));

report(info.python?.startsWith("3.10"), "Python 版本", info.python + "（基线 3.10）");
report((info.torch ?? "").startsWith("2.10"), "torch 版本", info.torch ?? info.torchError ?? "缺失");
report(info.cuda === true, "CUDA 可用", info.gpu ?? "不可用");
report((info.transformers ?? "").startsWith("5.17"), "transformers 版本", info.transformers ?? "缺失");
report(!(info.tensorrt ?? "").startsWith("MISSING") && (info.tensorrt ?? "").startsWith("10.13"), "TensorRT 版本", info.tensorrt ?? "缺失");
for (const name of ["soundfile", "lhotse", "vocos", "jieba", "piper_phonemize"]) {
  const v = info[name];
  report(typeof v === "string" && !v.startsWith("MISSING"), "依赖 " + name, v ?? "缺失");
}

console.log(failed === 0 ? "全部通过。" : failed + " 项未通过。");
process.exit(failed === 0 ? 0 : 1);
