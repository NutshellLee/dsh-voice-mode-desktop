// Minimal Microsoft Edge read-aloud client.
//
// The plugin needs one thing from the cloud TTS side: send text, receive MP3.
// This module implements that exchange directly over a WebSocket, so the plugin
// carries no third-party TTS wrapper and installs cleanly everywhere.
//
// Protocol (edge read-aloud v1): connect with a trusted client token plus a
// SHA-256 `Sec-MS-GEC` ticket derived from the current five-minute window, send
// `speech.config` and an SSML frame, then collect `Path:audio` frames until
// `Path:turn.end`. The token and the ticket scheme follow the public Edge
// read-aloud protocol as implemented by msedge-tts (MIT).

import { execFileSync } from "node:child_process";
import WebSocket from "ws";
import { ProxyAgent } from "./proxy-agent.js";
import { generateSecMsGecV2 } from "./gec-v2.js";

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const SYNTH_URL = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const VOICES_URL = "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list";
// 2026-10-14：升到 v2。老版本号 1-… 配老票据，升级后两边都要换。
const GEC_VERSION = "2-143.0.3650.96";
const AUDIO_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
const AUDIO_DELIM = "Path:audio\r\n";
const DELIM = "\r\n\r\n";
const REQUEST_TIMEOUT_MS = 30_000;

const HANDSHAKE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
  Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold"
};

function randomHex(bytes) {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, (b) => b.toString(16).padStart(2, "0")).join("");
}

function connectionId() {
  return "xxxxxxxx-xxxx-xxxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 3) | 8).toString(16);
  });
}

/**
 * `Sec-MS-GEC`: 五分钟窗口的票据。
 *
 * 2026-10-14：微软把这个端点迁到了 v2 票据，老算法（时间戳 + token 直接 SHA-256）
 * 会被服务端拒掉。这里改成社区逆出来的 v2 算法，实现见 ./gec-v2.js。
 * 保留 async 是为了不动调用点的 `await`。
 */
async function secMsGec() {
  return generateSecMsGecV2(Date.now() / 1000, TRUSTED_CLIENT_TOKEN);
}

function escapeXml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// 代理：优先环境变量，其次 Windows 系统代理（即设置里的「代理服务器」）。
// 结果为 null 表示直连。设 NO_PROXY 可以强制直连。
let cachedProxy;
function systemProxyUrl() {
  if (cachedProxy !== undefined) return cachedProxy;
  cachedProxy = null;
  const env = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (env) {
    cachedProxy = normalizeProxy(env);
    return cachedProxy;
  }
  if (process.platform === "win32") {
    try {
      const out = execFileSync("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 4000
      });
      const enabled = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(out);
      const server = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(out);
      if (enabled && parseInt(enabled[1], 16) === 1 && server) cachedProxy = normalizeProxy(server[1]);
    } catch {
      cachedProxy = null;
    }
  }
  return cachedProxy;
}

function normalizeProxy(raw) {
  let value = String(raw ?? "").trim();
  if (!value) return null;
  if (value.includes("=")) {
    const parts = Object.fromEntries(value.split(";").filter(Boolean).map((item) => item.split("=")));
    value = parts.https || parts.http || Object.values(parts)[0] || "";
  }
  if (!value) return null;
  if (!/^[a-z]+:\/\//i.test(value)) value = "http://" + value;
  try {
    return new URL(value).toString();
  } catch {
    return null;
  }
}

function proxyBypassed(host) {
  const list = process.env.NO_PROXY || process.env.no_proxy;
  if (!list) return false;
  return list
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .some((item) => host.toLowerCase().endsWith(item));
}

function voiceLocaleOf(voice) {
  const match = /\w{2}-\w{2}/.exec(voice);
  return match === null ? "en-US" : match[0];
}

// The service drops the connection without audio when `<prosody>` carries no
// attributes, so all three are always emitted (defaults match the upstream
// template: pitch +0Hz, rate 1.0, volume 100.0).
function buildSsml(text, voice, rate) {
  const rateValue = Number.isFinite(rate) && rate > 0 ? rate : 1;
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${voiceLocaleOf(voice)}">` +
    `<voice name="${voice}"><prosody pitch="+0Hz" rate="${rateValue}" volume="100.0">${escapeXml(text)}</prosody></voice></speak>`;
}

/**
 * Synthesize one utterance to MP3.
 *
 * @param {string} text
 * @param {{ voice?: string, rate?: number }} [options]
 * @returns {Promise<Buffer>}
 */
export async function synthesize(text, options = {}) {
  const voice = options.voice ?? "zh-CN-XiaoxiaoNeural";
  const url = `${SYNTH_URL}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
    `&Sec-MS-GEC=${await secMsGec()}&Sec-MS-GEC-Version=${GEC_VERSION}&ConnectionId=${connectionId()}`;

  return await new Promise((resolve, reject) => {
    const wsOptions = { headers: HANDSHAKE_HEADERS };
    const proxy = proxyBypassed("speech.platform.bing.com") ? null : systemProxyUrl();
    if (proxy) wsOptions.agent = new ProxyAgent(proxy);
    const socket = new WebSocket(url, wsOptions);
    const chunks = [];
    let settled = false;

    const finish = (error, audio) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closing */ }
      if (error) reject(error);
      else resolve(audio);
    };

    const timer = setTimeout(() => finish(new Error("Edge TTS timed out")), REQUEST_TIMEOUT_MS);

    socket.on("open", () => {
      socket.send(`Content-Type:application/json; charset=utf-8\r\nPath:speech.config${DELIM}` +
        JSON.stringify({
          context: {
            synthesis: {
              audio: {
                metadataoptions: { sentenceBoundaryEnabled: "false", wordBoundaryEnabled: "false" },
                outputFormat: AUDIO_FORMAT
              }
            }
          }
        }));
      socket.send(`X-RequestId:${randomHex(16)}\r\nContent-Type:application/ssml+xml\r\nPath:ssml${DELIM}` +
        buildSsml(text, voice, options.rate));
    });

    socket.on("message", (data) => {
      const buffer = Buffer.from(data);
      if (buffer.includes("Path:turn.end")) {
        finish(undefined, Buffer.concat(chunks));
        return;
      }
      const index = buffer.indexOf(AUDIO_DELIM);
      if (index >= 0) chunks.push(buffer.subarray(index + AUDIO_DELIM.length));
    });

    // The service closes the socket right after `turn.end`; a close without any
    // audio is the only close that means failure.
    socket.on("close", () => {
      if (chunks.length === 0) finish(new Error("Edge TTS connection closed before any audio arrived"));
      else finish(undefined, Buffer.concat(chunks));
    });

    socket.on("error", (error) => finish(new Error(`Edge TTS socket error: ${error?.message ?? String(error)}`)));
  });
}

/** @returns {Promise<Array<{ ShortName: string, Locale: string, Gender: string, FriendlyName: string }>>} */
export async function listVoices() {
  const response = await fetch(`${VOICES_URL}?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${await secMsGec()}&Sec-MS-GEC-Version=${GEC_VERSION}`);
  if (!response.ok) throw new Error(`Edge voices request failed: HTTP ${response.status}`);
  const voices = await response.json();
  return voices.map((voice) => ({
    ShortName: voice.ShortName,
    Locale: voice.Locale,
    Gender: voice.Gender,
    FriendlyName: voice.FriendlyName
  }));
}
