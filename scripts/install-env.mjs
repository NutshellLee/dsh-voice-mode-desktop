// 本机推理环境的自动安装。
//
//   node scripts/install-env.mjs [python 路径] [--no-models]
//
// 目标是把"装环境"从一堆手工命令变成一条命令，最后自动跑自检（check-env.mjs）。
// 幂等：重复执行只会补齐缺的部分，已满足的步骤 pip 会直接跳过。
//
// 版本基线（单一出处，改这里就够）：
//   Python 3.10、torch 2.10+cu128、transformers 5.17、TensorRT 10.13.3.9
//
// 可选环境变量：
//   DSH_VOICE_PIP_INDEX   换成国内 pip 镜像，例如 https://pypi.tuna.tsinghua.edu.cn/simple
//   HF_ENDPOINT           换成模型镜像，例如 https://hf-mirror.com

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..");
const LOCAL = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
const DEST = join(LOCAL, "dsh-voice-mode", "runtimes", "py310-cu128");
const MODELS = join(LOCAL, "dsh-voice-mode", "models");
const VENV_PY = join(DEST, "Scripts", "python.exe");

const TORCH_INDEX = "https://download.pytorch.org/whl/cu128";
const PIP_INDEX = process.env.DSH_VOICE_PIP_INDEX ?? "";
const PIPER_INDEX = "https://k2-fsa.github.io/icefall/piper_phonemize.html";

const BASE = [
  "torch==2.10.0", "torchaudio==2.10.0"
];
const ASR = [
  "transformers==5.17.0", "accelerate", "soundfile", "librosa", "numpy<3"
];
const TTS = [
  "lhotse==1.33.0", "vocos==0.1.0", "tensorboard", "jieba", "pypinyin", "cn2an",
  "inflect", "pydub", "setuptools<81"
];
const TRT = ["tensorrt-cu12==10.13.3.9"];
const MODEL_REPOS = [
  ["FunAudioLLM/Fun-ASR-Nano-2512", join(MODELS, "funasr-nano-hf"), "第 1 层识别模型（约 1.6 GB）"],
  ["Qwen/Qwen3-0.6B", join(MODELS, "Qwen3-0.6B"), "第 2 层 int8 用的分词器（约 10 MB）"]
];

const args = process.argv.slice(2);
const noModels = args.includes("--no-models");
const explicitPy = args.find((a) => !a.startsWith("--"));

const steps = [];
let failed = 0;

const run = (title, cmd, argv, opts = {}) => {
  console.log("\n== " + title + " ==");
  const r = spawnSync(cmd, argv, { stdio: "inherit", ...opts });
  if (r.status !== 0) {
    console.log("FAIL  " + title);
    failed += 1;
    return false;
  }
  steps.push(title);
  return true;
};

const pip = (args2) => {
  const argv = ["-m", "pip", "install", "--no-input", "--disable-pip-version-check", ...args2];
  if (PIP_INDEX) argv.push("--index-url", PIP_INDEX);
  return [VENV_PY, argv];
};

// --- 1. 找到 Python 3.10 ---
const findPython = () => {
  const candidates = [];
  if (explicitPy) candidates.push(explicitPy);
  if (process.env.DSH_VOICE_PYTHON) candidates.push(process.env.DSH_VOICE_PYTHON);
  candidates.push("python", "python3", "py -3.10");
  // 常见安装位置：PATH 上那个 python 常常是应用商店的别名桩，不是真解释器。
  candidates.push(
    "D:\\Python310\\python.exe",
    join(process.env.LOCALAPPDATA ?? "", "Programs", "Python", "Python310", "python.exe"),
    "C:\\Python310\\python.exe"
  );
  for (const cand of candidates) {
    if (!cand) continue;
    const parts = cand.split(" ");
    const probe = "import sys; print('.'.join(map(str, sys.version_info[:2]))); print(sys.executable)";
    const r = spawnSync(parts[0], [...parts.slice(1), "-c", probe], { encoding: "utf8", timeout: 20000 });
    if (r.status !== 0) continue;
    const [version, exe] = (r.stdout ?? "").trim().split(/\r?\n/);
    if (version !== "3.10") continue;
    // Windows 应用商店的 python 别名：sys.executable 会指向 WindowsApps，装 venv 会失败
    if ((exe ?? "").toLowerCase().includes("windowsapps")) continue;
    return { cmd: cand, exe: exe ?? cand };
  }
  return null;
};

const pyBase = findPython();
if (!pyBase) {
  console.log("FAIL  找不到 Python 3.10");
  console.log("请先安装 Python 3.10，或用 node scripts/install-env.mjs <python.exe 路径> 指定。");
  console.log("提示：PATH 上的 python 可能是应用商店的别名桩，装不了虚拟环境。");
  process.exit(1);
}
console.log("使用 Python 3.10：" + pyBase.exe);

// --- 2. 创建虚拟环境 ---
if (existsSync(VENV_PY)) {
  console.log("\n== 虚拟环境 ==\n已存在，跳过：" + DEST);
} else {
  mkdirSync(dirname(DEST), { recursive: true });
  const baseParts = pyBase.cmd.split(" ");
  if (!run("创建虚拟环境 " + DEST, baseParts[0], [...baseParts.slice(1), "-m", "venv", DEST])) process.exit(1);
  run("升级 pip", VENV_PY, ["-m", "pip", "install", "--no-input", "-U", "pip", "setuptools<81"]);
}

// --- 3. 按顺序装依赖 ---
run("torch + torchaudio（CUDA 12.8 基线）", ...pip([...BASE, "--index-url", TORCH_INDEX]));
run("ASR 依赖", ...pip(ASR));
run("TTS 依赖", ...pip(TTS));
run("piper_phonemize（音素化）", ...pip(["piper_phonemize", "--find-links", PIPER_INDEX]));
run("TensorRT 10.13（注意是 tensorrt-cu12，不是 tensorrt）", ...pip(TRT));

// --- 4. 下载模型（可选）---
if (noModels) {
  console.log("\n== 模型 ==\n按 --no-models 跳过。");
} else {
  const pyScript = [
    "import os, sys",
    "from huggingface_hub import snapshot_download",
    "jobs = " + JSON.stringify(MODEL_REPOS.map(([repo, dir]) => [repo, dir])),
    "for repo, dest in jobs:",
    "    if os.path.exists(os.path.join(dest, 'config.json')) or os.path.exists(os.path.join(dest, 'tokenizer.json')):",
    "        print('已存在，跳过：' + dest); continue",
    "    print('下载 ' + repo + ' -> ' + dest)",
    "    snapshot_download(repo_id=repo, local_dir=dest)",
    "print('模型就绪')"
  ].join("\n");
  mkdirSync(MODELS, { recursive: true });
  run("下载模型", VENV_PY, ["-c", pyScript], { env: { ...process.env } });
}

// --- 5. 自检 ---
console.log("\n== 自检 ==");
const check = spawnSync(process.execPath, [join(here, "check-env.mjs"), VENV_PY], { stdio: "inherit" });
if (check.status !== 0) failed += 1;

// --- 6. 汇总 ---
console.log("\n== 结果 ==");
if (failed === 0) {
  console.log("安装完成，自检通过。");
  console.log("解释器： " + VENV_PY);
  console.log("模型目录：" + MODELS);
  console.log("下一步：重启 DSH；识别会优先走显卡那层。");
  process.exit(0);
}
console.log(failed + " 个步骤未通过，请按上面的输出排查。");
process.exit(1);
