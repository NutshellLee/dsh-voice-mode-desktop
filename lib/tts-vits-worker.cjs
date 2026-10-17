"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/tts-vits-worker.ts
var import_sherpa_onnx = __toESM(require("sherpa-onnx"), 1);
var import_sherpa_onnx_node = __toESM(require("sherpa-onnx-node"), 1);

// src/segmenter.ts
function sanitizeForTts(text) {
  return String(text).replace(/[*_#|^=+~`]/g, " ").replace(/\s{2,}/g, " ").replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, "$1").trim();
}

// src/tts-vits-worker.ts
var { createOfflineTts } = import_sherpa_onnx.default;
var { OfflineTts, GenerationConfig } = import_sherpa_onnx_node.default;
var send = (msg) => {
  if (typeof process.send === "function") process.send(msg);
};
var wasmTts = null;
var nativeTts = null;
var initKind = "vits";
var initPaths = {};
function createEngine() {
  if (initKind === "kokoro") {
    nativeTts = new OfflineTts({
      model: {
        kokoro: {
          model: initPaths.model,
          voices: initPaths.voices,
          tokens: initPaths.tokens,
          dataDir: initPaths.dataDir,
          lexicon: initPaths.lexicon
        },
        // 2 线程：留核给主进程的 ASR 解码（4 线程满核会饿死识别，
        // 打断后定稿等待分钟级；2 线程 RTF≈1 仍实时）。
        numThreads: 2,
        debug: 0,
        provider: "cpu"
      },
      // 中文数字/日期/电话规范化（与 VITS 同源 FST）：阿拉伯数字按中文读。
      ruleFsts: [initPaths.date, initPaths.phone, initPaths.number].filter(Boolean).join(","),
      maxNumSentences: 1
    });
    return;
  }
  // 2026-10-14 补丁：piper 模型走 espeak 音素化——给的是 dataDir，不给 lexicon。
  // 注意别把 undefined 塞进配置：wasm 那边会报
  // "null function or function signature mismatch"，只在有值时才带上。
  const vitsModel = { model: initPaths.model, tokens: initPaths.tokens };
  if (initPaths.lexicon) vitsModel.lexicon = initPaths.lexicon;
  if (initPaths.dataDir) vitsModel.dataDir = initPaths.dataDir;
  // 2026-10-14：VITS 优先走原生 addon（原来只有 wasm）。
  // 同一个模型、同一句话（3.2 秒中文）实测：
  //   wasm 单线程 RTF 1.0~1.5 ／ 原生 1 线程 0.45、2 线程 0.25、4 线程 0.14。
  // 原生在 Electron 里加载不了，所以子进程要用 DSH_VOICE_TTS_NODE 指定的 node.exe；
  // 没设或者加载失败就退回 wasm，慢但能用。
  // 线程数取 2：跟 kokoro 一个道理——把核留给并发的 ASR，4 线程会把识别饿死。
  try {
    nativeTts = new OfflineTts({
      model: {
        vits: { ...vitsModel },
        numThreads: 2,
        debug: 0,
        provider: "cpu"
      },
      ruleFsts: [initPaths.date, initPaths.phone, initPaths.number].filter(Boolean).join(","),
      maxNumSentences: 1
    });
    nativeTts.generate({ text: "预热。", sid: 0, speed: 1 });
    return;
  } catch (e) {
    nativeTts = null;
  }
  wasmTts = createOfflineTts({
    model: {
      vits: vitsModel,
      numThreads: 1,
      debug: 0,
      provider: "cpu"
    },
    ruleFsts: [initPaths.date, initPaths.phone, initPaths.number].filter(Boolean).join(","),
    ruleFars: "",
    maxNumSentences: 1
  });
}
function reply(id, payload) {
  send({ id: typeof id === "number" ? id : 0, ...payload });
}
process.on("message", (msg) => {
  try {
    if (msg.type === "init") {
      initKind = msg.kind === "kokoro" ? "kokoro" : "vits";
      initPaths = msg.paths;
      createEngine();
      reply(msg.id, { ok: true });
      return;
    }
    if (msg.type === "synth") {
      const text = sanitizeForTts(
        String(msg.text ?? "").replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu, " ").replace(/(\d)[.．]\s*/g, "$1\u3001")
      );
      if (!text.trim()) {
        const sr = 24e3;
        reply(msg.id, {
          ok: true,
          sampleRate: sr,
          samples: Buffer.alloc(Math.floor(sr * 0.2) * 4).toString("base64")
        });
        return;
      }
      const sid = Number(msg.sid ?? 0);
      const speed = Number(msg.speed ?? 1);
      let audio;
      if (initKind === "kokoro") {
        if (!nativeTts) {
          reply(msg.id, { ok: false, error: "tts child not initialized" });
          return;
        }
        const gc = new GenerationConfig({ sid, speed, silenceScale: 0.2 });
        audio = nativeTts.generate({ text, generationConfig: gc });
      } else if (nativeTts) {
        audio = nativeTts.generate({ text, sid, speed });
      } else {
        if (!wasmTts) {
          reply(msg.id, { ok: false, error: "tts child not initialized" });
          return;
        }
        audio = wasmTts.generate({ text, sid, speed });
      }
      const buf = Buffer.from(audio.samples.buffer, audio.samples.byteOffset, audio.samples.byteLength);
      reply(msg.id, { ok: true, sampleRate: audio.sampleRate, samples: buf.toString("base64") });
      return;
    }
    if (msg.type === "close") {
      try {
        wasmTts?.free();
      } catch {
      }
      try {
        nativeTts?.free();
      } catch {
      }
      wasmTts = null;
      nativeTts = null;
      reply(msg.id, { ok: true });
      return;
    }
    reply(msg.id, { ok: false, error: `unknown message type: ${String(msg.type)}` });
  } catch (e) {
    reply(typeof msg?.id === "number" ? msg.id : 0, { ok: false, error: String(e) });
  }
});
