// src/index.ts
import z from "@deepseek-ai/schemastery";
import { join as join4 } from "node:path";
import { homedir } from "node:os";
import { rm } from "node:fs/promises";

// src/asr-host.ts
import { statSync, existsSync, readFileSync } from "node:fs";
import { stat as stat2 } from "node:fs/promises";
import { join as join2 } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { rewrite as voiceDictRewrite, dictEntries } from "./voice-dict.mjs";

// src/sense-worker.ts
import { parentPort, workerData } from "node:worker_threads";
function createSenseWorkerClient(worker) {
  let counter = 0;
  const pending = /* @__PURE__ */ new Map();
  let dead = false;
  const deathFns = /* @__PURE__ */ new Set();
  const die = () => {
    if (dead) return;
    dead = true;
    for (const fn of deathFns) {
      try {
        fn();
      } catch {
      }
    }
  };
  worker.on?.("message", (msg) => {
    const p = pending.get(msg?.id);
    if (!p) return;
    pending.delete(msg.id);
    if (!msg.ok) {
      p.resolve(null);
      return;
    }
    p.resolve(p.op === "create" ? true : msg.text ?? "");
  });
  worker.on?.("error", (e) => {
    die();
    const err = new Error("sense worker error: " + String(e?.message ?? e));
    for (const [, p] of pending) p.reject(err);
    pending.clear();
  });
  worker.on?.("exit", () => {
    die();
    const err = new Error("sense worker exited");
    for (const [, p] of pending) p.reject(err);
    pending.clear();
  });
  const request = (op, samples) => {
    if (dead) return Promise.reject(new Error("sense worker dead"));
    const id = counter++;
    return new Promise((resolve, reject) => {
      pending.set(id, { op, resolve, reject });
      const msg = { id, op };
      if (samples) msg.samples = samples;
      try {
        worker.postMessage(msg);
      } catch (e) {
        pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  };
  return {
    request,
    onDeath(fn) {
      deathFns.add(fn);
    },
    terminate: async () => {
      dead = true;
      const err = new Error("sense worker terminated");
      for (const [, p] of pending) p.reject(err);
      pending.clear();
      try {
        await worker.terminate?.();
      } catch {
      }
    }
  };
}
function startSenseWorker(data) {
  const port = parentPort;
  if (!port) return;
  let recognizer = null;
  let sherpa = null;
  port.on("message", async (msg) => {
    try {
      if (msg.op === "create" || msg.op === "decode") {
        if (!sherpa) {
          sherpa = data.sherpaModule === "sherpa-onnx-node" ? ((await import("sherpa-onnx-node")).default ?? await import("sherpa-onnx-node")) : await import(data.sherpaModule);
        }
        if (!recognizer) {
          const modelConfig = data.engine === "nano-cpu" ? {
            // 2026-10-17：第 2 层——Fun-ASR-Nano 的 int8 在 CPU 上跑（sherpa，不需要 Python）。
            funasrNano: {
              encoderAdaptor: data.modelDir + "/encoder_adaptor.int8.onnx",
              llm: data.modelDir + "/llm.int8.onnx",
              embedding: data.modelDir + "/embedding.int8.onnx",
              tokenizer: data.tokenizerDir,
              systemPrompt: "You are a helpful assistant.",
              userPrompt: data.userPrompt,
              maxNewTokens: 200,
              temperature: 0,
              topP: 1,
              seed: 42,
              language: "",
              itn: 1,
              hotwords: ""
            },
            provider: "cpu",
            debug: 0
          } : {
            senseVoice: {
              model: data.modelDir + "/model.int8.onnx",
              language: data.language,
              useInverseTextNormalization: data.useITN
            },
            tokens: data.modelDir + "/tokens.txt",
            provider: "cpu",
            debug: 0
          };
          recognizer = data.engine === "nano-cpu" ? new sherpa.OfflineRecognizer({ featConfig: { sampleRate: 16e3, featureDim: 80 }, modelConfig }) : sherpa.createOfflineRecognizer({
            featConfig: { sampleRate: 16e3, featureDim: 80 },
            modelConfig
          });
        }
        if (msg.op === "decode" && msg.samples) {
          const stream = recognizer.createStream();
          try {
            if (data.engine === "nano-cpu") stream.acceptWaveform({ samples: msg.samples, sampleRate: 16e3 });
            else stream.acceptWaveform(16e3, msg.samples);
            recognizer.decode(stream);
            const text = recognizer.getResult(stream).text.trim();
            port.postMessage({ id: msg.id, ok: true, text });
          } finally {
            try {
              stream.free();
            } catch {
            }
          }
          return;
        }
        port.postMessage({ id: msg.id, ok: true, text: "" });
        return;
      }
      port.postMessage({ id: msg.id, ok: false, error: "unknown op: " + msg.op });
    } catch (e) {
      port.postMessage({ id: msg.id, ok: false, error: String(e) });
    }
  });
}
if (parentPort) {
  startSenseWorker(workerData);
}

// src/asr-host.ts
import sherpa_onnx from "sherpa-onnx";

// src/models.ts
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
var HOST_PRIMARY = "https://huggingface.co";
var HOST_FALLBACK = "https://hf-mirror.com";
var ALLOWED_MODEL_HOSTNAMES = ["huggingface.co", "hf.co", "hf-mirror.com"];
function validateModelHost(raw, allowCustomHost) {
  if (!raw) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const hostname = u.hostname.toLowerCase();
  if (!ALLOWED_MODEL_HOSTNAMES.includes(hostname) && !allowCustomHost) {
    return null;
  }
  return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}`;
}
function redirectHostAllowed(finalUrl, allowCustomHost) {
  try {
    const u = new URL(finalUrl);
    if (u.protocol !== "https:") return false;
    const hostname = u.hostname.toLowerCase();
    if (allowCustomHost) return true;
    return hostname === "huggingface.co" || hostname.endsWith(".huggingface.co") || hostname === "hf.co" || hostname.endsWith(".hf.co") || hostname === "hf-mirror.com" || hostname.endsWith(".hf-mirror.com");
  } catch {
    return false;
  }
}
async function sha256OfFile(path) {
  const hash = createHash("sha256");
  const { createReadStream } = await import("node:fs");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (c) => hash.update(c));
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });
  return hash.digest("hex");
}
async function ensureModelFile(opts) {
  const { repo, repoDir, spec, primaryHost, allowCustomHost, broadcast } = opts;
  const localPath = join(repoDir, spec.file);
  const partPath = `${localPath}.part`;
  if ((await stat(localPath).catch(() => null))?.isFile()) {
    const ok = await sha256OfFile(localPath).catch(() => "") === spec.sha256;
    if (ok) return true;
    await unlink(localPath).catch(() => void 0);
  }
  await mkdir(join(repoDir, spec.file.includes("/") ? spec.file.slice(0, spec.file.lastIndexOf("/")) : ""), {
    recursive: true
  }).catch(() => void 0);
  const hosts = [...new Set([primaryHost, HOST_PRIMARY, HOST_FALLBACK].filter(Boolean))];
  let lastError = "no upstream reachable";
  for (const host of hosts) {
    try {
      const done = await downloadVerified({ ...opts, host, partPath, localPath });
      if (done) return true;
    } catch (e) {
      lastError = String(e);
    }
  }
  broadcast("asr-error", { file: spec.file, reason: "checksum_or_download_failed", detail: lastError });
  return false;
}
async function downloadVerified(opts) {
  const { repo, spec, host, allowCustomHost, partPath, localPath, broadcast } = opts;
  const url = `${host}/${repo}/resolve/main/${spec.file}`;
  const partSt = await stat(partPath).catch(() => null);
  const resumeFrom = partSt?.isFile() ? partSt.size : 0;
  const headers = { "user-agent": "dsh-voice-mode" };
  if (resumeFrom > 0) headers.range = `bytes=${resumeFrom}-`;
  const res = await fetch(url, { headers, redirect: "follow" });
  if (!redirectHostAllowed(res.url, allowCustomHost)) return false;
  if (res.status === 416) {
    if (await sha256OfFile(partPath).catch(() => "") === spec.sha256) {
      await rename(partPath, localPath);
      return true;
    }
    await unlink(partPath).catch(() => void 0);
    return false;
  }
  if (res.status !== 200 && res.status !== 206) return false;
  const resume = res.status === 206 ? resumeFrom : 0;
  const total = Number(res.headers.get("content-length") ?? 0) + resume;
  const src = res.body;
  if (!src) return false;
  const sink = createWriteStream(partPath, resume > 0 ? { flags: "a" } : {});
  const reader = src.getReader();
  let received = resume;
  await new Promise((resolve, reject) => {
    sink.on("error", (e) => reject(e));
    sink.on("finish", () => resolve());
    void (async () => {
      try {
        for (; ; ) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          if (!sink.write(value)) {
            await new Promise((r) => sink.once("drain", r));
          }
          if (total > 0) {
            broadcast("asr-progress", {
              file: spec.file,
              percent: Math.min(100, Math.round(received / total * 100))
            });
          }
        }
        sink.end();
      } catch (e) {
        sink.destroy(e);
        reject(e);
      }
    })();
  });
  const actual = await sha256OfFile(partPath).catch(() => "");
  if (actual !== spec.sha256) {
    await unlink(partPath).catch(() => void 0);
    return false;
  }
  await rename(partPath, localPath);
  return true;
}
async function ensureModelTree(opts) {
  const { repo, repoDir, subdir, primaryHost, allowCustomHost, broadcast } = opts;
  const hosts = [...new Set([primaryHost, HOST_PRIMARY, HOST_FALLBACK].filter(Boolean))];
  const subRoot = join(repoDir, subdir);
  await mkdir(subRoot, { recursive: true }).catch(() => void 0);
  let tree = [];
  for (const host of hosts) {
    try {
      const res = await fetch(host + "/api/models/" + repo + "?blobs=true", { headers: { "user-agent": "dsh-voice-mode" } });
      if (res.ok) {
        const j = await res.json();
        tree = (j.siblings ?? []).map((s) => s.rfilename ?? "").filter((f) => f.startsWith(subdir + "/") && f.length > 0);
        if (tree.length > 0) break;
      }
    } catch {
    }
  }
  if (tree.length === 0) return false;
  let allOk = true;
  let done = 0;
  const queue = [...tree];
  const worker = async () => {
    for (; ; ) {
      const rel = queue.shift();
      if (rel === void 0) return;
      const localPath = join(repoDir, rel);
      const partPath = localPath + ".part";
      if ((await stat(localPath).catch(() => null))?.isFile() && (await stat(localPath)).size > 0) {
        done++;
        continue;
      }
      await mkdir(join(repoDir, rel.slice(0, rel.lastIndexOf("/"))), { recursive: true }).catch(() => void 0);
      let ok = false;
      for (const host of hosts) {
        try {
          const url = host + "/" + repo + "/resolve/main/" + encodeURIComponent(rel);
          const res = await fetch(url, { headers: { "user-agent": "dsh-voice-mode" }, redirect: "follow" });
          if (!redirectHostAllowed(res.url, allowCustomHost)) continue;
          if (res.status !== 200) continue;
          const sink = createWriteStream(partPath);
          const reader = res.body?.getReader();
          if (!reader) continue;
          let size = 0;
          await new Promise((resolve, reject) => {
            sink.on("error", reject);
            sink.on("finish", resolve);
            void (async () => {
              try {
                for (; ; ) {
                  const r = await reader.read();
                  if (r.done) break;
                  size += r.value.byteLength;
                  if (!sink.write(r.value)) await new Promise((r2) => sink.once("drain", r2));
                }
                sink.end();
              } catch (e) {
                sink.destroy(e);
                reject(e);
              }
            })();
          });
          if (size > 0) {
            await rename(partPath, localPath);
            ok = true;
            break;
          }
        } catch {
        }
      }
      if (ok) {
        done++;
        broadcast("asr-progress", { file: rel, percent: Math.round(done / tree.length * 100) });
      } else {
        allOk = false;
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, () => worker()));
  return allOk;
}

// src/asr-host.ts
var { createOnlineRecognizer, createVad } = sherpa_onnx;
var MODEL_REPO = "csukuangfj/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30";
var MODEL_FILES = [
  { file: "encoder.int8.onnx", sha256: "5ac51e27981bb4dab01bb9be4958453ba50c3b61c063ddda0eab23fd3671aa4f" },
  { file: "decoder.onnx", sha256: "06522ad63cec0fdf6809f4e1db9bb4f7d710c34582e3b35db62ac60eccafac7e" },
  { file: "joiner.int8.onnx", sha256: "b34584dc6f561089e1d747fedebb3765f2caa72c927ef54d7ca55e5ae40a814b" },
  { file: "tokens.txt", sha256: "6193c7ea1c96d0d9a1e9652789b40d13a8a913b434a5451e93158f5a09fd6652" }
];
var VAD_REPO = "csukuangfj/vad";
var VAD_FILES = [
  { file: "silero_vad.onnx", sha256: "a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28" }
];
var SENSE_REPO = "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17";
var SENSE_FILES = [
  { file: "model.int8.onnx", sha256: "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51" },
  { file: "tokens.txt", sha256: "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc" }
];
function pcmToSamples(buf) {
  if (buf.length % 4 !== 0) return null;
  return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
}
var MAX_ASR_BYTES = 4 * 1024 * 1024;
var SEGMENT_IDLE_MS = 9e4;
var VAD_CONTINUE_RMS = 0.02;
var CONFIRM_CONJUNCTION_MS = 800;
var CONFIRM_LONG_SENTENCE_MS = 350;
var CONFIRM_LONG_SENTENCE_S = 8;
var CONFIRM_MIN_MS = 200;
var CONJUNCTION_TAIL = /(然后|还有|以及|并且|而且|此外|再说|接着|然后呢|比方说|比如说|比如|例如|等等|或者|或是|还有呢)$/;
function endpointConfirmMs(text, spokenMs) {
  const tail = text.trimEnd();
  if (CONJUNCTION_TAIL.test(tail)) return CONFIRM_CONJUNCTION_MS;
  if (spokenMs > CONFIRM_LONG_SENTENCE_S * 1e3) return CONFIRM_LONG_SENTENCE_MS;
  return CONFIRM_MIN_MS;
}
function rmsOf(samples) {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}
function createAsrRuntime(options) {
  const { cacheDir, modelHost, broadcast, senseVoice, silenceMs, senseITN, allowCustomHost, bargeInMode, pythonExe } = options;
  // 2026-10-17：ASR 引擎档位，实时读设置。auto=显卡优先，cpu=只用 CPU int8，sensevoice=只用 SenseVoice。
  const asrEngine = () => {
    const v = options.asrEngine ? options.asrEngine() : "auto";
    return v === "cpu" || v === "sensevoice" ? v : "auto";
  };
  let lastProgress = null;
  const localBroadcast = (event, payload) => {
    if (event === "asr-progress") lastProgress = payload;
    broadcast(event, payload);
  };
  const repoDir = join2(cacheDir, MODEL_REPO);
  const vadDir = join2(cacheDir, VAD_REPO);
  const senseDir = join2(cacheDir, SENSE_REPO);
  const normalizedModelHost = () => validateModelHost(modelHost(), allowCustomHost) ?? HOST_PRIMARY;
  const segments = /* @__PURE__ */ new Map();
  const finalized = /* @__PURE__ */ new Map();
  const finalizing = /* @__PURE__ */ new Map();
  const resetGen = /* @__PURE__ */ new Map();
  let recognizer = null;
  let modelsReady = false;
  let modelsLoading = null;
  let asrFailAt = 0;
  const ensureModels = async () => {
    if (modelsReady) return true;
    if (Date.now() < asrFailAt) return false;
    if (!modelsLoading) {
      modelsLoading = (async () => {
        for (const f of MODEL_FILES) {
          if (!await ensureModelFile({ repo: MODEL_REPO, repoDir, spec: f, primaryHost: normalizedModelHost(), allowCustomHost, broadcast: localBroadcast })) {
            asrFailAt = Date.now() + 6e4;
            broadcast("asr-error", { file: f.file });
            return false;
          }
        }
        modelsReady = true;
        broadcast("asr-ready", {});
        return true;
      })().finally(() => {
        modelsLoading = null;
      });
    }
    return modelsLoading;
  };
  const getRecognizer = async () => {
    if (!await ensureModels()) return null;
    if (recognizer) return recognizer;
    const t = (f) => join2(repoDir, f);
    recognizer = createOnlineRecognizer({
      modelConfig: {
        transducer: {
          encoder: t("encoder.int8.onnx"),
          decoder: t("decoder.onnx"),
          joiner: t("joiner.int8.onnx")
        },
        tokens: t("tokens.txt"),
        numThreads: 4,
        provider: "cpu",
        debug: 0
      }
    });
    return recognizer;
  };
  let vadModelReady = false;
  let vadLoading = null;
  let vadFailAt = 0;
  const ensureVadModel = async () => {
    if (vadModelReady) return join2(vadDir, VAD_FILES[0].file);
    if (Date.now() < vadFailAt) return null;
    if (!vadLoading) {
      vadLoading = (async () => {
        for (const f of VAD_FILES) {
          if (!await ensureModelFile({ repo: VAD_REPO, repoDir: vadDir, spec: f, primaryHost: normalizedModelHost(), allowCustomHost, broadcast: localBroadcast })) {
            vadFailAt = Date.now() + 6e4;
            return null;
          }
        }
        vadModelReady = true;
        return join2(vadDir, VAD_FILES[0].file);
      })().finally(() => {
        vadLoading = null;
      });
    }
    return vadLoading;
  };
  const newVad = (vadPath, threshold = 0.5, minSilenceDuration = 0.5) => createVad({
    sileroVad: {
      model: vadPath,
      threshold,
      minSilenceDuration,
      minSpeechDuration: 0.25,
      maxSpeechDuration: 20,
      windowSize: 512
    },
    sampleRate: 16e3,
    numThreads: 1,
    provider: "cpu",
    debug: 0,
    bufferSizeInSeconds: 30
  });
  const ensureSessionVad = async (seg) => {
    if (seg.vad) return seg.vad;
    const vadPath = await ensureVadModel();
    if (!vadPath) return null;
    seg.vad = newVad(vadPath, 0.5, silenceMs() / 1e3);
    return seg.vad;
  };
  const detectVads = /* @__PURE__ */ new Map();
  const detectVadLastUse = /* @__PURE__ */ new Map();
  const ensureDetectVad = async (sessionId) => {
    const existing = detectVads.get(sessionId);
    if (existing) return existing;
    const vadPath = await ensureVadModel();
    if (!vadPath) return null;
    const vad = newVad(vadPath, 0.35);
    detectVads.set(sessionId, vad);
    return vad;
  };
  let senseModelReady = false;
  let senseLoading = null;
  let senseFailAt = 0;
  const ensureSenseModel = async () => {
    if (senseModelReady) return join2(senseDir, SENSE_FILES[0].file);
    if (Date.now() < senseFailAt) return null;
    if (!senseLoading) {
      senseLoading = (async () => {
        for (const f of SENSE_FILES) {
          if (!await ensureModelFile({ repo: SENSE_REPO, repoDir: senseDir, spec: f, primaryHost: normalizedModelHost(), allowCustomHost, broadcast: localBroadcast })) {
            senseFailAt = Date.now() + 6e4;
            return null;
          }
        }
        senseModelReady = true;
        return join2(senseDir, SENSE_FILES[0].file);
      })().finally(() => {
        senseLoading = null;
      });
    }
    return senseLoading;
  };
  // ---- Fun-ASR-Nano 的两层（2026-10-17）----
  // 第 1 层：显卡 + bf16 + torch，走 Python 常驻进程（与 TTS worker 同一形态）。
  // 第 2 层：int8 + CPU，走 sherpa（不需要 Python、零显存）。
  // 第 3 层是原来的 SenseVoice int8。
  // 对应文档《ASR优化与预热方案》第十一节：显存实测 1.9～2.25 G、每句 0.42 s（第 1 层）。
  const NANO_CPU_REPO = "sherpa-onnx-funasr-nano-int8";
  const NANO_HF_REPO = "funasr-nano-hf";
  const NANO_TOK_REPO = "Qwen3-0.6B";
  const nanoCpuDir = join2(cacheDir, NANO_CPU_REPO);
  const nanoHfDir = join2(cacheDir, NANO_HF_REPO);
  const nanoTokDir = join2(cacheDir, NANO_TOK_REPO);
  let nanoCpuBroken = false;
  const nanoKeywords = () => {
    try {
      const list = dictEntries().map((e) => e && e.to).filter((s) => typeof s === "string" && /[A-Za-z]/.test(s));
      return [...new Set(list)];
    } catch {
      return [];
    }
  };
  const nanoUserPrompt = () => {
    const kw = nanoKeywords();
    return "请结合上下文信息，更加准确地完成语音转写任务。如果没有相关信息，我们会留空。\n\n\n**上下文信息：**\n\n\n" + (kw.length ? "热词列表：[" + kw.join(", ") + "]\n" : "") + "语音转写成中文：";
  };
  const ensureNanoCpuModel = async () => {
    try {
      for (const fl of ["encoder_adaptor.int8.onnx", "llm.int8.onnx", "embedding.int8.onnx"]) {
        if (!existsSync(join2(nanoCpuDir, fl))) return null;
      }
      if (!existsSync(join2(nanoTokDir, "tokenizer.json"))) return null;
      return true;
    } catch {
      return null;
    }
  };
  let nanoGpu = null;
  let nanoGpuSyncing = null;
  let nanoGpuBroken = false;
  // 2026-10-17：最近一次识别用的是哪一层，供设置面板显示。
  let lastTier = "idle";
  const createNanoGpuClient = (child) => {
    let counter = 0;
    let dead = false;
    let buf = "";
    let readySettle = null;
    const pending = /* @__PURE__ */ new Map();
    const die = (err) => {
      if (dead) return;
      dead = true;
      if (readySettle) {
        readySettle(null);
        readySettle = null;
      }
      for (const [, p] of pending) p.reject(err ?? new Error("nano worker dead"));
      pending.clear();
      nanoGpu = null;
      nanoGpuSyncing = null;
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.ready === false) {
          nanoGpuBroken = msg.reason === "cuda_unavailable";
          die(new Error("nano 第 1 层未就绪: " + String(msg.reason ?? "")));
          continue;
        }
        if (msg.ready === true) {
          if (readySettle) {
            readySettle(msg);
            readySettle = null;
          }
          continue;
        }
        const p = pending.get(msg.id);
        if (!p) continue;
        pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.text ?? "");
        else p.reject(new Error(String(msg.error ?? "decode failed")));
      }
    });
    child.on?.("exit", () => die(new Error("nano worker exited")));
    child.on?.("error", (e) => die(e instanceof Error ? e : new Error(String(e))));
    const ready = new Promise((resolve) => {
      readySettle = resolve;
    });
    return {
      ready,
      transcribe(samples) {
        if (dead) return Promise.reject(new Error("nano worker dead"));
        const id = counter++;
        const b64 = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString("base64");
        return new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          try {
            child.stdin.write(JSON.stringify({ id, samples: b64, sampleRate: 16e3 }) + "\n");
          } catch (e) {
            pending.delete(id);
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        });
      },
      terminate() {
        try {
          child.kill();
        } catch {
        }
      }
    };
  };
  const getNanoGpu = async () => {
    if (nanoGpuBroken) return null;
    if (nanoGpu) return nanoGpu;
    if (nanoGpuSyncing) return nanoGpuSyncing;
    nanoGpuSyncing = (async () => {
      try {
        if (!existsSync(join2(nanoHfDir, "model.safetensors"))) {
          console.log("[dsh-voice-mode] ASR 第 1 层跳过：模型目录里没有 model.safetensors（" + nanoHfDir + "）");
          return null;
        }
        let py = "";
        try {
          py = pythonExe ? pythonExe() : "";
        } catch {
          py = "";
        }
        if (!existsSync(py)) {
          console.log("[dsh-voice-mode] ASR 第 1 层跳过：找不到 python（" + py + "）");
          return null;
        }
        console.log("[dsh-voice-mode] ASR 第 1 层开始加载：" + py);
        const workerPath = fileURLToPath(new URL("./asr-nano-worker.py", import.meta.url));
        const child = spawn(py, ["-u", workerPath, "--model-dir", nanoHfDir, "--keywords", nanoKeywords().join(",")], {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          // 2026-10-17：双保险。worker 自己也会 reconfigure 成 UTF-8，这里在进程层面再钉一次，
          // 免得 Windows 的 cp936 把中文识别结果变成乱码。
          env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" }
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", () => {
        });
        const client = createNanoGpuClient(child);
        const info = await Promise.race([client.ready, new Promise((r) => setTimeout(() => r(null), 18e4))]);
        if (!info) {
          client.terminate();
          return null;
        }
        nanoGpu = client;
        console.log("[dsh-voice-mode] ASR 第 1 层就绪（" + String(info.dtype ?? "") + "，加载 " + String(info.loadMs ?? "?") + " ms）");
        return client;
      } catch (e) {
        console.warn("[dsh-voice-mode] ASR 第 1 层不可用: " + String(e));
        nanoGpuBroken = true;
        return null;
      }
    })().finally(() => {
      if (!nanoGpu) nanoGpuSyncing = null;
    });
    return nanoGpuSyncing;
  };
  let senseWorker = null;
  let senseWorkerSyncing = null;
  let senseWorkerLangKey = "";
  const getSenseWorker = async (engine = "sensevoice") => {
    if (engine === "sensevoice" && !senseVoice()) return null;
    const langKey = `${engine}\0auto\0${senseITN() ? "1" : "0"}`;
    if (senseWorker && langKey !== senseWorkerLangKey) {
      void senseWorker.terminate();
      senseWorker = null;
      senseWorkerSyncing = null;
    }
    senseWorkerLangKey = langKey;
    if (senseWorker) return senseWorker;
    if (senseWorkerSyncing) return senseWorkerSyncing;
    senseWorkerSyncing = (async () => {
      const nanoCpu = engine === "nano-cpu";
      const modelOk = nanoCpu ? await ensureNanoCpuModel() : await ensureSenseModel();
      if (!modelOk) return null;
      try {
        const workerPath = fileURLToPath(new URL("./sense-worker.mjs", import.meta.url));
        const w = new Worker(workerPath, {
          workerData: {
            sherpaModule: nanoCpu ? "sherpa-onnx-node" : "sherpa-onnx",
            engine,
            modelDir: nanoCpu ? nanoCpuDir : senseDir,
            tokenizerDir: nanoTokDir,
            userPrompt: nanoUserPrompt(),
            language: "auto",
            useITN: senseITN() ? 1 : 0
          }
        });
        const client = createSenseWorkerClient(w);
        client.onDeath(() => {
          senseWorker = null;
          senseWorkerSyncing = null;
          senseWorkerLangKey = "";
        });
        if (!await client.request("create")) {
          console.log("[dsh-voice-mode] ASR worker 建识别器失败（" + engine + "），这一层跳过");
          await client.terminate();
          return null;
        }
        senseWorker = client;
        return client;
      } catch (e) {
        console.warn("[dsh-voice-mode] ASR worker init failed (" + engine + "): " + String(e));
        return null;
      }
    })().finally(() => {
      if (!senseWorker) senseWorkerSyncing = null;
    });
    return senseWorkerSyncing;
  };
  const packSamples = (allSamples) => {
    const total = allSamples.reduce((acc, c) => acc + c.length, 0);
    if (total === 0) return null;
    const buf = new Float32Array(total);
    let off = 0;
    for (const c of allSamples) {
      buf.set(c, off);
      off += c.length;
    }
    return buf;
  };
  const senseTranscribe = async (allSamples, engine = "sensevoice") => {
    try {
      const worker = await getSenseWorker(engine);
      if (!worker) return null;
      const buf = packSamples(allSamples);
      if (!buf) return null;
      return await worker.request("decode", buf);
    } catch (e) {
      console.warn("[dsh-voice-mode] ASR re-transcribe failed (" + engine + "): " + String(e));
      return null;
    }
  };
  const finalTranscribe = async (allSamples) => {
    const samples = packSamples(allSamples);
    if (!samples) return "";
    if (asrEngine() === "auto" && !nanoGpuBroken) {
      // 加载是异步的：等最多 1.2 秒，还没就绪就先走下面几层，别让用户干等。
      // getNanoGpu 的加载 Promise 会继续跑，下一句就能用上第 1 层。
      const gpu = await Promise.race([
        getNanoGpu(),
        new Promise((resolve) => setTimeout(() => resolve(null), 1200))
      ]);
      if (!gpu && asrEngine() === "auto" && !nanoGpu) console.log("[dsh-voice-mode] ASR 第 1 层还没就绪，这一句先用下面的层");
      if (gpu) {
        try {
          const t = await gpu.transcribe(samples);
          if (t) {
            lastTier = "nano-gpu";
            console.log("[dsh-voice-mode] asr tier=nano-gpu");
            return t;
          }
        } catch (e) {
          console.warn("[dsh-voice-mode] 第 1 层失败，降级第 2 层: " + String(e));
          nanoGpuBroken = true;
          try {
            gpu.terminate();
          } catch {
          }
        }
      }
    }
    if (asrEngine() !== "sensevoice" && !nanoCpuBroken && await ensureNanoCpuModel()) {
      try {
        const t = await senseTranscribe(allSamples, "nano-cpu");
        if (t) {
          lastTier = "nano-cpu";
          console.log("[dsh-voice-mode] asr tier=nano-cpu");
          return t;
        }
        console.log("[dsh-voice-mode] ASR 第 2 层没出结果，落到第 3 层");
      } catch (e) {
        console.warn("[dsh-voice-mode] 第 2 层失败，降级第 3 层: " + String(e));
        nanoCpuBroken = true;
      }
    }
    lastTier = "sensevoice";
    console.log("[dsh-voice-mode] asr tier=sensevoice");
    return await senseTranscribe(allSamples);
  };
  const feed = async (sessionId, samples, final, offset = 0, epoch = 0, manualPressed = false) => {
    if (bargeInMode() === "manual" && !manualPressed) {
      return { text: "" };
    }
    const rec = await getRecognizer();
    if (!rec) return { text: "", loading: true };
    if (!final && senseVoice()) {
      void getSenseWorker().catch(() => {
      });
    }
    let finMap = finalized.get(sessionId);
    const myGen = resetGen.get(sessionId) ?? 0;
    const cached = finMap?.get(epoch);
    if (cached !== void 0) return { text: cached };
    let sessSegs = segments.get(sessionId);
    if (!sessSegs) {
      sessSegs = /* @__PURE__ */ new Map();
      segments.set(sessionId, sessSegs);
    }
    let seg = sessSegs.get(epoch);
    if (!seg) {
      if (samples.length === 0 && final) return { text: "" };
      seg = { stream: rec.createStream(), fed: 0, vad: null, pendingEndpoint: null, lastText: "", allSamples: [], lastActivity: Date.now() };
      sessSegs.set(epoch, seg);
    }
    seg.lastActivity = Date.now();
    let endpoint = false;
    let text = "";
    let isSpeech;
    if (offset + samples.length > seg.fed) {
      const skip = Math.max(seg.fed - offset, 0);
      const inc = samples.subarray(skip);
      seg.stream.acceptWaveform(rec.config.featConfig.sampleRate, inc);
      seg.fed = offset + samples.length;
      if (seg.fed <= rec.config.featConfig.sampleRate * 60) seg.allSamples.push(inc);
      while (rec.isReady(seg.stream)) rec.decode(seg.stream);
      text = rec.getResult(seg.stream).text;
      seg.lastText = text;
      if (!final) {
        const vad = await ensureSessionVad(seg);
        if (vad) {
          if (seg.pendingEndpoint) {
            const now = Date.now();
            const rms = rmsOf(inc);
            if (rms > VAD_CONTINUE_RMS) {
              seg.pendingEndpoint = null;
            } else if (now - seg.pendingEndpoint.at >= CONFIRM_MIN_MS && text === seg.pendingEndpoint.textAtPending) {
              seg.pendingEndpoint = null;
              endpoint = true;
            } else if (now - seg.pendingEndpoint.at >= seg.pendingEndpoint.confirmMs) {
              seg.pendingEndpoint = null;
              endpoint = true;
            }
          }
          vad.acceptWaveform(inc);
          isSpeech = vad.isDetected();
          if (!vad.isEmpty()) {
            let spokenMs = 0;
            while (!vad.isEmpty()) {
              const sp = vad.front();
              spokenMs = sp.samples.length / 16e3 * 1e3;
              vad.pop();
            }
            const confirmMs = endpointConfirmMs(seg.lastText, spokenMs);
            if (confirmMs <= 0) {
              endpoint = true;
            } else {
              seg.pendingEndpoint = { at: Date.now(), confirmMs, textAtPending: seg.lastText };
            }
          }
        }
      }
    }
    if (!final) return { text, endpoint, isSpeech };
    const inflightMap = finalizing.get(sessionId);
    const inflightP = inflightMap?.get(epoch);
    if (inflightP) return { text: await inflightP };
    sessSegs.delete(epoch);
    if (sessSegs.size === 0) segments.delete(sessionId);
    const finalizeP = (async () => {
      const all = seg.allSamples;
      const senseP = all.length > 0 ? Promise.race([
        finalTranscribe(all),
        new Promise((resolve) => setTimeout(() => resolve(null), 2e4))
      ]) : Promise.resolve(null);
      const pad = new Float32Array(rec.config.featConfig.sampleRate / 2);
      seg.stream.acceptWaveform(rec.config.featConfig.sampleRate, pad);
      while (rec.isReady(seg.stream)) rec.decode(seg.stream);
      const settled = rec.getResult(seg.stream).text;
      try {
        seg.vad?.free?.();
      } catch {
      }
      seg.stream.free();
      const sense = await senseP;
      return (sense && sense.trim() ? sense : settled) || "";
    })().then((finalText) => {
      if ((resetGen.get(sessionId) ?? 0) !== myGen) return finalText;
      let fm = finalized.get(sessionId);
      if (!fm) {
        fm = /* @__PURE__ */ new Map();
        finalized.set(sessionId, fm);
      }
      fm.set(epoch, finalText);
      if (fm.size > 32) {
        const first = fm.keys().next().value;
        if (first !== void 0) fm.delete(first);
      }
      const ff = finalizing.get(sessionId);
      ff?.delete(epoch);
      if (ff && ff.size === 0) finalizing.delete(sessionId);
      return finalText;
    }).catch((e) => {
      const ff = finalizing.get(sessionId);
      ff?.delete(epoch);
      if (ff && ff.size === 0) finalizing.delete(sessionId);
      console.warn("[dsh-voice-mode] finalize failed: " + String(e));
      return "";
    });
    if (!inflightMap) {
      finalizing.set(sessionId, /* @__PURE__ */ new Map());
    }
    finalizing.get(sessionId).set(epoch, finalizeP);
    return { text: await finalizeP };
  };
  const sweep = () => {
    const now = Date.now();
    for (const [sid, sessSegs] of segments) {
      for (const [epoch, s] of sessSegs) {
        if (now - s.lastActivity > SEGMENT_IDLE_MS) {
          try {
            s.vad?.free?.();
          } catch {
          }
          try {
            s.stream.free();
          } catch {
          }
          sessSegs.delete(epoch);
        }
      }
      if (sessSegs.size === 0) {
        segments.delete(sid);
        finalized.delete(sid);
      }
    }
    for (const [sid, at] of detectVadLastUse) {
      if (now - at > SEGMENT_IDLE_MS) {
        try {
          detectVads.get(sid)?.free?.();
        } catch {
        }
        detectVads.delete(sid);
        detectVadLastUse.delete(sid);
      }
    }
  };
  const sweepTimer = setInterval(sweep, 3e4);
  return {
    feed,
    detect: async (sessionId, samples) => {
      const vad = await ensureDetectVad(sessionId);
      if (!vad) return { isSpeech: false };
      detectVadLastUse.set(sessionId, Date.now());
      if (samples.length > 0) vad.acceptWaveform(samples);
      const speech = vad.isDetected();
      while (!vad.isEmpty()) vad.pop();
      return { isSpeech: speech };
    },
    reset: (sessionId) => {
      const sessSegs = segments.get(sessionId);
      if (sessSegs) {
        for (const [, s] of sessSegs) {
          try {
            s.vad?.free?.();
          } catch {
          }
          try {
            s.stream.free();
          } catch {
          }
        }
        segments.delete(sessionId);
      }
      finalized.delete(sessionId);
      resetGen.set(sessionId, (resetGen.get(sessionId) ?? 0) + 1);
      finalizing.delete(sessionId);
      const dv = detectVads.get(sessionId);
      if (dv) {
        try {
          dv.free?.();
        } catch {
        }
        detectVads.delete(sessionId);
      }
      detectVadLastUse.delete(sessionId);
    },
    dispose: () => {
      clearInterval(sweepTimer);
      let w = senseWorker;
      senseWorker = null;
      senseWorkerSyncing = null;
      if (w) void w.terminate();
      for (const [, sessSegs] of segments) {
        for (const [, s] of sessSegs) {
          try {
            s.vad?.free?.();
          } catch {
          }
          try {
            s.stream.free();
          } catch {
          }
        }
      }
      segments.clear();
      finalized.clear();
      finalizing.clear();
      resetGen.clear();
      try {
        recognizer?.free?.();
      } catch {
      }
      recognizer = null;
      for (const [, dv] of detectVads) {
        try {
          dv.free?.();
        } catch {
        }
      }
      detectVads.clear();
      detectVadLastUse.clear();
    },
    warmup: () => {
      void getRecognizer().catch(() => void 0);
      void ensureVadModel().catch(() => void 0);
      if (senseVoice()) void getSenseWorker().catch(() => void 0);
      // 2026-10-17：ASR 第 1 层在插件初始化（即 DSH 启动）时就后台加载。
      // 用 setTimeout 延到当前同步初始化之后——ZIPVOICE_DEFAULTS 是后面才声明的 const，
      // 直接调用会踩 TDZ。延后之后，打开语音模式时第 1 层已经热好，不需要降级。
      if (asrEngine() === "auto") void getNanoGpu().catch(() => void 0);
    },
    // 批 E：SenseVoice 预热前置 enterMode——返回 Promise 让 /toggle on=true await，
    // 内部 5s 上限防止慢模型下载 hang 住 enterMode（失败/超时静默降级走 finalize 时 race）。
    warmupSense: async () => {
      // 2026-10-17：第 1 层也在这里起，但不 await——enterMode 不被它的加载拖住。
      void getNanoGpu().catch(() => void 0);
      if (!senseVoice()) return;
      await Promise.race([
        getSenseWorker().then(() => void 0).catch(() => void 0),
        new Promise((resolve) => setTimeout(resolve, 5e3))
      ]);
    },
    // 批 A：仅清缓存键——不 dispose recognizer/senseWorker，避免破坏 I1（in-flight
    // finalize 拿到的旧 recognizer 引用被 free 会丢句）。让现有 fingerprint-gated 路径
    // （getSenseWorker:396-401）下次自然触发重建。
    markStale: () => {
      senseWorkerLangKey = "";
    },
    // 2026-10-17：给设置面板显示当前档位与常驻状态。
    status: () => ({
      engine: asrEngine(),
      tier: lastTier,
      gpu: nanoGpuBroken ? "off" : nanoGpu ? "ready" : "idle"
    }),
    // 2026-10-17：切换 ASR 档位时用。非 auto 立即放掉显卡上的第 1 层（释放约 1.9G 显存）；
    // 切回 auto 则重新后台加载。设置本身由设置系统持久化，重启后保持。
    setAsrEngine: (engine) => {
      if (engine === "auto") {
        nanoGpuBroken = false;
        setTimeout(() => {
          void getNanoGpu().catch(() => void 0);
        }, 0);
      } else {
        nanoGpuBroken = true;
        try {
          nanoGpu?.terminate();
        } catch {
        }
        nanoGpu = null;
        nanoGpuSyncing = null;
      }
    },
    modelStatus: () => {
      const statFile = async (dir, repo, name2) => {
        const st = await stat2(join2(dir, repo, name2)).catch(() => null);
        return { exists: !!st?.isFile(), size: st?.size ?? 0 };
      };
      const asrFiles = MODEL_FILES.map((n) => ({
        name: n.file,
        exists: (() => {
          try {
            return statSync(join2(repoDir, n.file)).isFile();
          } catch {
            return false;
          }
        })(),
        size: (() => {
          try {
            return statSync(join2(repoDir, n.file)).size;
          } catch {
            return 0;
          }
        })()
      }));
      const vadSize = (() => {
        try {
          return statSync(join2(vadDir, VAD_FILES[0].file)).size;
        } catch {
          return 0;
        }
      })();
      const senseSize = (() => {
        try {
          return statSync(join2(senseDir, SENSE_FILES[0].file)).size;
        } catch {
          return 0;
        }
      })();
      return {
        // ready 语义 = 文件可用（exists），而非进程内是否已实例化——
        // 重启后文件齐全却显示「未下载」会误导用户（体验修复）。
        asr: {
          repo: MODEL_REPO,
          ready: asrFiles.every((f) => f.exists),
          files: asrFiles,
          failLatchMs: Math.max(0, asrFailAt - Date.now())
        },
        vad: {
          repo: VAD_REPO,
          ready: vadSize > 0,
          size: vadSize,
          failLatchMs: Math.max(0, vadFailAt - Date.now())
        },
        sense: {
          repo: SENSE_REPO,
          ready: senseSize > 0,
          size: senseSize,
          failLatchMs: Math.max(0, senseFailAt - Date.now()),
          enabled: senseVoice()
        },
        progress: lastProgress
      };
    },
    retryModel: async (kind) => {
      if (kind === "vad") {
        vadFailAt = 0;
        return !!await ensureVadModel();
      }
      if (kind === "sense") {
        if (!senseVoice()) return false;
        senseFailAt = 0;
        return !!await ensureSenseModel();
      }
      if (modelsReady) return true;
      asrFailAt = 0;
      return await ensureModels();
    }
  };
}
var respondJson = (res, status, payload) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
};
function handleAsrRequest(asr, activeSessionId, req, res) {
  const chunks = [];
  let received = 0;
  let tooLarge = false;
  req.on("data", (c) => {
    if (tooLarge) return;
    received += c.length;
    if (received > MAX_ASR_BYTES) {
      tooLarge = true;
      respondJson(res, 413, { error: "pcm payload too large" });
      return;
    }
    chunks.push(c);
  });
  req.on("end", () => {
    if (tooLarge) return;
    const url = new URL(req.url ?? "/", "http://localhost");
    const sessionId = url.searchParams.get("sessionId") ?? "";
    const final = url.searchParams.get("final") === "1";
    const reset = url.searchParams.get("reset") === "1";
    const epochParam = url.searchParams.get("epoch");
    const epochN = Number(epochParam);
    const epochOK = epochParam === null || Number.isFinite(epochN) && epochN >= 0 && Number.isInteger(epochN);
    const offsetParam = url.searchParams.get("offset");
    const offsetOK = offsetParam === null || Number.isFinite(Number(offsetParam)) && Number(offsetParam) >= 0 && Number(offsetParam) <= MAX_ASR_BYTES / 4;
    if (!offsetOK) {
      respondJson(res, 400, { error: "invalid offset" });
      return;
    }
    if (!epochOK) {
      respondJson(res, 400, { error: "invalid epoch" });
      return;
    }
    const epoch = epochParam === null ? 0 : Math.floor(epochN);
    const offset = offsetParam === null ? 0 : Math.floor(Number(offsetParam));
    if (!sessionId || sessionId !== activeSessionId) {
      respondJson(res, 403, { error: "not the active voice session" });
      return;
    }
    if (reset) {
      asr.reset(sessionId);
      respondJson(res, 200, { ok: true });
      return;
    }
    const raw = Buffer.concat(chunks);
    const samples = raw.length === 0 ? final ? new Float32Array(0) : null : pcmToSamples(raw);
    if (!samples) {
      respondJson(res, 400, { error: "invalid pcm payload" });
      return;
    }
    if (url.searchParams.get("vadOnly") === "1") {
      void asr.detect(sessionId, samples).then((out) => {
        respondJson(res, 200, { isSpeech: out.isSpeech });
      }).catch((e) => {
        respondJson(res, 500, { error: String(e) });
      });
      return;
    }
    void asr.feed(sessionId, samples, final, offset, epoch, url.searchParams.get("manual") === "1").then((out) => {
      if (out.loading) {
        respondJson(res, 202, { loading: true });
        return;
      }
      // 语音输入纠错（只作用于 ASR 文本；打字与粘贴不经过这条路径）
      // 2026-10-18：防解码复读。大模型解码器遇到含糊/近静音片段会陷入重复循环，
      // 同一句连着吐很多遍（实测一次 378 字 = 同一句 20 多遍）。人不会一口气把同一句
      // 连续说 5 遍以上，所以只在连续复读成立时截断，并留日志证据。
      const collapseRepeats = (text) => {
        if (!text) return text;
        const before = text;
        // 1) 空格分隔的同一英文/数字 token 连续 >=5 次 → 保留 1 次。
        //    例：“Claude Code Code Code Code Code 他们允许吗？” → “Claude Code 他们允许吗？”
        let out = text.replace(/\b([A-Za-z0-9_'-]+)(\s+\1\b){4,}/gi, "$1");
        // 2) 中文单元连续复读 → 保留 1 次。单字要求 >=8 次（“谢谢谢谢谢谢”是正常说话，不能截），
        //    多字单元要求 >=5 次；从长到短匹配，避免把整句重复漏掉。
        for (let unit = 8; unit >= 1; unit--) {
          const minTimes = unit === 1 ? 8 : 5;
          const re = new RegExp("([\\u3400-\\u9fff]{" + unit + "})\\1{" + (minTimes - 1) + ",}", "g");
          out = out.replace(re, "$1");
        }
        if (out !== before) {
          console.log("[dsh-voice-mode] asr repeat-guard: 复读截断 " + before.length + " → " + out.length + " 字");
        }
        return out;
      };
      const rewritten = collapseRepeats(voiceDictRewrite(out.text));
      // 识别侧埋点：只在定稿时写一行，中间结果不写（保持日志安静）。
      // 用来定位"说过的话整段丢失"：samples 有量而 raw=0 说明识别返回空；
      // raw 与 chars 不等说明纠错改动过；raw 明显偏短说明这段音频本身没被完整解码。
      if (final) {
        const ms = Math.round(samples.length / 16);
        const empty = out.text ? "" : " EMPTY";
        console.log(
          `[dsh-voice-mode] asr final${empty}: epoch=${epoch} samples=${ms}ms raw=${out.text.length} chars=${rewritten.length} text=${JSON.stringify(rewritten.length > 400 ? `${rewritten.slice(0, 400)}\u2026` : rewritten)}`
        );
      }
      const body = { text: rewritten };
      if (out.endpoint) body.endpoint = true;
      if (out.isSpeech !== void 0) body.isSpeech = out.isSpeech;
      respondJson(res, 200, body);
    }).catch((e) => {
      respondJson(res, 500, { error: String(e) });
    });
  });
}

// src/segmenter.ts
var SKIP_PREFIX = /^[\s.,，、:：;；!?！？)\]）"'”’〉》】]+$/;
function plainText(text) {
  return String(text).replace(/```[\s\S]*?```/g, " ").replace(/`([^`]*)`/g, "$1").replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/^#{1,6}\s+/gm, "").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1").replace(/^[-*+]\s+/gm, "").replace(/^\d+\.\s+/gm, "").replace(/<\/?(?:b|i|u|br|p|span|div|strong|em|s|sub|sup|h[1-6]|ul|ol|li|a|img|code|pre|blockquote|hr|table|tr|td|th)\b[^>]*>/gi, " ");
}
// 2026-10-18：朗读前的口语化归一。中文音色模型（ZipVoice 等）遇到“RTX 3070 Ti 8GB”
// 这种英文缩写+数字+单位的串会吐出不像人话的音，先归一成模型能读的形式。
var TTS_ACRONYM = /\b([A-Z]{2,6})\b/g;
var TTS_UNIT = [
  [/(\d+)\s*GB\b/gi, "$1G"],
  [/(\d+)\s*MB\b/gi, "$1兆"],
  [/(\d+)\s*TB\b/gi, "$1T"]
];
function normalizeForTts(text) {
  let out = String(text);
  for (const [re, value] of TTS_UNIT) out = out.replace(re, value);
  // 全大写缩写逐字母念：RTX -> R T X；型号里的 Ti 是例外，下面改成“钛”
  out = out.replace(TTS_ACRONYM, (m) => m.split("").join(" "));
  out = out.replace(/\bTi\b/g, "钛");
  out = out.replace(/(\d+(?:\.\d+)?)\s*%/g, "百分之$1");
  out = out.replace(/℃/g, "摄氏度");
  return out;
}
function sanitizeForTts(text) {
  return normalizeForTts(String(text).replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/https?:\/\/\S+/gi, " ").replace(/www\.\S+/gi, " ").replace(/[*_#|^=+~`]/g, " ").replace(/\s{2,}/g, " ").replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, "$1").trim());
}
// 2026-10-15：长句先切块再送合成。显存峰值跟单块长度挂钩（实测 18 秒的句子峰值 13 G），
// 切成小块还能让第一块更早出声。切点优先取"上限之内最后一个标点"，
// 因为上游原来是取缓冲区里第一个逗号，会切出长短不一的碎片。
var CHUNK_BREAKS = "。！？；，、,;:!?…）)】」』》） \t\n";
function isTokChar(c) {
  return /[A-Za-z0-9._-]/.test(c);
}
function safeCutIndex(text, maxChars) {
  const window = text.slice(0, maxChars);
  let cut = 0;
  for (let i = window.length - 1; i >= 0; i--) {
    if (CHUNK_BREAKS.includes(window[i])) {
      cut = i + 1;
      break;
    }
  }
  if (cut >= Math.floor(maxChars / 3)) return cut;
  cut = maxChars;
  if (cut >= text.length) return text.length;
  // 别在数字或英文单词中间下刀
  if (isTokChar(text[cut - 1]) && isTokChar(text[cut])) {
    let j = cut;
    while (j > 0 && isTokChar(text[j - 1])) j--;
    if (j > 0) return j;
    j = cut;
    while (j < text.length && isTokChar(text[j])) j++;
    return j;
  }
  return cut;
}


function splitSentences(chunk) {
  const sentences = [];
  let start = 0;
  const re = /[。！？!?；;…\n]+|\.(?=\s)/g;
  let m;
  let lastEnd = 0;
  while ((m = re.exec(chunk)) !== null) {
    const end = m.index + m[0].length;
    sentences.push(chunk.slice(start, end));
    start = end;
    lastEnd = end;
  }
  return { sentences, tail: chunk.slice(lastEnd) };
}
var SentenceSegmenter = class {
  buffer = "";
  maxChars;
  constructor(options = {}) {
    this.maxChars = options.maxSentenceChars ?? 30;
  }
  /** 喂入一段 raw delta，返回它补全的完整句子。 */
  feed(chunk) {
    const cleaned = plainText(chunk);
    if (!cleaned) return [];
    this.buffer += cleaned;
    const { sentences, tail } = splitSentences(this.buffer);
    this.buffer = tail;
    const out = [];
    for (const s of sentences) {
      const t = sanitizeForTts(s).trim();
      if (t && !SKIP_PREFIX.test(t)) out.push(t);
    }
    while (this.buffer.length > this.maxChars) {
      const idx = safeCutIndex(this.buffer, this.maxChars);
      if (idx <= 0) break;
      const head = sanitizeForTts(this.buffer.slice(0, idx)).trim();
      this.buffer = this.buffer.slice(idx);
      if (head) out.push(head);
    }
    return out;
  }
  /** 收尾：flush 剩余缓冲（流结束）。 */
  flush() {
    const t = sanitizeForTts(this.buffer).trim();
    this.buffer = "";
    if (t && !SKIP_PREFIX.test(t)) return [t];
    return [];
  }
};

// src/tts-queue.ts
import { synthesize as synthesizeEdge, listVoices as listEdgeVoicesRemote } from "./edge-tts.js";
var MP3_MAGIC = 255;
function isValidMp3(buf) {
  return buf.length > 0 && buf[0] === MP3_MAGIC;
}
var EdgeTtsEngine = class {
  voice;
  rate;
  constructor(voice = "zh-CN-XiaoxiaoNeural", rate) {
    this.voice = voice;
    this.rate = rate;
  }
  mime = "audio/mpeg";
  updateVoice(voice, rate) {
    this.voice = voice;
    if (rate !== void 0 && Number.isFinite(rate)) this.rate = rate;
  }
  async synthesize(text, options = {}) {
    const buf = await synthesizeEdge(text, {
      voice: options.voice ?? this.voice,
      rate: options.rate ?? this.rate
    });
    if (!isValidMp3(buf)) throw new Error("empty or invalid audio");
    return buf;
  }
  async close() {
  }
};
var edgeVoicesCache = null;
async function listEdgeVoices(force = false) {
  if (edgeVoicesCache && !force) return edgeVoicesCache;
  edgeVoicesCache = await listEdgeVoicesRemote();
  return edgeVoicesCache;
}
var TtsQueue = class {
  queues = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Set();
  engine;
  /** TTS 全体不可达通知（每会话去重，成功后复位）。 */
  onError;
  /** 单句合成重试耗尽被跳过通知（每句一次；此前是静默丢句——真机「回复偶尔不朗读」根因之一）。 */
  onSkip;
  constructor(options) {
    this.engine = options.engine;
    this.onError = options.onError;
    this.onSkip = options.onSkip;
  }
  /** 当前引擎音频 MIME（/preview 的 Content-Type 也用它）。 */
  get mime() {
    return this.engine.mime;
  }
  /**
   * 运行时切换引擎（设置面板「朗读引擎」即时生效）：
   * 关闭旧引擎、清空所有会话队列；新句子用新引擎合成。
   */
  setEngine(engine) {
    const old = this.engine;
    this.engine = engine;
    this.queues.clear();
    void old.close().catch(() => {
    });
  }
  /** 动态更换音色/语速（设置即时生效；正在合成的句子不受影响）。 */
  updateVoice(voice, rate, pauseScale) {
    this.engine.updateVoice(voice, rate, pauseScale);
  }
  /** 当前引擎/模型现状（设置面板状态区轮询）。 */
  status() {
    const s = this.engine.status?.();
    if (s) return s;
    return { engine: "edge", ready: true, loading: false };
  }
  /** 触发当前引擎预热/下载模型并初始化（设置面板「下载」按钮；Edge 为无操作）。 */
  async prepare() {
    await this.engine.prepare?.();
  }
  /**
   * 一次性合成（设置卡「试听」用）：委托当前引擎；不干扰朗读队列的在途合成。
   * 失败（含非法音色）抛错。
   */
  async synthesize(text, options = {}) {
    return this.engine.synthesize(text, options);
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /** 为某会话入队一句；若泵空闲则启动。 */
  enqueue(sessionId, text) {
    let q = this.queues.get(sessionId);
    if (!q) {
      q = { pending: [], busy: false, seq: 0, epoch: 0, errorNotified: false, backoff: 0 };
      this.queues.set(sessionId, q);
    }
    if (q.pending.length >= 500) {
      console.warn("[dsh-voice-mode] TTS queue overflow, dropping oldest sentence");
      q.pending.shift();
    }
    q.pending.push({ text, epoch: q.epoch });
    void this.pump(sessionId, q);
  }
  /**
   * 弃掉某会话的所有积压并作废正在合成的句子（打断）。之后入队的句子
   * 获得新 epoch 正常播放。同时立刻中止在途合成（本地引擎杀子进程释放 CPU）。
   */
  cancel(sessionId) {
    const q = this.queues.get(sessionId);
    if (q) {
      q.epoch++;
      q.pending.length = 0;
    }
    this.engine.interrupt?.();
  }
  /** 会话退出/被抢占时彻底清理其队列（防止 Map 长期累积）。 */
  prune(sessionId) {
    const q = this.queues.get(sessionId);
    if (q) {
      q.epoch++;
      q.pending.length = 0;
    }
    this.queues.delete(sessionId);
  }
  async pump(sessionId, q) {
    if (q.busy) return;
    q.busy = true;
    try {
      while (q.pending.length > 0) {
        const item = q.pending.shift();
        const MAX_SYNTH_ATTEMPTS = 3;
        let buf = null;
        for (let attempt = 0; attempt < MAX_SYNTH_ATTEMPTS; attempt++) {
          if (item.epoch !== q.epoch) break;
          try {
            buf = await this.engine.synthesize(item.text);
            break;
          } catch (e) {
            console.warn(`[dsh-voice-mode] synthesis failed (${attempt + 1}/${MAX_SYNTH_ATTEMPTS}): ${String(e)}`);
            if (attempt < MAX_SYNTH_ATTEMPTS - 1) {
              await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
            }
          }
        }
        if (item.epoch !== q.epoch) continue;
        if (buf === null) {
          this.onSkip?.(sessionId, item.text);
          continue;
        }
        q.errorNotified = false;
        q.backoff = 0;
        const sentenceId = q.seq++;
        const mime = this.engine.mime;
        const dataFrame = {
          sessionId,
          sentenceId,
          chunkId: 0,
          final: false,
          audio: buf.toString("base64"),
          mime
        };
        for (const fn of this.listeners) {
          try {
            fn(dataFrame);
          } catch {
          }
        }
        const finalFrame = {
          sessionId,
          sentenceId,
          chunkId: 1,
          final: true,
          text: item.text,
          audio: "",
          mime
        };
        for (const fn of this.listeners) {
          try {
            fn(finalFrame);
          } catch {
          }
        }
      }
    } catch (e) {
      console.warn(`[dsh-voice-mode] TTS unavailable: sid=${sessionId} err=${String(e)}`);
      if (!q.errorNotified) {
        q.errorNotified = true;
        this.onError?.(sessionId);
      }
    } finally {
      q.busy = false;
      if (this.queues.get(sessionId) !== q) return;
      if (q.pending.length > 0) {
        const delay = q.errorNotified ? q.backoff : 0;
        q.backoff = Math.min(8e3, delay + 1e3);
        if (delay > 0) setTimeout(() => void this.pump(sessionId, q), delay);
        else void this.pump(sessionId, q);
      }
    }
  }
  async close() {
    await this.engine.close();
  }
};

// src/tts-local.ts
import { fork, spawn } from "node:child_process";
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { join as join3 } from "node:path";
import { statSync as statSync2 } from "node:fs";

// src/emotion.ts
var TAG_RE = /<\s*(break\s+(?<ms>\d+)\s*ms|whisper|\/whisper|laugh|sigh|emphasis)\s*>/gi;
// 2026-10-14 补丁：piper 这类模型不理会标点，整段读下来一个调子，听感很平。
// 办法是按标点把文本切成小块，在块之间插静音——这才有一句一顿的节奏。
var SPEECH_BREAK_MS = {
  "。": 340, "！": 340, "？": 340, "!": 340, "?": 340, ".": 320,
  "；": 260, ";": 260, "：": 210, ":": 190,
  "，": 170, ",": 160, "、": 120
};
// 紧跟标点的收尾符号并入同一块，否则引号会单独成块
var SPEECH_TAIL = "\"'’”》」】）)]}";
function splitForSpeech(raw) {
  const out = [];
  let buf = "";
  const chars = Array.from(String(raw ?? ""));
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === "\n") {
      const t = buf.trim();
      if (t) out.push({ text: t, pauseMs: 0 });
      buf = "";
      const last = out[out.length - 1];
      if (last) last.pauseMs = Math.max(last.pauseMs, 300);
      continue;
    }
    buf += ch;
    const ms = SPEECH_BREAK_MS[ch];
    if (ms === void 0) continue;
    while (i + 1 < chars.length && SPEECH_TAIL.includes(chars[i + 1])) buf += chars[++i];
    const t = buf.trim();
    if (t) out.push({ text: t, pauseMs: ms });
    buf = "";
  }
  const rest = buf.trim();
  if (rest) out.push({ text: rest, pauseMs: 0 });
  return out;
}
function parseEmotionTags(raw) {
  const out = [];
  let buf = "";
  let whisper = false;
  let pendingBreakMs = 0;
  const flush = () => {
    const t = buf.trim();
    buf = "";
    if (t.length === 0) return;
    const seg = { text: t, whisper };
    out.push(seg);
  };
  let lastEnd = 0;
  for (const m of raw.matchAll(TAG_RE)) {
    const idx = m.index ?? 0;
    buf += raw.slice(lastEnd, idx);
    lastEnd = idx + m[0].length;
    const tag = (m[1] ?? "").toLowerCase().trim();
    if (tag.startsWith("break")) {
      const ms = Number(m.groups?.ms ?? 0);
      if (!Number.isFinite(ms) || ms <= 0) continue;
      if (buf.trim().length > 0) {
        flush();
      }
      const last = out[out.length - 1];
      if (last) {
        ;
        last.preBreakMs = (last.preBreakMs ?? 0) + ms;
      } else {
        pendingBreakMs += ms;
      }
    } else if (tag === "whisper") {
      flush();
      whisper = true;
    } else if (tag === "/whisper") {
      flush();
      whisper = false;
    } else {
    }
  }
  buf += raw.slice(lastEnd);
  flush();
  if (pendingBreakMs > 0) {
    const last = out[out.length - 1];
    if (last) {
      ;
      last.preBreakMs = (last.preBreakMs ?? 0) + pendingBreakMs;
    }
    pendingBreakMs = 0;
  }
  if (whisper) {
    for (const s of out) s.whisper = false;
  }
  return out;
}

// src/tts-local.ts
// 2026-10-14 补丁：vits 这条路用的模型换过三次，取舍记在这里。
//   1) sherpa-onnx-vits-zh-ll：当时走 wasm，约 1.1 倍实时，比播放还慢 —— 弃。
//   2) huayan-medium + espeak：0.18 倍实时、中英都读，但模型卡写明它是从英语女声
//      (lessac) 微调来的，中文带着外国口音 —— 用户判定"听着恶心"，弃。
//   3) piper 小雅（xiao_ya）：标贝中文女声库从头训练，0.28 倍实时，中文正常。
//      缺点：英文单词会被整段跳过；用户听过之后判定音质略差于原版 VITS。
//   4) 现在换回 1) 那个原版 VITS（五个音色），但换了推理后端：不再走 wasm，
//      改用原生 addon（见 lib/tts-vits-worker.cjs），RTF 从 1.1~1.5 降到 0.28。
//      用户选定音色 2（sid 2）。纯中文模型，英文单词同样读不了。
var TTS_MODEL_REPO = "csukuangfj/sherpa-onnx-vits-zh-ll";
var KOKORO_MODEL_DIR_INT8 = "csukuangfj/kokoro-int8-multi-lang-v1_1";
var KOKORO_MODEL_DIR_FP32 = "csukuangfj/kokoro-multi-lang-v1_1";
var kokoroModelDir = (m) => m === "fp32" ? KOKORO_MODEL_DIR_FP32 : KOKORO_MODEL_DIR_INT8;
var TTS_MODEL_FILES = [
  { file: "model.onnx", sha256: "6c349bdd73dc928234dd7bc86929748bba32cd5264d32d915bf7b7aa0595965b" },
  { file: "lexicon.txt", sha256: "b3a82f16b286c424953dea3686039e7ab465fa8e15d87ef8abd0ec69175beb21" },
  { file: "tokens.txt", sha256: "34b035b9aeb070df6188b022f29c00e0e142c7ade9f25611ced65db5e9cc8402" },
  { file: "date.fst", sha256: "eb8aa079ae3cb81d8f4404992f39d61a0cb990947512b5b8d1e54d1f6980e718" },
  { file: "phone.fst", sha256: "1ac2b6fa56b1442320c4de7db08353bab8963a2b57f365eebcdd3a2d3562f8d7" },
  { file: "number.fst", sha256: "743f402181fcfebf76cc2f0546b71fa26476e626fbe4e460fb7b4c3a7a8bd5bd" }
];
// 原版 VITS 中文模型有 5 个音色（sid 0~4）。上游 README 没给音色名，
// 这里就按编号叫，和当初发给用户的试听文件编号一一对应。
var VITS_SPEAKERS = [
  { name: "voice0", sid: 0, label: "\u97F3\u8272 0 \xB7 \u4E2D\u6587" },
  { name: "voice1", sid: 1, label: "\u97F3\u8272 1 \xB7 \u4E2D\u6587" },
  { name: "voice2", sid: 2, label: "\u97F3\u8272 2 \xB7 \u4E2D\u6587" },
  { name: "voice3", sid: 3, label: "\u97F3\u8272 3 \xB7 \u4E2D\u6587" },
  { name: "voice4", sid: 4, label: "\u97F3\u8272 4 \xB7 \u4E2D\u6587" }
];
var KOKORO_F0 = [
  224,
  189,
  154,
  261,
  226,
  222,
  220,
  229,
  198,
  186,
  212,
  293,
  233,
  161,
  247,
  207,
  218,
  216,
  220,
  238,
  242,
  229,
  198,
  286,
  211,
  190,
  264,
  261,
  226,
  147,
  216,
  240,
  233,
  188,
  222,
  247,
  253,
  270,
  276,
  276,
  279,
  320,
  247,
  296,
  276,
  235,
  139,
  240,
  282,
  282,
  238,
  226,
  273,
  216,
  286,
  270,
  198,
  179,
  117,
  130,
  114,
  128,
  108,
  106,
  122,
  136,
  190,
  112,
  108,
  128,
  131,
  111,
  110,
  132,
  138,
  189,
  137,
  148,
  151,
  127,
  135,
  111,
  138,
  114,
  125,
  158,
  128,
  156,
  132,
  162,
  131,
  136,
  142,
  124,
  129,
  136,
  126,
  135,
  161,
  150,
  124,
  104,
  124
];
var KOKORO_NAMED = {
  48: { name: "zf_xiaobei", label: "\u5C0F\u5317 \xB7 \u4E2D\u6587\u5973" },
  49: { name: "zf_xiaoni", label: "\u5C0F\u59AE \xB7 \u4E2D\u6587\u5973" },
  50: { name: "zf_xiaoxiao", label: "\u5C0F\u5C0F \xB7 \u4E2D\u6587\u5973" },
  51: { name: "zf_xiaoyi", label: "\u5C0F\u827A \xB7 \u4E2D\u6587\u5973" }
};
var KOKORO_LABEL_OVERRIDES = {
  62: "62 \xB7 \u6DF1\u6C89 \xB7 \u5E38\u7528\u7537\u58F0",
  68: "68 \xB7 \u6D51\u539A \xB7 \u5E38\u7528\u7537\u58F0",
  75: "75 \xB7 \u6E05\u4EAE \xB7 \u5E38\u7528\u7537\u58F0",
  76: "76 \xB7 \u78C1\u6027 \xB7 \u5E38\u7528\u7537\u58F0"
};
var KOKORO_PINNED = [62, 68, 75, 76];
function kokoroVoice(sid) {
  const custom = KOKORO_LABEL_OVERRIDES[sid];
  if (custom) return { name: String(sid), sid, label: custom };
  const named = KOKORO_NAMED[sid];
  if (named) return { name: named.name, sid, label: named.label };
  const hz = KOKORO_F0[sid] ?? null;
  if (hz === null) return { name: String(sid), sid, label: `${sid} \xB7 \u97F3\u8272` };
  return { name: String(sid), sid, label: `${sid} \xB7 ${hz < 180 ? "\u7537\u58F0" : "\u5973\u58F0"} \xB7 ${hz}Hz` };
}
var KOKORO_VOICES = [
  ...KOKORO_PINNED.map((sid) => kokoroVoice(sid)),
  ...KOKORO_F0.map((_, sid) => kokoroVoice(sid)).filter((v) => !KOKORO_PINNED.includes(v.sid))
];
function voiceToSid(voice) {
  const v = String(voice ?? "").trim().toLowerCase();
  if (/^\d+$/.test(v)) {
    const n = Number(v);
    if (n >= 0 && n < VITS_SPEAKERS.length) return n;
  }
  const hit = VITS_SPEAKERS.find((s) => s.name.toLowerCase() === v);
  if (hit) return hit.sid;
  // 存的是别的引擎的音色名（比如 Edge 的 zh-CN-XiaoxiaoNeural）时，
  // 别默认成 sid 0——用本引擎自己的默认音色。
  const fallback = VITS_SPEAKERS.find((s) => s.name === VITS_SPEC.defaultVoice);
  return fallback ? fallback.sid : 0;
}
function kokoroVoiceToSid(voice) {
  const v = String(voice ?? "").trim().toLowerCase();
  if (/^\d+$/.test(v)) {
    const n = Number(v);
    if (n >= 0 && n <= KOKORO_VOICES.length - 1) return n;
  }
  const hit = KOKORO_VOICES.find((s) => s.name.toLowerCase() === v);
  return hit ? hit.sid : 48;
}
function floatToPcm16(samples) {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(s < 0 ? s * 32768 : s * 32767, i * 2);
  }
  return buf;
}
function pcmToWav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
var VITS_SPEC = {
  files: TTS_MODEL_FILES,
  // 这个模型走词典发音（汉字查 lexicon），不需要 espeak 音素库
  usesEspeak: false,
  workerPaths: (dir) => ({
    model: join3(dir, "model.onnx"),
    lexicon: join3(dir, "lexicon.txt"),
    tokens: join3(dir, "tokens.txt"),
    date: join3(dir, "date.fst"),
    phone: join3(dir, "phone.fst"),
    number: join3(dir, "number.fst")
  }),
  // 2026-10-14：用户听完五个音色，选定 sid 2
  defaultVoice: "voice2",
  toSid: voiceToSid
};
var KOKORO_SHARED_FILES = [
  { file: "voices.bin", sha256: "e64a5a581d8c2a350d848f51c3121657cd83aa07ed6109172177345874a7244c" },
  { file: "tokens.txt", sha256: "931ab2df2400cd65d580a22402024c2347ced8ae9ea300e545144b1aacc48e14" },
  { file: "lexicon-us-en.txt", sha256: "7daaab53a181be9885b853a8582bf1838186317e5dadacbcef9c426d6fa0da14" },
  { file: "lexicon-zh.txt", sha256: "11111d8cd695fba2ace1367a1d0a708b586e6ef5c1f9be91da5d7eef129b651c" },
  { file: "espeak-ng-data/phontab", sha256: "886f3fa402cb0ba73d483aa8ad000af47a6b7cc06293c75a97913fba68a530f6" },
  { file: "date-zh.fst", sha256: "eb8aa079ae3cb81d8f4404992f39d61a0cb990947512b5b8d1e54d1f6980e718" },
  { file: "number-zh.fst", sha256: "743f402181fcfebf76cc2f0546b71fa26476e626fbe4e460fb7b4c3a7a8bd5bd" },
  { file: "phone-zh.fst", sha256: "1ac2b6fa56b1442320c4de7db08353bab8963a2b57f365eebcdd3a2d3562f8d7" }
];
var kokoroWorkerPaths = (dir, modelFile) => ({
  model: join3(dir, modelFile),
  voices: join3(dir, "voices.bin"),
  tokens: join3(dir, "tokens.txt"),
  dataDir: join3(dir, "espeak-ng-data"),
  lexicon: [join3(dir, "lexicon-us-en.txt"), join3(dir, "lexicon-zh.txt")].join(","),
  date: join3(dir, "date-zh.fst"),
  phone: join3(dir, "phone-zh.fst"),
  number: join3(dir, "number-zh.fst"),
  lang: ""
});
function kokoroSpec(model) {
  const main = model === "fp32" ? { file: "model.onnx", sha256: "acc4adc175b9d9986106cd20060329673ad5a2e12ef3c557d2d3745b694f8b38" } : { file: "model.int8.onnx", sha256: "bda15858163726a492d02a9a727bc263551b86ac77f90812c4b30ff41d380e26" };
  return {
    files: [main, ...KOKORO_SHARED_FILES],
    workerPaths: (dir) => kokoroWorkerPaths(dir, main.file),
    defaultVoice: "zf_xiaobei",
    toSid: kokoroVoiceToSid
  };
}
function createSherpaLocalEngine(options) {
  const { cacheDir, modelHost, allowCustomHost, broadcast } = options;
  let downloadProgress = null;
  const trackedBroadcast = (event, payload) => {
    if (event === "asr-progress" && payload && typeof payload === "object") {
      const pr = payload;
      if (typeof pr.file === "string" && typeof pr.percent === "number") {
        downloadProgress = { file: pr.file, percent: Math.min(100, Math.max(0, pr.percent)) };
      }
    }
    broadcast(event, payload);
  };
  const kokoroModel = options.model ?? "int8";
  const spec = options.kind === "kokoro" ? kokoroSpec(kokoroModel) : VITS_SPEC;
  const repoName = options.kind === "kokoro" ? kokoroModelDir(kokoroModel) : TTS_MODEL_REPO;
  const repoDir = join3(cacheDir, repoName);
  const workerPath = fileURLToPath2(new URL("./tts-vits-worker.cjs", import.meta.url));
  let child = null;
  let childInit = false;
  const respawnChild = async () => {
    if (child) {
      child.kill();
      child = null;
    }
    childInit = false;
    ready = null;
  };
  let voice = spec.defaultVoice;
  let speed = 1;
  let pauseScale = 1;
  let ready = null;
  let engineLoading = false;
  let engineError;
  let nextId = 1;
  const pending = /* @__PURE__ */ new Map();
  const call = (msg) => new Promise((resolve, reject) => {
    if (!child) {
      reject(new Error("tts child not running"));
      return;
    }
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.send({ id, ...msg });
  });
  const rejectAll = (e) => {
    for (const p of pending.values()) p.reject(e);
    pending.clear();
  };
  const ensureReady = () => {
    if (ready && child) return ready;
    if (!ready) {
      ready = (async () => {
        engineLoading = true;
        engineError = void 0;
        downloadProgress = null;
        try {
          if (!child || !childInit) {
            for (const f of spec.files) {
              const ok = await ensureModelFile({
                repo: repoName,
                repoDir,
                spec: f,
                primaryHost: modelHost(),
                allowCustomHost,
                broadcast: trackedBroadcast
              });
              if (!ok) throw new Error("local TTS model download/verify failed: " + f.file);
            }
            // 2026-10-14 补丁：espeak 数据本地已经齐全时不要再去联网校验。
            // 树清单接口在这台机器上拿不到，失败一次要等约 30 秒才抛
            // "local TTS model download failed: espeak-ng-data"，
            // 听感就是"没有任何声音"，而且每次合成都重试三遍。
            // vits（piper）那份 espeak 数据是随模型一起放好的，用 phondata 当哨兵判断即可。
            const espeakStamp = await stat2(join3(repoDir, "espeak-ng-data", "phondata")).catch(() => null);
            const espeakReady = !!espeakStamp && espeakStamp.isFile() && espeakStamp.size > 0;
            // 只有真要 espeak 的模型才走这一步：kokoro 一直要；vits 看 VITS_SPEC.usesEspeak。
            // 小雅这类词典模型根本没有 espeak 目录，之前会在这里白等一次失败。
            const needsEspeakTree = options.kind === "kokoro" || (options.kind === "vits" && spec.usesEspeak === true);
            if (needsEspeakTree && !espeakReady) {
              const treeOk = await ensureModelTree({
                repo: repoName,
                repoDir,
                subdir: "espeak-ng-data",
                primaryHost: modelHost(),
                allowCustomHost,
                broadcast: trackedBroadcast
              });
              if (!treeOk) throw new Error("local TTS model download failed: espeak-ng-data");
            }
            if (!child) {
              child = fork(workerPath, [], {
                stdio: ["ignore", "ignore", "pipe", "ipc"],
                // 2026-10-14 补丁：kokoro 用的是原生 addon（sherpa-onnx-node）。
                // 在 DSH 的 Electron 运行时里，它的 generate() 会抛
                // "External buffers are not allowed"（napi 造出来的缓冲区过不了 Electron 的检查，
                // 用同一个 addon 在真正的 node.exe 下跑就正常）。
                // 这里让 TTS 子进程改用 DSH_VOICE_TTS_NODE 指定的 node.exe；
                // 没设就沿用父进程，行为和打补丁前一致。
                ...(process.env.DSH_VOICE_TTS_NODE ? { execPath: process.env.DSH_VOICE_TTS_NODE } : {})
              });
              let stderrTail = "";
              child.stderr?.on("data", (chunk) => {
                stderrTail += String(chunk);
                const lines = stderrTail.split("\n");
                stderrTail = lines.pop() ?? "";
                for (const line of lines) {
                  const s = line.trim();
                  if (!s) continue;
                  if (/Skip unknown phonemes/.test(s)) continue;
                  console.error(`[tts-worker:${options.kind}] ${s}`);
                }
              });
              child.on("message", (m) => {
                const p = pending.get(m.id);
                if (!p) return;
                pending.delete(m.id);
                if (m.ok) p.resolve(m);
                else p.reject(new Error(m.error ?? "tts child error"));
              });
              child.on("error", (e) => {
                rejectAll(e instanceof Error ? e : new Error(String(e)));
                child = null;
                childInit = false;
                ready = null;
              });
              child.on("exit", (code) => {
                rejectAll(new Error(`tts child exited with code ${code}`));
                child = null;
                childInit = false;
                ready = null;
              });
            }
            if (!childInit) {
              const init = await call({ type: "init", kind: options.kind, paths: spec.workerPaths(repoDir) });
              if (!init.ok) throw new Error(init.error ?? "tts child init failed");
              childInit = true;
            }
          }
          broadcast("tts-ready", { engine: options.kind, worker: true });
        } catch (e) {
          engineError = e instanceof Error ? e.message : String(e);
          throw e;
        } finally {
          engineLoading = false;
        }
      })().finally(() => {
        ready = null;
      });
    }
    return ready;
  };
  return {
    mime: "audio/wav",
    updateVoice(nextVoice, nextRate, nextPauseScale) {
      voice = nextVoice || voice;
      if (typeof nextRate === "number" && Number.isFinite(nextRate)) {
        speed = Math.min(3, Math.max(0.5, nextRate));
      }
      if (typeof nextPauseScale === "number" && Number.isFinite(nextPauseScale)) {
        pauseScale = Math.min(2, Math.max(0, nextPauseScale));
      }
    },
    status() {
      const files = spec.files.map((f) => {
        const p = join3(repoDir, f.file);
        let exists = false;
        let size = 0;
        try {
          const st = statSync2(p);
          exists = st.isFile();
          size = st.size;
        } catch {
        }
        return { name: f.file, exists, size };
      });
      return {
        engine: options.kind,
        ready: childInit === true,
        loading: engineLoading,
        error: engineError,
        progress: downloadProgress ?? void 0,
        local: {
          repo: repoName,
          ready: files.every((f) => f.exists),
          loading: engineLoading,
          error: engineError,
          files
        }
      };
    },
    // 设置面板「下载」按钮：无文本也触发模型下载 + 子进程初始化（与首次合成路径一致）。
    prepare: () => ensureReady(),
    async synthesize(text, opts = {}) {
      await ensureReady();
      const sid = spec.toSid(opts.voice ?? voice);
      const spd = typeof opts.rate === "number" && Number.isFinite(opts.rate) ? Math.min(3, Math.max(0.5, opts.rate)) : speed;
      const segments = parseEmotionTags(text);
      if (segments.length === 0) {
        return pcmToWav(Buffer.alloc(0), 16e3);
      }
      // 按标点展开成小块：每块读完之后按标点停一下，<break> 标签的停顿挂在段末
      const pieces = [];
      for (const seg of segments) {
        const sub = splitForSpeech(seg.text);
        for (let i = 0; i < sub.length; i++) {
          pieces.push({
            text: sub[i].text,
            whisper: seg.whisper,
            preBreakMs: sub[i].pauseMs + (i === sub.length - 1 ? seg.preBreakMs ?? 0 : 0)
          });
        }
      }
      if (pieces.length === 0) {
        return pcmToWav(Buffer.alloc(0), 16e3);
      }
      const chunks = [];
      let resolvedSampleRate = 0;
      let needsRespawn = true;
      for (let i = 0; i < pieces.length; i++) {
        const seg = pieces[i];
        const preBreak = seg.preBreakMs ?? 0;
        let res = await call({ type: "synth", text: seg.text, sid, speed: spd });
        if (!res.ok && /Aborted/.test(res.error ?? "") && needsRespawn) {
          await respawnChild();
          res = await call({ type: "synth", text: seg.text, sid, speed: spd });
          needsRespawn = false;
        }
        if (!res.ok) throw new Error(res.error ?? "local TTS synthesis failed");
        if (typeof res.samples !== "string" || res.samples.length === 0) continue;
        const bytes = Buffer.from(res.samples, "base64");
        const samples = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
        if (samples.length === 0) continue;
        const sr = res.sampleRate || 16e3;
        if (!resolvedSampleRate) resolvedSampleRate = sr;
        if (seg.whisper) {
          for (let j = 0; j < samples.length; j++) samples[j] *= 0.5;
        }
        chunks.push(samples);
        if (preBreak > 0 && resolvedSampleRate) {
          // 2026-10-14：停顿时长跟着语速一起缩。不缩的话，语速调得越快，
          // 固定停顿占的比例越大，整体听着反而更慢。
          chunks.push(new Float32Array(Math.round(resolvedSampleRate * (preBreak * pauseScale / spd) / 1e3)));
        }
      }
      if (chunks.length === 0) {
        return pcmToWav(Buffer.alloc(0), resolvedSampleRate || 16e3);
      }
      const total = chunks.reduce((acc, c) => acc + c.length, 0);
      const merged = new Float32Array(total);
      let off = 0;
      for (const c of chunks) {
        merged.set(c, off);
        off += c.length;
      }
      // 2026-10-14：原版 VITS 输出峰值只有 0.26 左右（小雅是 0.52），音量明显偏小，
      // 听着就更闷。这里做一次峰值归一化拉到 0.95，增益封顶 4 倍免得把底噪一起放大。
      // kokoro 也是 0.26 左右，同样受益。
      let peak = 0;
      for (let i = 0; i < merged.length; i++) {
        const a = Math.abs(merged[i]);
        if (a > peak) peak = a;
      }
      if (peak > 0.001) {
        const gain = Math.min(4, 0.95 / peak);
        if (gain > 1.01) {
          for (let i = 0; i < merged.length; i++) {
            merged[i] = Math.max(-1, Math.min(1, merged[i] * gain));
          }
        }
      }
      return pcmToWav(floatToPcm16(merged), resolvedSampleRate || 16e3);
    },
    async close() {
      const c = child;
      if (c) {
        try {
          await call({ type: "close" });
        } catch {
        }
        try {
          c.kill();
        } catch {
        }
      }
      child = null;
      childInit = false;
      ready = null;
    },
    interrupt() {
      void respawnChild();
    }
  };
}
function createSherpaVitsEngine(options) {
  return createSherpaLocalEngine({ ...options, kind: "vits" });
}
function createSherpaKokoroEngine(options) {
  return createSherpaLocalEngine({ ...options, kind: "kokoro" });
}

// src/security.ts
var LOOPBACK_ADDRESSES = /* @__PURE__ */ new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
function isLoopbackRequest(req) {
  const addr = req.socket.remoteAddress ?? "";
  return LOOPBACK_ADDRESSES.has(addr);
}
function sameOriginRequest(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const originHost = new URL(origin).host;
    const xfh = req.headers["x-forwarded-host"];
    const host = (typeof xfh === "string" && xfh ? xfh.split(",")[0].trim() : "") || req.headers.host;
    if (!host) return false;
    return originHost === host;
  } catch {
    return false;
  }
}
var RateLimiter = class {
  buckets = /* @__PURE__ */ new Map();
  maxKeys;
  constructor(maxKeys = 1e4) {
    this.maxKeys = maxKeys;
  }
  /** 命中一次；返回是否允许。maxHits 次 / windowMs 毫秒。 */
  hit(key, maxHits, windowMs) {
    const now = Date.now();
    const cutoff = now - windowMs;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) return false;
      bucket = [];
      this.buckets.set(key, bucket);
    }
    while (bucket.length > 0 && bucket[0] <= cutoff) bucket.shift();
    if (bucket.length >= maxHits) return false;
    bucket.push(now);
    return true;
  }
  /** 定期清理（由调用方在低频路径触发即可）。 */
  prune(now = Date.now(), windowMs) {
    const cutoff = now - windowMs;
    for (const [key, bucket] of this.buckets) {
      while (bucket.length > 0 && bucket[0] <= cutoff) bucket.shift();
      if (bucket.length === 0) this.buckets.delete(key);
    }
  }
};

// src/index.ts
var name = "voice-mode";
var NS_VOICE_MODE = "voice-mode";
var BASE_PATH = "/voice-mode";
var PREVIEW_NETWORK_PATTERN = /fetch failed|ECONN|ENOTFOUND|getaddrinfo|ETIMEDOUT|EAI_AGAIN|network|unreachable|socket hang up|aborted/i;
var PREVIEW_ENGINE_PATTERN = /model download|model verify|init failed|child exited|tts child|local TTS|prepare|sherpa/i;
var PREVIEW_TEXT_PATTERN = /empty or invalid audio|invalid audio|invalid text|too long|truncat/i;
function classifyPreviewError(msg) {
  if (PREVIEW_TEXT_PATTERN.test(msg)) return "text";
  if (PREVIEW_NETWORK_PATTERN.test(msg)) return "network";
  if (PREVIEW_ENGINE_PATTERN.test(msg)) return "engine";
  return "unknown";
}
var PREVIEW_ERROR_MESSAGES = {
  network: "\u8BD5\u542C\u5931\u8D25\uFF1A\u7F51\u7EDC\u4E0D\u53EF\u8FBE\uFF08Edge \u4E91\u7AEF\u9700\u8BBF\u95EE\u5FAE\u8F6F\u8BED\u97F3\u670D\u52A1\uFF09\uFF0C\u8BF7\u68C0\u67E5\u7F51\u7EDC\u6216\u4EE3\u7406",
  engine: "\u8BD5\u542C\u5931\u8D25\uFF1A\u5F15\u64CE\u672A\u5C31\u7EEA\uFF08\u672C\u5730\u6A21\u578B\u4E0B\u8F7D\u4E2D\u3001\u521D\u59CB\u5316\u5931\u8D25\u6216\u5B50\u8FDB\u7A0B\u5F02\u5E38\uFF09\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5\u6216\u5728\u8BBE\u7F6E\u9762\u677F\u67E5\u770B TTS \u72B6\u6001",
  text: "\u8BD5\u542C\u5931\u8D25\uFF1A\u5408\u6210\u5F15\u64CE\u4EA7\u51FA\u7A7A\u97F3\u9891\uFF08\u97F3\u8272\u4E0E\u8BED\u79CD\u53EF\u80FD\u4E0D\u5339\u914D\uFF09\uFF0C\u8BF7\u66F4\u6362\u97F3\u8272\u6216\u68C0\u67E5\u8BED\u8A00\u8BBE\u7F6E",
  unknown: "\u8BD5\u542C\u5931\u8D25\uFF1A\u8BF7\u68C0\u67E5\u7F51\u7EDC\u3001\u97F3\u8272\u540D\uFF08ShortName\uFF09\u6216\u672C\u5730 TTS \u6A21\u578B\u72B6\u6001"
};
var respondJson2 = (res, status, payload) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
};
var VOICE_SPOKEN_PROMPT = "\u3010\u8BED\u97F3\u6A21\u5F0F\u3011\u5F53\u524D\u56DE\u590D\u4F1A\u88AB\u8BED\u97F3\u6717\u8BFB\uFF0C\u8BF7\u59CB\u7EC8\u7528\u7528\u6237\u6240\u7528\u8BED\u8A00\u3001\u4EE5\u53E3\u8BED\u5316\u7684\u77ED\u53E5\u76F4\u63A5\u56DE\u7B54\uFF0C\u50CF\u9762\u5BF9\u9762\u804A\u5929\u4E00\u6837\u81EA\u7136\uFF0C\u907F\u514D\u4E66\u9762\u8BED\u548C\u957F\u96BE\u53E5\u3002\u4E0D\u8981\u4F7F\u7528\u4EFB\u4F55 Markdown \u6216\u6392\u7248\u7B26\u53F7\uFF08\u661F\u53F7\u3001\u4E0B\u5212\u7EBF\u3001\u53CD\u5F15\u53F7\u3001\u4E95\u53F7\u3001\u5217\u8868\u4E0E\u8868\u683C\u6807\u8BB0\u3001\u4EE3\u7801\u5757\u7B49\uFF09\u3002\u9700\u8981\u5206\u70B9\u8BF4\u660E\u65F6\u7528\u300C\u7B2C\u4E00\u3001\u7B2C\u4E8C\u300D\u6216\u8FDE\u8D2F\u7684\u77ED\u53E5\u8868\u8FBE\uFF1B\u9664\u975E\u7528\u6237\u660E\u786E\u8981\u6C42\uFF0C\u4E0D\u8981\u8F93\u51FA\u4EE3\u7801\u7247\u6BB5\u3001\u5B8C\u6574 URL \u6216\u5197\u957F\u5B9A\u4E49\uFF0C\u7528\u4E00\u4E24\u53E5\u8BDD\u6982\u62EC\u542B\u4E49\u5373\u53EF\u3002\u56DE\u7B54\u7B80\u6D01\u76F4\u63A5\uFF0C\u4E0D\u8981\u91CD\u590D\u548C\u5BD2\u6684\u3002\u5982\u679C\u7528\u6237\u5728\u4F60\u6717\u8BFB\u65F6\u63D2\u8BDD\uFF08\u54EA\u6015\u53EA\u662F\u300C\u55EF/\u5BF9\u300D\u8FD9\u6837\u7684\u77ED\u5E94\u7B54\uFF09\uFF0C\u7ACB\u5373\u505C\u6B62\u5F53\u524D\u53E5\uFF0C\u628A\u8BDD\u8F6E\u8BA9\u7ED9\u7528\u6237\uFF1B\u56DE\u7B54\u540E\u7559\u51FA\u505C\u987F\uFF0C\u4E0D\u8981\u8FDE\u95EE\u4E24\u4E2A\u95EE\u9898\uFF1B\u7528\u6237\u6C89\u9ED8\u65F6\u4E0D\u8981\u4E3B\u52A8\u627E\u65B0\u8BDD\u9898\u3002";
var VOICE_SPOKEN_SECTION = "voice-mode:spoken-format";
var inject = ["webServer", "settings", "sessions"];
var defaultModelCacheDir = () => process.platform === "win32" ? join4(process.env.LOCALAPPDATA ?? join4(homedir(), "AppData", "Local"), "dsh-voice-mode", "models") : join4(homedir(), ".cache", "dsh-voice-mode", "models");
var VOICE_SETTINGS_DEFAULTS = {
  ttsEngine: "edge",
  kokoroModel: "int8",
  voice: "zh-CN-XiaoxiaoNeural",
  rate: 1.1,
  // 2026-10-15：ZipVoice（显卡引擎）的几个路径。留空就用引擎里写死的默认值。
  zipvoicePython: "",
  zipvoiceRepo: "",
  zipvoicePromptWav: "",
  zipvoicePromptText: "",
  zipvoiceNumStep: 4,
  // 2026-10-14：标点停顿时长的倍数。1 = 标准，0 = 不停，2 = 加倍。
  pauseScale: 1,
  interruptLevel: 0,
  silenceMs: 1500,
  idleTimeoutMinutes: 5,
  modelHost: "",
  autoSend: true,
  autoResume: false,
  mode: "toggle",
  // 批 7O（ADR-0006）：bargeInMode 默认 'auto' → 'detect'（I10 豁免：ADR-0006 已 accepted 拍板，
  // 老用户显式 auto 不受影响，新用户/未调过的用户开箱即对）。
  bargeInMode: "detect",
  echoGateDb: 6,
  shortcut: "Ctrl+Shift+V",
  spokenFormat: true,
  senseVoice: true,
  wakeWord: "",
  toolBeep: false,
  senseITN: true,
  // 批 3：captionFontSize 默认 0（12px），与现状 client.tsx 外层 fontSize:12 视觉零变化；
  //   captionMaxWidth 默认 1（70vw）：视口 <686px 时窄于现状 480px；≈686px 时接近；>686px 时宽于 480px（取舍见 schema description）。
  captionFontSize: 0,
  captionMaxWidth: 1,
  // 批 5：backchannel 默认 true（产品决策；关 = 不挂 onBackchannel 回调，行为等同改造前）。
  backchannelYield: true,
  // 批 G 任务 3：让位窗口默认 1500ms（与改造前批 5 行为字节等价；用户可调 500-3000ms）。
  yieldMs: 1500
};
function createVoiceSettingsSchema(defs) {
  const d = { ...VOICE_SETTINGS_DEFAULTS, ...defs };
  return z.object({
    ttsEngine: z.union([z.const("zipvoice"), z.const("kokoro"), z.const("edge")]).default(d.ttsEngine).description(
      "\u6717\u8BFB\u5F15\u64CE\uFF1Aedge \u5FAE\u8F6F\u4E91\u7AEF\uFF08\u9ED8\u8BA4\uFF0C\u5FEB\u3001\u97F3\u8D28\u81EA\u7136\uFF0C\u88AB\u6717\u8BFB\u6587\u672C\u4F1A\u53D1\u9001\u5230\u5FAE\u8F6F\uFF09/ vits \u672C\u5730\u4E2D\u6587 / kokoro \u672C\u5730\u4E2D\u82F1\uFF08\u56DE\u590D\u6587\u672C\u4E0D\u51FA\u672C\u673A\uFF09\uFF1B\u5207\u6362\u5373\u65F6\u751F\u6548"
    ),
    kokoroModel: z.union([z.const("int8"), z.const("fp32")]).default(d.kokoroModel).description(
      "Kokoro \u6A21\u578B\u7CBE\u5EA6\uFF1Aint8\uFF08\u9ED8\u8BA4\uFF0C\u4F53\u79EF\u5C0F/\u52A0\u8F7D\u5FEB\uFF0CCPU \u53CB\u597D\uFF09/ fp32\uFF08\u97F3\u8D28\u66F4\u597D\u3001\u4F53\u79EF\u5927\uFF0CGPU \u6216\u5927\u5185\u5B58\u673A\u5668\u63A8\u8350\uFF09\uFF1B\u4E24\u6863\u5171\u7528\u540C\u4E00\u5957 103 \u97F3\u8272\uFF0C\u5207\u6362\u5373\u65F6\u751F\u6548"
    ),
    voice: z.string().default(d.voice).description(
      "\u6717\u8BFB\u97F3\u8272\uFF08\u6309 ttsEngine \u53D6\u503C\uFF1Avits \u7528\u8BF4\u8BDD\u4EBA\u540D suyingxue/gunian/fushiyu/bingjiao/bazong\uFF1Bkokoro \u7528 0-102 \u7F16\u53F7\u6216\u4E2D\u6587\u540D zf_xiaobei/zf_xiaoni/zf_xiaoxiao/zf_xiaoyi\uFF1Bedge \u7528 Edge ShortName \u5982 zh-CN-XiaoxiaoNeural \u6653\u6653\xB7\u5973\uFF0C\u5B8C\u6574\u6E05\u5355\u89C1 scripts/list-voices.mjs\uFF09"
    ),
    rate: z.number().min(0.5).max(3).default(d.rate).volatile().description("\u6717\u8BFB\u8BED\u901F\u500D\u7387\uFF080.5 = \u6162\u901F\uFF0C2.0 = \u5FEB\u901F\uFF0C1.1 = \u9ED8\u8BA4\uFF1B\u8BA9\u56DE\u590D\u66F4\u7D27\u51D1\uFF09"),
    interruptLevel: z.union([z.const(0), z.const(1), z.const(2)]).default(d.interruptLevel).description(
      "\u53D1\u58F0\u6253\u65AD\u7075\u654F\u5EA6\uFF1A0 = \u9AD8\u95E8\u69DB\uFF08\u2248300ms \u786E\u8BA4\uFF0C\u6700\u7A33\uFF0C\u9ED8\u8BA4\uFF1Bquiet \u63A8\u8350\uFF09/ 1 = \u4E2D\u95E8\u69DB\uFF08\u2248200ms\uFF09/ 2 = \u4F4E\u95E8\u69DB\uFF08\u2248100ms\uFF0C\u6700\u7075\u654F\uFF1B\u5608\u6742\u73AF\u5883\uFF09\uFF1B\u503C\u8D8A\u4F4E\u95E8\u69DB\u8D8A\u9AD8\uFF0C\u8D8A\u96BE\u6253\u65AD"
    ),
    silenceMs: z.number().min(500).max(3e4).default(d.silenceMs).description("\u8BF4\u5B8C\u6574\u4E00\u53E5\u7684\u9759\u97F3\u505C\u987F\u6BEB\u79D2\u6570\uFF08\u9ED8\u8BA4 1500 \u6BEB\u79D2\uFF0C\u7ED9\u601D\u8003\u505C\u987F\u7559\u7A7A\u95F4\uFF1B\u81F3\u5C11 250ms \u8BED\u97F3\u624D\u5224\u53E5\uFF0C\u9632\u77ED\u4FC3\u566A\u58F0\u8BEF\u89E6\u53D1\uFF09"),
    idleTimeoutMinutes: z.number().min(1).max(120).default(d.idleTimeoutMinutes).description("\u65E0\u6D3B\u52A8\u81EA\u52A8\u9000\u51FA\u8BED\u97F3\u6A21\u5F0F\u7684\u5206\u949F\u6570\uFF08\u9ED8\u8BA4 5\uFF1B\u6279 G \u4EFB\u52A1 2 \u5DF2\u52A0 30s \u5012\u6570\u9884\u8B66\uFF09"),
    modelHost: z.string().default(d.modelHost).description("ASR \u6A21\u578B\u4E0B\u8F7D\u6E90\uFF08\u7559\u7A7A\u7528\u9ED8\u8BA4\u6E90\uFF1B\u56FD\u5185\u7F51\u7EDC\u53EF\u586B https://hf-mirror.com\uFF09"),
    autoSend: z.boolean().default(d.autoSend).description("\u9759\u97F3\u5230\u70B9\u81EA\u52A8\u53D1\u9001\uFF08\u8FDE\u7EED\u591A\u6BB5\u62FC\u6210\u4E00\u6761\u6D88\u606F\uFF1B\u5173\u95ED\u5219\u53EA\u8FDB\u8349\u7A3F\u4F9B\u7F16\u8F91\uFF1B\u6309\u4F4F Ctrl / hold \u677E\u624B\u4ECD\u4F1A\u53D1\u9001\uFF09"),
    // 批 7N 重做 5/5：与 strings.ts descAutoResume 同步——明确「下次进入语音会话即生效」。
    autoResume: z.boolean().default(d.autoResume).description("\u5207\u6362\u56DE\u4E0A\u6B21\u8BED\u97F3\u4F1A\u8BDD\u65F6\u81EA\u52A8\u6062\u590D\u8BED\u97F3\u6A21\u5F0F\uFF08\u9ED8\u8BA4\u5173\uFF1B\u5F00\u542F\u540E\u4E0B\u6B21\u8FDB\u5165\u8BED\u97F3\u4F1A\u8BDD\u5373\u751F\u6548\u2014\u2014\u81EA\u52A8\u8FDB\u5165\u8BED\u97F3\u6A21\u5F0F + \u6062\u590D\u4E0A\u6B21\u4F1A\u8BDD\uFF1B\u5173\u95ED\u5219\u9700\u624B\u52A8\u6309 Ctrl+Shift+V \u91CD\u65B0\u8FDB\u5165\uFF09"),
    mode: z.union([z.const("toggle"), z.const("hold")]).default(d.mode).volatile().description("\u4EA4\u4E92\u6A21\u5F0F\uFF1Atoggle \u6301\u7EED\u8046\u542C + \u9759\u97F3\u81EA\u52A8\u65AD\u53E5\uFF08\u9ED8\u8BA4\uFF09\uFF1Bhold \u6309\u4F4F\u8BF4\u8BDD\u3001\u677E\u624B\u53D1\u9001\uFF08\u77ED\u6309\u9000\u51FA\uFF09"),
    bargeInMode: z.union([z.const("auto"), z.const("manual"), z.const("detect")]).default(d.bargeInMode).description("\u6253\u65AD\u65B9\u5F0F\uFF1Adetect \u81EA\u52A8\u63A2\u6D4B\u672C\u673A\u539F\u751F\u56DE\u58F0\u6D88\u9664\u72B6\u6001\uFF08\u9ED8\u8BA4\uFF0C\u672A\u751F\u6548\u65F6\u5207\u4E3A\u957F\u6309\u6253\u65AD\uFF09\uFF1Bauto \u5F3A\u5236\u81EA\u52A8\u6253\u65AD\uFF08\u5F00\u53E3\u5373\u6253\u65AD\uFF0C\u8033\u673A/\u5B89\u9759\u73AF\u5883\u63A8\u8350\uFF09\uFF1Bmanual \u624B\u52A8\u6253\u65AD\uFF08\u5916\u653E\u63A8\u8350\u2014\u2014\u6309\u4F4F\u9EA6\u514B\u98CE/Ctrl \u663E\u5F0F\u6253\u65AD\uFF0C\u6C38\u4E0D\u81EA\u6253\u65AD\uFF09"),
    echoGateDb: z.number().min(3).max(12).default(d.echoGateDb).description(
      "\u56DE\u58F0\u95E8\u63A7\u9608\u503C\uFF08dB\uFF0C\u9ED8\u8BA4 6\uFF09\uFF1A\u81EA\u52A8\u6253\u65AD\u8981\u6C42\u6B8B\u5DEE\u9AD8\u4E8E\u56DE\u58F0\u5730\u677F\u6B64\u503C\u3002\u5F53\u524D ASR \u6A21\u578B\u9ED8\u8BA4\u539F\u751F AEC \u751F\u6548\u65F6\u6B64\u95E8\u63A7\u95F2\u7F6E\uFF1BSafari / \u8033\u673A\u7B49\u65E0\u539F\u751F AEC \u73AF\u5883\u4F1A\u515C\u5E95\u751F\u6548\u3002\u5916\u653E\u4ECD\u8BEF\u6253\u65AD\u8C03\u5927\uFF088~10\uFF09\uFF0C\u592A\u96BE\u6253\u65AD\u8C03\u5C0F\uFF083~4\uFF09"
    ),
    shortcut: z.string().default(d.shortcut).description("\u8FDB\u5165/\u9000\u51FA\u8BED\u97F3\u6A21\u5F0F\u7684\u5FEB\u6377\u952E\uFF08\u5F62\u5982 Ctrl+Shift+V\uFF0C\u4FEE\u9970\u952E Ctrl/Shift/Alt/Meta + \u4E00\u4E2A\u5B57\u6BCD\u952E\uFF1B\u7559\u7A7A\u7981\u7528\u5FEB\u6377\u952E\uFF0C\u7528\u9EA6\u514B\u98CE\u6309\u94AE\uFF09"),
    spokenFormat: z.boolean().default(d.spokenFormat).description("\u8BED\u97F3\u4F1A\u8BDD\u6CE8\u5165\u53E3\u8BED\u5316\u63D0\u793A\u8BCD\uFF08\u53E3\u8BED\u5316\u77ED\u53E5\u3001\u4E0D\u7528 Markdown \u6392\u7248\u7B26\u53F7\uFF0C\u6717\u8BFB\u66F4\u987A\u66F4\u5FEB\uFF1B\u9ED8\u8BA4\u5F00\uFF0C\u6539\u52A8\u5373\u65F6\u751F\u6548\uFF09"),
    senseVoice: z.boolean().default(d.senseVoice).description("\u5B9A\u7A3F\u7528 SenseVoice \u91CD\u8BD1\uFF08\u5E26\u6807\u70B9+\u6570\u5B57\u5F52\u4E00\u5316\u3001\u8BC6\u522B\u66F4\u51C6\uFF1B\u9ED8\u8BA4\u5F00\u3002\u5173\u95ED\u53EF\u7701 228MB \u6A21\u578B\uFF0C\u53EA\u8D70\u6D41\u5F0F\u8BC6\u522B\uFF09"),
    wakeWord: z.string().default(d.wakeWord).description("\u5524\u9192\u8BCD\uFF1A\u5728\u5F85\u673A\u6001\u8BF4\u51FA\u540E\u5F00\u59CB\u8BC6\u522B\uFF08\u9ED8\u8BA4\u5173\uFF1B\u5982\u300C\u4F60\u597D\u5C0FD\u300D\uFF09\u3002\u53EF\u4E0E\u547D\u4EE4\u8FDE\u8BF4\u2014\u2014\u8BCD\u5934\u81EA\u52A8\u5265\u6389\u4E0D\u8FDB\u6D88\u606F\uFF1B\u6BCF\u53E5\u65AD\u53E5/\u6253\u65AD\u540E\u9700\u91CD\u8BF4\uFF1B\u4EC5 toggle \u6A21\u5F0F\u751F\u6548\uFF08hold/\u624B\u52A8\u6253\u65AD\u4E0B\u4E0D\u751F\u6548\uFF09\uFF1B\u6717\u8BFB\u671F\u8BF4\u5524\u9192\u8BCD\u4E0D\u89E6\u53D1\uFF08\u6253\u65AD\u6309 VAD\uFF09\uFF1B\u5339\u914D\u5E26\u5BB9\u9519\uFF08\u540C\u97F3\u5B57/\u524D\u5BFC\u8BED\u6C14\u8BCD\uFF09\uFF0C\u5EFA\u8BAE 3-4 \u5B57\uFF1B\u975E\u4E13\u7528 KWS \u5F15\u64CE\uFF0C\u5608\u6742\u73AF\u5883\u53EF\u80FD\u5EF6\u8FDF\u6216\u8BEF\u6FC0\u6D3B"),
    toolBeep: z.boolean().default(d.toolBeep).description('\u5DE5\u5177\u8C03\u7528\u63D0\u793A\u97F3\uFF08\u9ED8\u8BA4\u5173\uFF09\uFF1A\u5F00\u542F\u540E AI \u8C03\u7528\u5DE5\u5177\u65F6"\u6EF4"\u4E00\u58F0\uFF0C\u5173\u95ED\u5219\u5168\u7A0B\u9759\u9ED8'),
    senseITN: z.boolean().default(d.senseITN).description("SenseVoice \u9006\u6587\u672C\u5F52\u4E00\u5316\uFF08\u6570\u5B57/\u65E5\u671F\u89C4\u8303\u5316\uFF0C\u9ED8\u8BA4\u5F00\uFF1B\u5173\u95ED\u540E\u8F93\u51FA\u66F4\u63A5\u8FD1\u53E3\u8BED\u539F\u6587\uFF09"),
    captionFontSize: z.union([z.const(0), z.const(1), z.const(2), z.const(3)]).default(d.captionFontSize).description(
      "\u5B57\u5E55\u5B57\u53F7\u6863\u4F4D\uFF080=12px/1=14px/2=18px/3=24px\uFF1B\u9ED8\u8BA4 0 \u4E0E\u73B0\u72B6\u5B57\u8282\u7B49\u4EF7\uFF1B\u5207\u6362\u5373\u65F6\u751F\u6548\uFF09"
    ),
    captionMaxWidth: z.union([z.const(0), z.const(1), z.const(2)]).default(d.captionMaxWidth).description(
      "\u5B57\u5E55\u5BBD\u5EA6\u6863\u4F4D\uFF080=50vw/1=70vw/2=90vw\uFF1B\u9ED8\u8BA4 1\uFF1B\u89C6\u53E3 <686px \u65F6\u7A84\u4E8E\u73B0\u72B6 480px\u3001\u2248686px \u65F6\u63A5\u8FD1\u3001>686px \u65F6\u5BBD\u4E8E 480px\uFF1B\u5207\u6362\u5373\u65F6\u751F\u6548\uFF09"
    ),
    backchannelYield: z.boolean().default(d.backchannelYield).description(
      "\u8BA9\u4F4D\u8BED\u4E49\uFF08\u6279 5 / ADR-0008 Phase 1\uFF0C\u9ED8\u8BA4\u5F00\uFF09\uFF1A\u6717\u8BFB\u671F\u7528\u6237\u8BF4\u300C\u55EF/\u5BF9\u300D\u7B49\u77ED\u5E94\u7B54\u65F6\uFF0C\u81EA\u52A8\u8DF3\u8FC7\u5F53\u524D TTS \u53E5\u5E76\u77ED\u6682\u8BA9\u4F4D 1.5s\u2014\u20141.5s \u5185\u7528\u6237\u771F\u8981\u8BF4\u5219\u8D70\u539F hardBreak \u53D6\u6D88\u56DE\u5408\uFF1B\u5173 = \u4E0D\u8BA9\u4F4D\uFF0C\u884C\u4E3A\u7B49\u540C\u6539\u9020\u524D"
    ),
    yieldMs: z.number().min(500).max(3e3).default(d.yieldMs).description(
      "\u8BA9\u4F4D\u7A97\u53E3\u65F6\u957F\uFF08ms\uFF0C500-3000\uFF0C\u9ED8\u8BA4 1500\uFF09\uFF1Abackchannel \u547D\u4E2D\u540E TTS \u4E22\u5E27\u6301\u7EED\u65F6\u95F4\u3002\u7A97\u53E3\u5185\u7528\u6237\u771F\u8981\u8BF4\u5219\u539F hardBreak \u63A5\u7BA1\uFF1B\u7A97\u53E3\u5230\u70B9\u81EA\u52A8\u6062\u590D\u64AD\u653E\u3002"
    ),
    asrEngine: z.union([z.const("auto"), z.const("cpu"), z.const("sensevoice")]).default(d.asrEngine).description(
      "语音识别引擎（默认 auto）：auto = 显卡上的 Fun-ASR-Nano 优先，最准、约 0.42 秒/句，代价是常驻约 1.9G 显存；cpu = 只用 CPU 上的 int8 模型，不占显存也不需要 Python，约 0.9 秒/句；sensevoice = 只用 SenseVoice int8，最省资源但英文术语较弱。三个档次都会自动降级，不需要重启应用。"
    )
  });
}
var VoiceSettingsSchema = createVoiceSettingsSchema();
var Config = z.object({
  enabled: z.boolean().default(true),
  cacheDir: z.string().default(defaultModelCacheDir()),
  modelHost: z.string().default("https://huggingface.co"),
  ttsEngine: z.union([z.const("edge"), z.const("zipvoice"), z.const("kokoro")]).default("edge"),
  kokoroModel: z.union([z.const("int8"), z.const("fp32")]).default("int8"),
  allowLan: z.boolean().default(false),
  allowCustomModelHost: z.boolean().default(false),
  voice: z.string().default("zh-CN-XiaoxiaoNeural"),
  rate: z.number().min(0.5).max(3).default(1.1).volatile(),
  // ZipVoice 显卡引擎：换成自己的参考音频（克隆音色）就改这两项
  zipvoicePython: z.string().default(""),
  zipvoiceRepo: z.string().default(""),
  zipvoicePromptWav: z.string().default(""),
  zipvoicePromptText: z.string().default(""),
  zipvoiceNumStep: z.number().min(2).max(32).default(4),
  // 停顿倍数：在设置面板里可调，改完立即生效（本地引擎用）
  pauseScale: z.number().min(0).max(2).default(1).volatile(),
  interruptLevel: z.union([z.const(0), z.const(1), z.const(2)]).default(0),
  silenceMs: z.number().default(1500),
  idleTimeoutMinutes: z.number().default(5),
  // 设置面板字段（与 VoiceSettingsValue 一一对应；0.1.7+ 由插件自身 Config 派生读取）。
  // 注意：刻意不标 .volatile() —— schemastery 3.18.4 的 volatile 会破坏 schema 函数
  // 调用形态（sv({}) → {field:{}}），而 0.1.5-rc.3 起的设置分层会调用插件 Config 做
  // merge，{} 透过 mergeLayers 污染并触发 ValidationError（2026-09-23 实测）。
  // 0.1.7 功能读取走 config 直接读，不依赖 volatile（仅官方 UI 自动投影受影响，
  // 本插件自带 settings-form 设置面板 + /voice-mode/config，不受影响）。
  autoSend: z.boolean().default(true),
  autoResume: z.boolean().default(false),
  mode: z.union([z.const("toggle"), z.const("hold")]).default("toggle").volatile(),
  bargeInMode: z.union([z.const("auto"), z.const("manual"), z.const("detect")]).default("detect"),
  echoGateDb: z.number().default(6),
  shortcut: z.string().default("Ctrl+Shift+V"),
  spokenFormat: z.boolean().default(true),
  senseVoice: z.boolean().default(true),
  // 2026-10-17：ASR 三层阶梯的选择（auto=显卡优先 / cpu=只用 CPU int8 / sensevoice=只用 SenseVoice）
  asrEngine: z.union([z.const("auto"), z.const("cpu"), z.const("sensevoice")]).default("auto"),
  wakeWord: z.string().default(""),
  toolBeep: z.boolean().default(false),
  senseITN: z.boolean().default(true),
  captionFontSize: z.union([z.const(0), z.const(1), z.const(2), z.const(3)]).default(0),
  captionMaxWidth: z.union([z.const(0), z.const(1), z.const(2)]).default(1),
  backchannelYield: z.boolean().default(true),
  yieldMs: z.number().default(1500)
});
var VOLATILE_WRITE2 = Symbol.for("cosmokit.volatile.write");
function unwrapVolatile2(v) {
  return v !== null && typeof v === "object" && typeof v.get === "function" && typeof v[VOLATILE_WRITE2] === "function" ? v.get() : v;
}

function voiceSettingsFromConfig(config) {
  const {
    ttsEngine,
    kokoroModel,
    voice,
    rate,
    interruptLevel,
    silenceMs,
    idleTimeoutMinutes,
    modelHost,
    autoSend,
    autoResume,
    mode,
    bargeInMode,
    echoGateDb,
    shortcut,
    spokenFormat,
    senseVoice,
    wakeWord,
    toolBeep,
    senseITN,
    captionFontSize,
    captionMaxWidth,
    backchannelYield,
    yieldMs
  } = config;
  return {
    ttsEngine,
    kokoroModel,
    voice,
    rate,
    interruptLevel,
    silenceMs,
    idleTimeoutMinutes,
    modelHost,
    autoSend,
    autoResume,
    mode,
    bargeInMode,
    echoGateDb,
    shortcut,
    spokenFormat,
    senseVoice,
    wakeWord,
    toolBeep,
    senseITN,
    captionFontSize,
    captionMaxWidth,
    backchannelYield,
    yieldMs
  };
}
function apply(ctx, config) {
  let activeVoiceSession = null;
  // 2026-10-18：把“当前语音会话”暴露成服务，agent-restart 插件重启时据此记录要不要恢复语音。
  try {
    if (typeof ctx.provide === "function") ctx.provide("voiceActiveSession", () => activeVoiceSession);
  } catch {
  }
  let activeTabId = null;
  let ownerYieldTimer = null;
  const turnStates = /* @__PURE__ */ new Map();
  const setTurn = (sessionId, state) => {
    if (turnStates.get(sessionId) === state) return;
    turnStates.set(sessionId, state);
    broadcast("turn", { sessionId, state });
  };
  const turnGen = /* @__PURE__ */ new Map();
  const sessions = ctx.get("sessions");
  const limiter = new RateLimiter();
  const limiterPrune = setInterval(() => limiter.prune(Date.now(), 6e4), 6e4);
  ctx.effect(() => () => clearInterval(limiterPrune));
  const normalizedModelHost = () => validateModelHost(vset.modelHost, config.allowCustomModelHost) ?? HOST_PRIMARY;
  const denyNonLoopback = (req, res) => {
    if (!config.allowLan && !isLoopbackRequest(req)) {
      res.statusCode = 403;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "loopback only (allowLan=false)" }));
      return true;
    }
    return false;
  };
  const denyCrossOrigin = (req, res) => {
    if (!sameOriginRequest(req)) {
      res.statusCode = 403;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "cross-origin request denied" }));
      return true;
    }
    return false;
  };
  const sseClients = /* @__PURE__ */ new Set();
  const latestConnByTab = /* @__PURE__ */ new Map();
  const broadcast = (event, payload) => {
    for (const c of sseClients) {
      try {
        c.send(event, payload);
      } catch {
      }
    }
  };
  const legacySettings = ctx.settings;
  const useLegacySettings = typeof legacySettings?.register === "function";
  let settingsScopeRef = null;
  let vset;
  if (useLegacySettings && legacySettings && typeof legacySettings.register === "function") {
    const settingsScope = legacySettings.register.call(
      legacySettings,
      NS_VOICE_MODE,
      createVoiceSettingsSchema(),
      {
        base: {
          ttsEngine: config.ttsEngine,
          voice: config.voice,
          rate: config.rate,
          interruptLevel: config.interruptLevel,
          silenceMs: config.silenceMs,
          idleTimeoutMinutes: config.idleTimeoutMinutes,
          modelHost: config.modelHost
        }
      }
    );
    vset = settingsScope.get();
    settingsScopeRef = settingsScope;
  } else {
    vset = voiceSettingsFromConfig(config);
  }
  // 2026-10-17：Python 解释器的唯一出处。识别第 1 层和朗读引擎都用这一份，
  // 不再各写一个路径字面量（之前硬编码兜底就是为了绕开初始化顺序，属于治标）。
  const PYTHON_EXE = "C:\\Users\\Administrator\\AppData\\Local\\dsh-voice-mode\\runtimes\\py310-cu128\\Scripts\\python.exe";
  // 2026-10-18：识别引擎档位的唯一真值来源。
  // 之前面板只写 put(vset.asrEngine)，但 vset 里只有 rate/mode/pauseScale 是 volatile 可写引用，
  // asrEngine 是一次性快照——写不进去，读回来永远是 auto；运行时读的也是这份快照。
  // 于是下拉框看着能选，引擎不动，界面还总弹回第一项。
  let asrEngineValue = null;
  const readAsrEngine = () => {
    let v = asrEngineValue;
    if (v === null) v = unwrapVolatile2(vset.asrEngine);
    return v === "cpu" || v === "sensevoice" ? v : "auto";
  };
  const asr = createAsrRuntime({
    cacheDir: config.cacheDir,
    // 2026-10-17：解释器路径必须从这里传进去——识别运行时是另一个函数作用域，直接引用外层 const 会 ReferenceError。
    // 用 getter 传，设置里的自定义 python 路径依然生效。
    pythonExe: () => vset.zipvoicePython || PYTHON_EXE,
    modelHost: () => vset.modelHost,
    // P4：SenseVoice 定稿重译开关（实时读取，关闭则不下载/不创建模型）。
    senseVoice: () => vset.senseVoice,
    // 断句静音阈值（实时读取）：端点 VAD minSilenceDuration 跟随设置。
    silenceMs: () => vset.silenceMs,
    // 批 2：SenseVoice ITN 实时读取；变更触发 worker 重建。
    senseITN: () => vset.senseITN,
    allowCustomHost: config.allowCustomModelHost,
    broadcast,
    // 批 7N（ADR-0006）：打断方式 getter（实时读设置）；manual 模式下 feed 需 manualPressed=true。
    bargeInMode: () => vset.bargeInMode,
    // 2026-10-18：档位从 readAsrEngine 读，面板/工具一改就生效。
    asrEngine: readAsrEngine
  });
  // 2026-10-18：档位要落盘。DSH 的 ctx.settings.mutate 在这版里不生效（写不进去，重启就丢），
  // 所以自己写一份 settings.json，启动时读回来。
  const voiceStateDir = () => join4(process.env.LOCALAPPDATA || homedir(), "dsh-voice-mode");
  const voiceStateFile = () => join4(voiceStateDir(), "settings.json");
  const persistAsrEngine = (engine) => {
    void import("node:fs/promises").then(async (fsp) => {
      try {
        await fsp.mkdir(voiceStateDir(), { recursive: true });
        let cur = {};
        try { cur = JSON.parse(await fsp.readFile(voiceStateFile(), "utf8")); } catch { cur = {}; }
        if (!cur || typeof cur !== "object") cur = {};
        cur.asrEngine = engine;
        await fsp.writeFile(voiceStateFile(), JSON.stringify(cur, null, 2), "utf8");
      } catch (e) {
        console.log("[dsh-voice-mode] 档位落盘失败：" + String((e && e.message) || e));
      }
    });
  };
  // 2026-10-18：面板、设置接口、工具三条路统一走这里，改本地值 + 立刻切运行时 + 落盘。
  const applyAsrEngine = (engine) => {
    const next = engine === "cpu" || engine === "sensevoice" ? engine : "auto";
    asrEngineValue = next;
    try {
      asr.setAsrEngine(next);
    } catch (e) {
      console.log("[dsh-voice-mode] 应用识别档位失败：" + String((e && e.message) || e));
    }
    persistAsrEngine(next);
    return next;
  };
  // 启动时把上次的档位读回来（在 DSH 设置读完之后，避免被默认值盖掉）。
  void import("node:fs/promises").then(async (fsp) => {
    try {
      const saved = JSON.parse(await fsp.readFile(voiceStateFile(), "utf8"));
      if (saved && (saved.asrEngine === "cpu" || saved.asrEngine === "sensevoice" || saved.asrEngine === "auto")) {
        applyAsrEngine(saved.asrEngine);
        console.log("[dsh-voice-mode] 已恢复识别引擎档位：" + saved.asrEngine);
      }
    } catch {
    }
  });
  // 2026-10-18：语音恢复信号由 agent-restart 插件用文件交接（voice-resume.json）。
  // 语音插件只负责“把语音开回来”，不读 journal、不注入待办、不碰重启逻辑。
  const voiceResumeFile = () => join4(process.env.LOCALAPPDATA || homedir(), "dsh-voice-mode", "voice-resume.json");
  let voiceResume = null;
  try {
    const j = JSON.parse(readFileSync(voiceResumeFile(), "utf8"));
    if (j && typeof j.at === "string" && Date.now() - new Date(j.at).getTime() < 10 * 60 * 1000) {
      voiceResume = {
        voiceSessionId: typeof j.sessionId === "string" ? j.sessionId : null,
        loadedAt: Date.now()
      };
      console.log("[dsh-voice-mode] 语音恢复信号已就绪");
    }
  } catch {
  }
  ctx.effect(() => () => asr.dispose());
  void asr.warmup();
  // ===== ZipVoice（显卡引擎）=====
  // 2026-10-15：本地方案里唯一同时满足“中英混合 + 音色可克隆 + 显卡跑得动”的。
  // 它是 PyTorch，插件跑在 Node 里，所以用一个常驻的 python 子进程，走 JSON 行协议 ——
  // 和 sherpa 那个 TTS 子进程是同一个思路，只是换成了 python。
  // 模型和参考音频默认位置见下面的 ZIPVOICE_DEFAULTS，都可以在设置里覆盖。
  const ZIPVOICE_WORKER = fileURLToPath2(new URL("./tts-zipvoice-worker.py", import.meta.url));
  const zipvoiceModelDir = () => join4(config.cacheDir ?? defaultModelCacheDir(), "zipvoice");
  // 只有 python 环境是个外部绝对路径（几十个 G，没法搬进插件）。
  // 源码和参考音频都跟着插件走：源码在 lib/zipvoice-src，参考音频在插件的模型目录里。
  const ZIPVOICE_SRC = fileURLToPath2(new URL("./zipvoice-src", import.meta.url));
  const ZIPVOICE_DEFAULTS = {
    // 2026-10-17：TTS 与 ASR 合并到同一套环境（torch 2.10 + transformers 5.17 + TensorRT）。
    // 音质等价性已用 24 组配对、UTMOS 打分验证（无显著差异）；旧环境 dsh-voice-mode-pyenv 保留作回退。
    // 2026-10-17：环境搬到应用数据目录（原来是 D:\Study\dsh-asr-pyenv，产品化后会从用户视野里消失）。
    // 直接复制即可用：venv 靠同目录的 pyvenv.cfg 定位解释器，基础 Python 没动，控制台脚本我们也不用。
    python: PYTHON_EXE,
    repo: "",
    numStep: 4,
    promptWav: "",
    // 2026-10-15：参考音频换成 3.62 秒那半句，文本与音频严格一致。
    // 原来那段里 kokoro 把 OpenCode / DSH 念成了"贝诺/盒子"这种怪音，文本却写着英文，
    // 参考音频和参考文本对不上，克隆质量会打折。换短之后合成也快了一大截。
    promptText: "这个工具是本地跑的，不联网，也不花钱。"
  };
  // 2026-10-15：做单例。插件在启动时会 makeEngine 两次（初始化一次、设置加载后又切一次），
  // 每次都会拉起一个 python 子进程 —— 实测确实出现了两个，各占一份显存。
  // 单例之后，换引擎再切回来也会复用同一个进程，省掉重新加载的六秒。
  let zipvoiceEngineSingleton = null;
  const getZipVoiceEngine = () => {
    if (!zipvoiceEngineSingleton) zipvoiceEngineSingleton = createZipVoiceEngine();
    return zipvoiceEngineSingleton;
  };
  const createZipVoiceEngine = () => {
    let child = null;
    let stdoutBuf = "";
    let nextId = 0;
    let pending = /* @__PURE__ */ new Map();
    let loading = null;
    let engineError2 = "";
    let speed = 1.1;
    let pendingReady = null;
    // 2026-10-15 关键修复：加载成功的凭据必须缓存下来。
    // 原来这里只挡了"正在加载"（loading），加载完成之后 loading 归零，
    // 于是每一次合成都会重新 spawn 一个 python 子进程 —— 每说一句话就重新加载一次模型
    // （约 5～8 秒），听起来就是"每个句号都停顿非常久"，显存也一路涨到撑爆。
    let readyInfo = null;
    // 代次：close() 会让它 +1，正在加载的那一次发现代次变了就把自己的子进程杀掉，
    // 否则会出现「已经切走引擎了，旧进程却还在加载，最后留在显存里」。
    let generation = 0;
    const settings = () => ({
      python: vset.zipvoicePython || ZIPVOICE_DEFAULTS.python,
      repo: vset.zipvoiceRepo || ZIPVOICE_SRC,
      numStep: Number(vset.zipvoiceNumStep) || ZIPVOICE_DEFAULTS.numStep,
      promptWav: vset.zipvoicePromptWav || join3(zipvoiceModelDir(), "prompt.wav"),
      promptText: vset.zipvoicePromptText || ZIPVOICE_DEFAULTS.promptText
    });
    const call = (payload) => new Promise((resolve, reject) => {
      if (!child || !child.stdin || child.stdin.destroyed) {
        reject(new Error("zipvoice 子进程没起来"));
        return;
      }
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      try {
        child.stdin.write(JSON.stringify({ id, ...payload }) + "\n");
      } catch (e) {
        pending.delete(id);
        reject(e);
      }
    });
    const handleLine = (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.ready === true) {
        if (pendingReady) pendingReady(msg);
        return;
      }
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg);
      else p.reject(new Error(msg.error || "zipvoice 合成失败"));
    };
    const ensureReady = () => {
      if (readyInfo && child) return Promise.resolve(readyInfo);
      if (loading) return loading;
      loading = (async () => {
        const st = settings();
        const modelDir = zipvoiceModelDir();
        for (const [what, p] of [["python", st.python], ["worker", ZIPVOICE_WORKER], ["model/model.pt", join3(modelDir, "model.pt")], ["参考音频", st.promptWav]]) {
          let ok = false;
          try {
            ok = statSync2(p).isFile();
          } catch {
          }
          if (!ok) throw new Error("zipvoice 缺少" + what + "：" + p);
        }
        child = spawn(st.python, [
          "-u",
          ZIPVOICE_WORKER,
          "--repo", st.repo,
          "--model-dir", modelDir,
          "--vocos-dir", join3(modelDir, "vocos"),
          "--prompt-wav", st.promptWav,
          "--prompt-text", st.promptText,
          "--num-step", String(st.numStep)
        ], {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          // 2026-10-15：显存碎片缓解 + 失败时让 worker 自己回落到 CPU（worker 里也设了一份，
          // 这里是双保险：环境变量必须在 CUDA 初始化之前就位）。
          env: { ...process.env, PYTORCH_CUDA_ALLOC_CONF: "expandable_segments:True", ZIPVOICE_DEVICE: "auto" }
        });
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        stdoutBuf = "";
        child.stdout.on("data", (chunk) => {
          stdoutBuf += chunk;
          let idx;
          while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
            const line = stdoutBuf.slice(0, idx).trim();
            stdoutBuf = stdoutBuf.slice(idx + 1);
            if (line) handleLine(line);
          }
        });
        const tail = { value: "" };
        child.stderr.on("data", (chunk) => {
          tail.value = (tail.value + chunk).slice(-800);
        });
        child.on("exit", () => {
          child = null;
          readyInfo = null;
          for (const [, p] of pending) p.reject(new Error("zipvoice 子进程退出：" + tail.value.trim().slice(-200)));
          pending.clear();
        });
        const myGen = generation;
        const readyMsg = new Promise((resolve) => {
          pendingReady = resolve;
        });
        const info = await readyMsg;
        if (myGen !== generation) {
          try {
            child?.kill();
          } catch {
          }
          child = null;
          throw new Error("引擎已被切换，这次加载作废");
        }
        engineError2 = "";
        readyInfo = info;
        return info;
      })().catch((e) => {
        engineError2 = e instanceof Error ? e.message : String(e);
        readyInfo = null;
        try {
          child?.kill();
        } catch {
        }
        child = null;
        throw e;
      }).finally(() => {
        loading = null;
      });
      return loading;
    };
    return {
      mime: "audio/wav",
      updateVoice(nextVoice, nextRate) {
        // 2026-10-15：ZipVoice 的速度是直接乘数。实测同一句话：1.0 秒懂、2.0 开始丢字、3.0 完全不可懂。
        // 所以这里封到 1.3，界面上的滑块再往上拖也不会把话压坏。
        if (typeof nextRate === "number" && Number.isFinite(nextRate)) speed = Math.min(2, Math.max(0.5, nextRate));
      },
      status() {
        const modelDir = zipvoiceModelDir();
        const files = ["model.pt", "model.json", "tokens.txt"].map((f) => {
          let exists = false;
          let size = 0;
          try {
            const st = statSync2(join3(modelDir, f));
            exists = st.isFile();
            size = st.size;
          } catch {
          }
          return { name: f, exists, size };
        });
        return { engine: "zipvoice", ready: child !== null, loading: loading !== null, error: engineError2, files, dir: modelDir };
      },
      prepare: () => ensureReady(),
      async synthesize(text, opts = {}) {
        await ensureReady();
        const spd = typeof opts.rate === "number" && Number.isFinite(opts.rate) ? Math.min(2, Math.max(0.5, opts.rate)) : speed;
        const st = settings();
        const res = await call({
          type: "synth",
          text,
          speed: spd,
          numStep: st.numStep,
          promptWav: opts.promptWav || st.promptWav,
          promptText: opts.promptText || st.promptText
        });
        const bytes = Buffer.from(res.samples, "base64");
        const samples = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
        return pcmToWav(floatToPcm16(samples), res.sampleRate || 24e3);
      },
      async close() {
        generation += 1;
        readyInfo = null;
        try {
          await call({ type: "close" });
        } catch {
        }
        try {
          child?.kill();
        } catch {
        }
        child = null;
      }
    };
  };
  const makeEngine = (kind) => {
    if (kind === "edge") return new EdgeTtsEngine(config.voice, unwrapVolatile2(config.rate));
    if (kind === "zipvoice") return getZipVoiceEngine();
    if (kind === "kokoro") {
      return createSherpaKokoroEngine({
        cacheDir: config.cacheDir,
        modelHost: normalizedModelHost,
        allowCustomHost: config.allowCustomModelHost,
        model: vset.kokoroModel,
        broadcast
      });
    }
    return createSherpaVitsEngine({
      cacheDir: config.cacheDir,
      modelHost: normalizedModelHost,
      allowCustomHost: config.allowCustomModelHost,
      broadcast
    });
  };
  let engineKind = vset.ttsEngine ?? config.ttsEngine;
  let activeKokoroModel = vset.kokoroModel;
  const queue = new TtsQueue({
    engine: makeEngine(engineKind),
    onError: (sessionId) => broadcast("tts-error", { sessionId }),
    // 单句重试耗尽被跳过：显式下行（客户端提示 + 诊断），不再静默丢句。
    onSkip: (sessionId, text) => broadcast("tts-skip", { sessionId, text: text.slice(0, 80) })
  });
  queue.updateVoice(vset.voice, unwrapVolatile2(vset.rate), unwrapVolatile2(vset.pauseScale));
  const unsubscribe = queue.subscribe((frame) => broadcast("audio", frame));
  ctx.effect(() => unsubscribe);
  ctx.effect(() => () => void queue.close());
  if (settingsScopeRef) {
    const scopeRef = settingsScopeRef;
    ctx.effect(
      () => scopeRef.watch((next) => {
        const prev = vset;
        vset = next;
        if (next.ttsEngine !== engineKind) {
          engineKind = next.ttsEngine;
          queue.setEngine(makeEngine(engineKind));
        } else if (engineKind === "kokoro" && next.kokoroModel !== activeKokoroModel) {
          activeKokoroModel = next.kokoroModel;
          queue.setEngine(makeEngine("kokoro"));
        }
        queue.updateVoice(next.voice, next.rate);
        if (next.senseITN !== prev.senseITN || next.senseVoice !== prev.senseVoice) {
          asr.markStale();
        }
        // 2026-10-17：切到非 auto 档要立刻把显卡上的第 1 层放掉（释放约 1.9G 显存）；
        // 切回 auto 则重新后台加载。改动会由设置系统持久化，重启后保持。
        if (next.asrEngine !== prev.asrEngine) {
          asr.setAsrEngine(next.asrEngine);
        }
      })
    );
  }
  // 2026-10-18：同源切换口。面板走 /voice-mode/settings，代码走这个工具；两边都只做一件事——
  // 往同一份设置里写 asrEngine，由上面的 scopeRef.watch 应用。所以效果必然一致，不需要重启。
  try {
    ctx.inject(["tools"], (scoped) => {
      try {
        const off = scoped.tools.register({
          name: "voice_mode_set",
          description: "切换语音模式的设置（目前是识别引擎档位）。写入的是面板用的同一份设置，效果与在面板里切换完全一致。",
          parameters: {
            type: "object",
            properties: {
              asrEngine: { type: "string", enum: ["auto", "cpu", "sensevoice"], description: "auto=显卡优先，cpu=只用 CPU int8，sensevoice=只用 SenseVoice" }
            },
            additionalProperties: false
          },
          output: {
            schema: {
              type: "object",
              properties: {
                ok: { type: "boolean", description: "是否写入成功" },
                asrEngine: { type: "string", description: "写入的档位" },
                tier: { type: "string", description: "当前实际所在层" },
                gpu: { type: "string", description: "显卡那一层的状态" }
              },
              required: ["ok", "asrEngine"]
            },
            render: (result) => [{ type: "text", text: JSON.stringify(result) }]
          },
          execute: async (args) => {
            const requested = args && args.asrEngine;
            if (!["auto", "cpu", "sensevoice"].includes(requested)) throw new Error("asrEngine 必须是 auto / cpu / sensevoice");
            // 2026-10-18：和面板走同一个函数，先实时生效，再尝试持久化；持久化失败不影响本次切换。
            const asrEngine = applyAsrEngine(requested);
            try {
              await ctx.settings.mutate(NS_VOICE_MODE, [{ op: "set", path: ["asrEngine"], value: asrEngine }]);
            } catch (e) {
            }
            const st = asr.status() || {};
            return { ok: true, asrEngine, tier: st.tier ?? "", gpu: st.gpu ?? "" };
          }
        });
        if (typeof off === "function") ctx.effect(() => off);
        console.log("[dsh-voice-mode] 同源切换口已注册");
      } catch (e) {
        console.log("[dsh-voice-mode] 同源切换口注册失败：", String(e && e.message || e));
      }
    });
  } catch (e) {
    console.log("[dsh-voice-mode] 同源切换口不可用：", String(e && e.message || e));
  }
  const currentVoice = () => vset.voice;
  // 本地引擎的音色表（edge 的音色得联网拉，界面走 /voices 那条路）
  const currentVoices = () => {
    try {
      // zipvoice 的音色就是参考音频，没有可选列表
      if (engineKind === "zipvoice") return [];
      if (engineKind === "kokoro") return KOKORO_VOICES.map((v) => ({ name: v.name, label: v.label }));
    } catch {
    }
    return [];
  };
  const currentRate = () => unwrapVolatile2(vset.rate);
  const currentInterrupt = () => vset.interruptLevel;
  const currentEngine = () => engineKind;
  const yieldActiveSession = (expectedSid) => {
    ownerYieldTimer = null;
    const sid = activeVoiceSession;
    if (!sid) return;
    if (expectedSid !== void 0 && expectedSid !== sid) return;
    activeVoiceSession = null;
    activeTabId = null;
    queue.cancel(sid);
    asr.reset(sid);
    setTurn(sid, "idle");
    turnStates.delete(sid);
    broadcast("mode", { active: null, ownerTabId: activeTabId });
  };
  ctx.on("system-prompt/assemble", (assembly, context, next) => {
    if (!config.enabled || !vset.spokenFormat) return next();
    const agentId = context.agent?.id;
    if (agentId !== void 0 && agentId === activeVoiceSession) {
      assembly.sections.push({ name: VOICE_SPOKEN_SECTION, text: VOICE_SPOKEN_PROMPT });
    }
    return next();
  });
  ctx.on("llm/stream", (options, next) => {
    const rawSessionId = options.sessionId;
    if (!config.enabled || rawSessionId === void 0 || options.purpose !== void 0) return next();
    const sessionId = rawSessionId;
    if (activeVoiceSession !== sessionId) {
      try {
        console.log("[dsh-voice-mode] skip stream: voice=" + String(activeVoiceSession) + " stream=" + sessionId);
      } catch {
      }
      return next();
    }
    const gen = (turnGen.get(sessionId) ?? 0) + 1;
    turnGen.set(sessionId, gen);
    return tapActiveStream(
      sessionId,
      next(),
      queue,
      broadcast,
      (state) => {
        if ((turnGen.get(sessionId) ?? 0) === gen) setTurn(sessionId, state);
      }
    );
  });
  const base = BASE_PATH;
  ctx.effect(
    () => ctx.webServer.register({
      kind: "prefix",
      path: base,
      handler: (req, res) => {
        if (denyNonLoopback(req, res)) return;
        respondJson2(res, 200, {
          ok: true,
          name: "dsh-voice-mode",
          enabled: config.enabled,
          active: activeVoiceSession
        });
      }
    })
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: `${base}/config`,
      handler: (req, res) => {
        if (denyNonLoopback(req, res)) return;
        respondJson2(res, 200, {
          basePath: base,
          rate: currentRate(),
          pauseScale: unwrapVolatile2(vset.pauseScale),
          voice: currentVoice(),
          voices: currentVoices(),
          senseVoice: vset.senseVoice,
          interruptLevel: currentInterrupt(),
          silenceMs: vset.silenceMs,
          idleTimeoutMinutes: vset.idleTimeoutMinutes,
          modelHost: vset.modelHost,
          autoSend: vset.autoSend,
          autoResume: vset.autoResume,
          mode: unwrapVolatile2(vset.mode),
          bargeInMode: vset.bargeInMode,
          echoGateDb: vset.echoGateDb,
          shortcut: vset.shortcut,
          wakeWord: vset.wakeWord,
          toolBeep: vset.toolBeep,
          asrStatus: asr.status(),
          asrEngine: readAsrEngine(),
          // 2026-10-18：重启续做 —— 重启前语音开着就自动恢复，客户端据此自己进语音模式。
          resumeVoice: voiceResume !== null,
          resumeSessionId: voiceResume && voiceResume.voiceSessionId ? voiceResume.voiceSessionId : null,
          captionFontSize: vset.captionFontSize,
          captionMaxWidth: vset.captionMaxWidth,
          backchannelYield: vset.backchannelYield,
          yieldMs: vset.yieldMs,
          senseITN: vset.senseITN,
          cacheDir: config.cacheDir,
          ttsEngine: currentEngine(),
          audioMime: queue.mime,
          allowLan: config.allowLan
        });
      }
    })
  );
  // 本地补丁：写入语速/交互方式（供边栏插件页的“语音模式”卡片使用）。
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: `${base}/settings`,
      handler: (req, res) => {
        if (denyNonLoopback(req, res)) return;
        if (denyCrossOrigin(req, res)) return;
        if (req.method !== "POST") {
          respondJson2(res, 405, { error: "POST only" });
          return;
        }
        collectBody(req, res, MAX_JSON_BODY, async (body) => {
          let rate;
          let mode;
          let pauseScale;
          let voice;
          let ttsEngine;
          let asrEngine;
          try {
            const parsed = JSON.parse(body || "{}");
            if (typeof parsed.rate === "number" && Number.isFinite(parsed.rate)) rate = Math.min(3, Math.max(0.5, parsed.rate));
            if (typeof parsed.pauseScale === "number" && Number.isFinite(parsed.pauseScale)) pauseScale = Math.min(2, Math.max(0, parsed.pauseScale));
            if (parsed.mode === "toggle" || parsed.mode === "hold") mode = parsed.mode;
            // 2026-10-14：音色和引擎也做成可写的，界面才能自己切
            if (typeof parsed.voice === "string" && parsed.voice.trim()) voice = parsed.voice.trim();
            // 2026-10-16：白名单是老的——有已删掉的 vits、没有 zipvoice，界面上选 zipvoice 会被丢掉。
            if (parsed.ttsEngine === "edge" || parsed.ttsEngine === "zipvoice" || parsed.ttsEngine === "kokoro") ttsEngine = parsed.ttsEngine;
            // 2026-10-17：识别引擎档位（auto=显卡优先 / cpu=只用 CPU int8 / sensevoice=只用 SenseVoice）
            if (parsed.asrEngine === "auto" || parsed.asrEngine === "cpu" || parsed.asrEngine === "sensevoice") asrEngine = parsed.asrEngine;
          } catch {
          }
          if (rate === void 0 && mode === void 0 && pauseScale === void 0 && voice === void 0 && ttsEngine === void 0 && asrEngine === void 0) {
            respondJson2(res, 400, { error: "rate, pauseScale, mode, voice, ttsEngine or asrEngine required" });
            return;
          }
          const VW = Symbol.for("cosmokit.volatile.write");
          const put = (ref, value) => {
            try {
              if (ref !== null && typeof ref === "object" && typeof ref[VW] === "function") ref[VW](value);
            } catch {
            }
          };
          if (rate !== void 0) put(vset.rate, rate);
          if (pauseScale !== void 0) put(vset.pauseScale, pauseScale);
          if (mode !== void 0) put(vset.mode, mode);
          if (voice !== void 0) put(vset.voice, voice);
          if (ttsEngine !== void 0) put(vset.ttsEngine, ttsEngine);
          if (asrEngine !== void 0) applyAsrEngine(asrEngine);
          if (ttsEngine !== void 0 && ttsEngine !== engineKind) {
            // 2026-10-16：切引擎原先只挂在已废弃的 settingsScope.watch 上，界面能点却没有任何代码
            // 真正重建引擎（表现：切了没反应，读回来还是 zipvoice）。照抄清缓存路由的写法。
            engineKind = ttsEngine;
            queue.setEngine(makeEngine(engineKind));
          }
          try {
            queue.updateVoice(vset.voice, unwrapVolatile2(vset.rate), unwrapVolatile2(vset.pauseScale));
          } catch {
          }
          let persisted = false;
          try {
            if (ctx.settings && typeof ctx.settings.mutate === "function") {
              const ops = [];
              if (rate !== void 0) ops.push({ op: "set", path: ["rate"], value: rate });
              if (pauseScale !== void 0) ops.push({ op: "set", path: ["pauseScale"], value: pauseScale });
              if (mode !== void 0) ops.push({ op: "set", path: ["mode"], value: mode });
              if (voice !== void 0) ops.push({ op: "set", path: ["voice"], value: voice });
              if (ttsEngine !== void 0) ops.push({ op: "set", path: ["ttsEngine"], value: ttsEngine });
              if (asrEngine !== void 0) ops.push({ op: "set", path: ["asrEngine"], value: asrEngine });
              await ctx.settings.mutate(NS_VOICE_MODE, ops);
              persisted = true;
            }
          } catch {
          }
          respondJson2(res, 200, {
            ok: true,
            rate: unwrapVolatile2(vset.rate),
            pauseScale: unwrapVolatile2(vset.pauseScale),
            mode: unwrapVolatile2(vset.mode),
            voice: vset.voice,
            ttsEngine: engineKind,
            asrEngine: readAsrEngine(),
            persisted
          });
        });
      }
    })
  );
  // 2026-10-18：语音自动恢复完成后客户端回执，删掉交接文件，避免重复恢复。
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: `${base}/resume-ack`,
      handler: (req, res) => {
        if (denyNonLoopback(req, res)) return;
        if (req.method !== "POST") {
          respondJson2(res, 405, { error: "POST only" });
          return;
        }
        voiceResume = null;
        void import("node:fs/promises").then((fsp) => fsp.rm(voiceResumeFile(), { force: true })).catch(() => {
        });
        respondJson2(res, 200, { ok: true });
        console.log("[dsh-voice-mode] 语音已恢复，交接文件已清除");
      }
    })
  );
  // 本地补丁：诊断通道。客户端把语音链路上的关键事件发到这里，转写成一行日志，
  // 与下面的 asr final 落在同一个应用日志里，用来定位"说过的话整段丢失"。
  // 只写日志，不参与任何状态，也不改变行为。
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: `${base}/diag`,
      handler: (req, res) => {
        if (denyNonLoopback(req, res)) return;
        if (denyCrossOrigin(req, res)) return;
        if (req.method !== "POST") {
          respondJson2(res, 405, { error: "POST only" });
          return;
        }
        collectBody(req, res, MAX_JSON_BODY, (body) => {
          let events = [];
          try {
            const parsed = JSON.parse(body || "{}");
            events = Array.isArray(parsed.events) ? parsed.events : parsed.event ? [parsed] : [];
          } catch {
          }
          for (const item of events.slice(0, 32)) {
            if (!item || typeof item !== "object") continue;
            const event = String(item.event ?? "").slice(0, 64);
            if (!event) continue;
            const fields = item.fields && typeof item.fields === "object" ? item.fields : {};
            const trimmed = {};
            for (const [k, v] of Object.entries(fields)) {
              trimmed[k] = typeof v === "string" ? v.slice(0, 400) : v;
            }
            if (typeof item.seq === "number") trimmed.seq = item.seq;
            console.log(`[dsh-voice-mode] diag ${event} ${JSON.stringify(trimmed)}`);
          }
          respondJson2(res, 200, { ok: true });
        });
      }
    })
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: `${base}/preview`,
      handler: (req, res) => {
        if (denyNonLoopback(req, res)) return;
        if (denyCrossOrigin(req, res)) return;
        if (!limiter.hit(`preview:${req.socket.remoteAddress ?? "unknown"}`, 20, 6e4)) {
          res.statusCode = 429;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "rate limited" }));
          return;
        }
        if (!config.enabled) {
          respondJson2(res, 403, { error: "voice mode disabled" });
          return;
        }
        collectBody(req, res, MAX_JSON_BODY, async (body) => {
          let voice = "";
          let rate;
          try {
            const parsed = JSON.parse(body || "{}");
            voice = String(parsed.voice ?? "").trim();
            if (typeof parsed.rate === "number" && Number.isFinite(parsed.rate)) {
              rate = Math.min(2, Math.max(0.5, parsed.rate));
            }
          } catch {
          }
          if (voice.length > 128) {
            respondJson2(res, 400, { error: "voice too long" });
            return;
          }
          if (!voice) {
            respondJson2(res, 400, { error: "voice required" });
            return;
          }
          const sample = currentEngine() === "kokoro" ? "\u4F60\u597D\uFF0C\u6B22\u8FCE\u4F7F\u7528\u8BED\u97F3\u6A21\u5F0F\u3002Hello, welcome to voice mode." : currentEngine() === "vits" || voice.startsWith("zh-") ? "\u4F60\u597D\uFF0C\u6B22\u8FCE\u4F7F\u7528\u8BED\u97F3\u6A21\u5F0F\u3002" : "Hello, welcome to voice mode.";
          let buf;
          try {
            buf = await queue.synthesize(sample, { voice, rate });
          } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e);
            const category = classifyPreviewError(errMsg);
            const engineName = currentEngine();
            const engineStatus = queue.status();
            const sampleLen = sample.length;
            console.warn(
              `[dsh-voice-mode] preview synthesis failed: category=${category} engine=${engineName} engineReady=${engineStatus.ready} sampleLen=${sampleLen} attempt=1 voice=${voice} err=${errMsg}`
            );
            respondJson2(res, 502, { error: PREVIEW_ERROR_MESSAGES[category] });
            return;
          }
          res.writeHead(200, { "content-type": queue.mime, "cache-control": "no-store" });
          res.end(buf);
        });
      }
    })
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: `${base}/toggle`,
      handler: (req, res) => {
        if (denyNonLoopback(req, res)) return;
        if (denyCrossOrigin(req, res)) return;
        collectBody(req, res, MAX_JSON_BODY, async (body) => {
          let sessionId;
          let on;
          let tabId;
          try {
            const parsed = JSON.parse(body || "{}");
            sessionId = parsed.sessionId;
            on = parsed.on;
            tabId = typeof parsed.tabId === "string" && parsed.tabId.length <= 64 ? parsed.tabId : void 0;
          } catch {
          }
          if (!sessionId) {
            respondJson2(res, 400, { error: "sessionId required" });
            return;
          }
          if (on !== void 0 && typeof on !== "boolean") {
            respondJson2(res, 400, { error: "invalid on" });
            return;
          }
          if (!limiter.hit(`toggle:${sessionId}`, 2, 2e3)) {
            res.statusCode = 429;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "rate limited" }));
            return;
          }
          if (on === true) {
            if (!config.enabled) {
              respondJson2(res, 403, { error: "voice mode disabled" });
              return;
            }
            if (sessions && !sessions.get(sessionId)) {
              respondJson2(res, 403, { error: "unknown session" });
              return;
            }
            await asr.warmupSense();
            // 2026-10-15：本地 TTS 引擎第一次合成要现加载模型（约 8 秒），用户听到的就是
            // "开始读比 Edge 慢很多"。进入语音模式时先把它拉起来，这段等待就藏在开口之前。
            void queue.prepare().catch(() => {
            });
            asr.reset(sessionId);
            queue.cancel(sessionId);
            queue.updateVoice(vset.voice, unwrapVolatile2(vset.rate), unwrapVolatile2(vset.pauseScale));
            const previous = activeVoiceSession;
            activeVoiceSession = sessionId;
            activeTabId = tabId ?? null;
            if (ownerYieldTimer) {
              clearTimeout(ownerYieldTimer);
              ownerYieldTimer = null;
            }
            if (previous && previous !== sessionId) {
              queue.cancel(previous);
              asr.reset(previous);
              setTurn(previous, "idle");
              turnStates.delete(previous);
            }
            broadcast("mode", { active: activeVoiceSession, ownerTabId: activeTabId });
          } else {
            if (activeVoiceSession === sessionId) {
              activeVoiceSession = null;
              activeTabId = null;
              if (ownerYieldTimer) {
                clearTimeout(ownerYieldTimer);
                ownerYieldTimer = null;
              }
              queue.cancel(sessionId);
              asr.reset(sessionId);
              setTurn(sessionId, "idle");
              turnStates.delete(sessionId);
              broadcast("mode", { active: null, ownerTabId: null });
            }
          }
          respondJson2(res, 200, { active: activeVoiceSession });
        });
      }
    })
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: `${base}/models/status`,
      handler: (req, res) => {
        if (denyNonLoopback(req, res)) return;
        respondJson2(res, 200, { ...asr.modelStatus(), tts: queue.status() });
      }
    })
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: `${base}/models/retry`,
      handler: (req, res) => {
        if (denyNonLoopback(req, res)) return;
        if (!config.enabled) {
          respondJson2(res, 403, { error: "voice mode disabled" });
          return;
        }
        collectBody(req, res, MAX_JSON_BODY, (body) => {
          let kind = "asr";
          try {
            const p = JSON.parse(body || "{}");
            if (p.kind === void 0) {
            } else if (p.kind === "vad" || p.kind === "sense" || p.kind === "asr") {
              kind = p.kind;
            } else {
              respondJson2(res, 400, { error: "invalid kind" });
              return;
            }
          } catch {
            respondJson2(res, 400, { error: "invalid json" });
            return;
          }
          void asr.retryModel(kind).then((done) => {
            respondJson2(res, 200, { ok: done, kind });
          });
        });
      }
    })
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: `${base}/models/clean`,
      handler: (req, res) => {
        if (denyNonLoopback(req, res)) return;
        if (denyCrossOrigin(req, res)) return;
        if (!config.enabled) {
          respondJson2(res, 403, { error: "voice mode disabled" });
          return;
        }
        collectBody(req, res, MAX_JSON_BODY, (body) => {
          let engine = "vits";
          try {
            const p = JSON.parse(body || "{}");
            if (p.engine === "kokoro" || p.engine === "vits") engine = p.engine;
            else {
              respondJson2(res, 400, { error: "invalid engine" });
              return;
            }
          } catch {
            respondJson2(res, 400, { error: "invalid json" });
            return;
          }
          const dir = join4(config.cacheDir, engine === "kokoro" ? kokoroModelDir(vset.kokoroModel) : TTS_MODEL_REPO);
          void rm(dir, { recursive: true, force: true }).then(() => {
            if (engineKind === engine) {
              queue.setEngine(makeEngine(engine));
              queue.updateVoice(vset.voice, unwrapVolatile2(vset.rate), unwrapVolatile2(vset.pauseScale));
            }
            respondJson2(res, 200, { ok: true, engine });
          }).catch((e) => respondJson2(res, 500, { error: String(e) }));
        });
      }
    })
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: `${base}/models/download`,
      handler: (req, res) => {
        if (denyNonLoopback(req, res)) return;
        if (denyCrossOrigin(req, res)) return;
        if (!config.enabled) {
          respondJson2(res, 403, { error: "voice mode disabled" });
          return;
        }
        collectBody(req, res, MAX_JSON_BODY, (body) => {
          let engine = "vits";
          try {
            const p = JSON.parse(body || "{}");
            if (p.engine === "kokoro" || p.engine === "vits") engine = p.engine;
            else {
              respondJson2(res, 400, { error: "invalid engine" });
              return;
            }
          } catch {
            respondJson2(res, 400, { error: "invalid json" });
            return;
          }
          if (engineKind !== engine) {
            respondJson2(res, 400, { error: "engine not active" });
            return;
          }
          void queue.prepare().then(() => respondJson2(res, 200, { ok: true, engine })).catch((e) => {
            console.warn(`[dsh-voice-mode] model download failed: ${String(e)}`);
            respondJson2(res, 502, { error: "\u6A21\u578B\u4E0B\u8F7D\u5931\u8D25\uFF1A\u8BF7\u68C0\u67E5\u7F51\u7EDC" });
          });
        });
      }
    })
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: `${base}/voices`,
      handler: async (req, res) => {
        if (denyNonLoopback(req, res)) return;
        if (denyCrossOrigin(req, res)) return;
        try {
          const voices = await listEdgeVoices();
          respondJson2(res, 200, { voices });
        } catch (e) {
          respondJson2(res, 502, { error: String(e) });
        }
      }
    })
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: `${base}/asr`,
      handler: (req, res) => {
        if (denyNonLoopback(req, res)) return;
        let sid = "";
        try {
          const url = new URL(req.url ?? "/", "http://localhost");
          sid = url.searchParams.get("sessionId") ?? "";
        } catch {
        }
        if (!limiter.hit(`asr:${sid || "unknown"}`, 60, 1e3)) {
          respondJson2(res, 429, { error: "rate limited" });
          return;
        }
        if (sid && sid === activeVoiceSession) {
          try {
            const url = new URL(req.url ?? "/", "http://localhost");
            setTurn(sid, url.searchParams.get("final") === "1" ? "finalizing" : "listening");
          } catch {
          }
        }
        handleAsrRequest(asr, activeVoiceSession, req, res);
      }
    })
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: `${base}/cancel`,
      handler: (req, res) => {
        if (denyNonLoopback(req, res)) return;
        if (denyCrossOrigin(req, res)) return;
        collectBody(req, res, MAX_JSON_BODY, (body) => {
          let sessionId;
          let keepAsr = false;
          try {
            const parsed = JSON.parse(body || "{}");
            sessionId = parsed.sessionId;
            keepAsr = parsed.keepAsr === true;
          } catch {
          }
          if (sessionId && sessionId === activeVoiceSession) {
            if (!limiter.hit(`cancel:${sessionId}`, 2, 1e3)) {
              respondJson2(res, 429, { error: "rate limited" });
              return;
            }
            queue.cancel(sessionId);
            if (!keepAsr) asr.reset(sessionId);
          }
          respondJson2(res, 200, { ok: true });
        });
      }
    })
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: `${base}/mode`,
      handler: (req, res) => {
        if (denyNonLoopback(req, res)) return;
        if (denyCrossOrigin(req, res)) return;
        collectBody(req, res, MAX_JSON_BODY, (body) => {
          let mode;
          try {
            const parsed = JSON.parse(body || "{}");
            mode = parsed.mode === "toggle" || parsed.mode === "hold" ? parsed.mode : void 0;
          } catch {
          }
          if (!mode) {
            res.statusCode = 400;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "mode must be toggle or hold" }));
            return;
          }
          const persistMode = settingsScopeRef ? settingsScopeRef.update({ mode }) : ctx.settings.mutate ? ctx.settings.mutate(NS_VOICE_MODE, [{ op: "set", path: ["mode"], value: mode }]) : Promise.reject(new Error("mode persistence unsupported on this host"));
          void persistMode.then(() => {
            res.statusCode = 200;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ok: true, mode }));
          }).catch((e) => {
            console.warn(`[dsh-voice-mode] mode update failed: ${String(e)}`);
            res.statusCode = 500;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "mode update failed" }));
          });
        });
      }
    })
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: `${base}/stream`,
      handler: (req, res) => {
        if (denyNonLoopback(req, res)) return;
        if (sseClients.size >= 4) {
          respondJson2(res, 429, { error: "too many streams" });
          return;
        }
        let tabId = null;
        try {
          const u = new URL(req.url ?? "/", "http://localhost");
          tabId = u.searchParams.get("tabId");
        } catch {
        }
        if (tabId !== null && tabId.length > 64) tabId = null;
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive"
        });
        res.write("retry: 3000\n\n");
        const send = (event, payload) => {
          res.write(`event: ${event}
data: ${JSON.stringify(payload)}

`);
        };
        const client = { tabId, send };
        sseClients.add(client);
        if (tabId !== null) latestConnByTab.set(tabId, client);
        if (tabId !== null && tabId === activeTabId && ownerYieldTimer) {
          clearTimeout(ownerYieldTimer);
          ownerYieldTimer = null;
        }
        send("mode", { active: activeVoiceSession, ownerTabId: activeTabId });
        const heartbeat = setInterval(() => {
          try {
            res.write(": hb\n");
          } catch {
          }
        }, 25e3);
        let cleaned = false;
        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          clearInterval(heartbeat);
          sseClients.delete(client);
          if (tabId !== null && latestConnByTab.get(tabId) === client) {
            latestConnByTab.delete(tabId);
            if (tabId === activeTabId) {
              if (ownerYieldTimer) clearTimeout(ownerYieldTimer);
              ownerYieldTimer = setTimeout(() => yieldActiveSession(activeVoiceSession), 8e3);
            }
          }
        };
        req.on("close", cleanup);
        res.on("close", cleanup);
      }
    })
  );
}
var MAX_JSON_BODY = 16 * 1024;
function collectBody(req, res, maxBytes, onBody) {
  const chunks = [];
  let received = 0;
  let tooLarge = false;
  req.on("data", (c) => {
    if (tooLarge) return;
    received += c.length;
    if (received > maxBytes) {
      tooLarge = true;
      respondJson2(res, 413, { error: "request body too large" });
      return;
    }
    chunks.push(c);
  });
  req.on("end", () => {
    if (tooLarge) return;
    const body = Buffer.concat(chunks).toString("utf8");
    try {
      const r = onBody(body);
      if (r && typeof r.then === "function") r.catch(() => {
      });
    } catch {
    }
  });
  req.on("error", () => {
  });
}
async function* tapActiveStream(sessionId, inner, queue, broadcast, onTurn) {
  const segmenter = new SentenceSegmenter();
  let firstTokenBroadcast = false;
  let firstSentenceBroadcast = false;
  let flushed = false;
  let finishReason = null;
  const flushOnce = () => {
    if (flushed) return;
    flushed = true;
    for (const s of segmenter.flush()) {
      queue.enqueue(sessionId, s);
    }
  };
  try {
    for await (const chunk of inner) {
      if (chunk.type === "text-delta" && chunk.text) {
        if (!firstTokenBroadcast) {
          firstTokenBroadcast = true;
          broadcast("latency", { sessionId, stage: "first-llm-token" });
          onTurn("agent-speaking");
        }
        for (const s of segmenter.feed(chunk.text)) {
          if (!firstSentenceBroadcast) {
            firstSentenceBroadcast = true;
            broadcast("latency", { sessionId, stage: "first-sentence-text" });
          }
          queue.enqueue(sessionId, s);
        }
      }
      if (chunk.type === "tool-call-delta" && chunk.name) {
        broadcast("tool", { sessionId, name: chunk.name });
      }
      if (chunk.type === "finish") {
        finishReason = chunk.reason;
      }
      yield chunk;
    }
  } finally {
    const aborted = finishReason !== null && typeof finishReason === "object" && finishReason.kind === "aborted";
    if (!aborted) flushOnce();
    onTurn("listening");
  }
}
export {
  Config,
  VoiceSettingsSchema,
  apply,
  createVoiceSettingsSchema,
  inject,
  name
};
