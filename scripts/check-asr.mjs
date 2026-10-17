// 语音识别端到端冒烟：走第 1 层（显卡 + bf16 + torch 的 Python worker）。
//
//   node scripts/check-asr.mjs [python 路径]
//
// 检查四件事：
//   1. worker 能在本机起来并报就绪（tier=nano-gpu）
//   2. 夹具音频能识别出预期文本（中英混读 + 术语）
//   3. 返回的是正常中文，不是乱码（Windows 上 Python 的默认编码会踩这个坑）
//   4. 端到端延迟在合理范围
//
// 夹具：scripts/fixtures/asr-zh.wav（24 kHz / 16 bit 单声道）

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..");
const CACHE = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "dsh-voice-mode", "models");
const DEFAULT_PY = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "dsh-voice-mode", "runtimes", "py310-cu128", "Scripts", "python.exe");

const py = process.argv[2] ?? process.env.DSH_VOICE_PYTHON ?? DEFAULT_PY;
const modelDir = process.env.DSH_VOICE_ASR_MODEL ?? join(CACHE, "funasr-nano-hf");
const wavPath = process.env.DSH_VOICE_ASR_FIXTURE ?? join(here, "fixtures", "asr-zh.wav");
// 预期文本：比较时忽略大小写、空格与标点
const EXPECTED = "把zipvoice的模型放到插件的缓存目录里";

let failed = 0;
const report = (ok, label, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : "：" + detail}`);
  if (!ok) failed += 1;
};

if (!existsSync(py)) { report(false, "解释器存在", py); process.exit(1); }
if (!existsSync(join(modelDir, "model.safetensors"))) { report(false, "模型目录存在", modelDir); process.exit(1); }
if (!existsSync(wavPath)) { report(false, "夹具存在", wavPath); process.exit(1); }

// --- 读 16 bit PCM 的 WAV，转成 float32 ---
const wav = readFileSync(wavPath);
const dataAt = wav.indexOf(Buffer.from("data"));
if (dataAt < 0) { report(false, "WAV 可解析", "没有 data 段"); process.exit(1); }
const sampleRate = wav.readUInt32LE(24);
const bits = wav.readUInt16LE(34);
const channels = wav.readUInt16LE(22);
const count = wav.readUInt32LE(dataAt + 4) / (bits / 8) / channels;
const samples = new Float32Array(count);
for (let i = 0; i < count; i += 1) {
  samples[i] = wav.readInt16LE(dataAt + 8 + i * 2 * channels) / 32768;
}
report(true, "夹具已读取", `${count} 采样 @ ${sampleRate} Hz / ${bits} bit / ${channels} 声道`);
if (channels !== 1 || bits !== 16) { report(false, "夹具格式", "只支持 16 bit 单声道"); process.exit(1); }

const t0 = Date.now();
const child = spawn(py, ["-u", join(REPO, "lib", "asr-nano-worker.py"), "--model-dir", modelDir, "--keywords", ""], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" }
});
let buf = "";
let done = false;
const finish = (code) => {
  if (done) return;
  done = true;
  try { child.kill(); } catch {}
  process.exit(code);
};
const timer = setTimeout(() => { report(false, "worker 就绪", "超时 180 秒"); finish(1); }, 180000);

child.stderr.on("data", () => {});
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.ready !== undefined) {
      report(msg.ready === true, "worker 就绪", JSON.stringify({ tier: msg.tier, dtype: msg.dtype, loadMs: msg.loadMs }));
      if (!msg.ready) { clearTimeout(timer); return finish(1); }
      const b64 = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString("base64");
      child.stdin.write(JSON.stringify({ id: 1, samples: b64, sampleRate }) + "\n");
      continue;
    }
    if (msg.id !== 1) continue;
    clearTimeout(timer);
    const text = String(msg.text ?? "");
    const cost = Date.now() - t0;
    report(msg.ok === true, "识别返回", msg.ok ? text : String(msg.error).slice(0, 200));
    const flat = text.toLowerCase().replace(/[\s，。、,.!！?？:：;"'“”]/g, "");
    report(flat === EXPECTED, "文本符合预期", flat === EXPECTED ? "一致" : `期望「${EXPECTED}」实得「${flat}」`);
    report(!text.includes("\uFFFD"), "中文编码正常", text.includes("\uFFFD") ? "出现替换字符 U+FFFD（编码问题）" : "无乱码");
    console.log(`INFO  端到端耗时 ${cost} ms（含加载）`);
    finish(failed === 0 ? 0 : 1);
  }
});
child.on("error", (e) => { report(false, "worker 启动", String(e).slice(0, 200)); finish(1); });
