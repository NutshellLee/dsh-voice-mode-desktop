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
          if (data.sherpaModule === "sherpa-onnx-node") {
            const mod = await import("sherpa-onnx-node");
            sherpa = mod.default ?? mod;
          } else {
            sherpa = await import(data.sherpaModule);
          }
        }
        if (!recognizer) {
          if (data.engine === "nano-cpu") {
            // 2026-10-18：第 2 层——Fun-ASR-Nano 的 int8 跑 CPU。注意这里用的是原生包
            // sherpa-onnx-node：插件默认那个 sherpa-onnx 是 WASM 版，建 funasrNano 会抛错。
            recognizer = new sherpa.OfflineRecognizer({
              featConfig: { sampleRate: 16e3, featureDim: 80 },
              modelConfig: {
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
              }
            });
          } else {
            recognizer = sherpa.createOfflineRecognizer({
              featConfig: { sampleRate: 16e3, featureDim: 80 },
              modelConfig: {
                senseVoice: {
                  model: data.modelDir + "/model.int8.onnx",
                  language: data.language,
                  useInverseTextNormalization: data.useITN
                },
                tokens: data.modelDir + "/tokens.txt",
                provider: "cpu",
                debug: 0
              }
            });
          }
        }
        if (msg.op === "decode" && msg.samples) {
          const stream = recognizer.createStream();
          try {
            // 2026-10-18：两种包的喂音频签名不同：WASM 版是 (rate, samples)，原生版是 {samples, sampleRate}
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
export {
  createSenseWorkerClient,
  startSenseWorker
};
