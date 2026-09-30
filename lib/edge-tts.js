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

import WebSocket from "ws";

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const SYNTH_URL = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const VOICES_URL = "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list";
const GEC_VERSION = "1-143.0.3650.96";
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

/** `Sec-MS-GEC`: SHA-256 of the Windows file time rounded to five minutes plus the token. */
async function secMsGec() {
  const seconds = Math.floor(Date.now() / 1000) + 11644473600;
  const rounded = seconds - (seconds % 300);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${rounded * 10000000}${TRUSTED_CLIENT_TOKEN}`));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function escapeXml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function voiceLocaleOf(voice) {
  const match = /\w{2}-\w{2}/.exec(voice);
  return match === null ? "en-US" : match[0];
}

function buildSsml(text, voice, rate) {
  const prosody = Number.isFinite(rate) && rate > 0 && rate !== 1 ? ` rate="${rate}"` : "";
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${voiceLocaleOf(voice)}">` +
    `<voice name="${voice}"><prosody${prosody}>${escapeXml(text)}</prosody></voice></speak>`;
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
    const socket = new WebSocket(url, { headers: HANDSHAKE_HEADERS });
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
