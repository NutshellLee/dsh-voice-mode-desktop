// 语音输入纠错表：Aho–Corasick 一次扫描 + 逐条语境限定。
// 只服务语音输入——挂载点是 ASR 响应，打字与粘贴不经过这里。
// 词表默认在 ~/.dsh/voice-dict.json，可被 DSH_VOICE_DICT 覆盖；改动 1 秒内自动生效。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DICT_PATH = process.env.DSH_VOICE_DICT || path.join(os.homedir(), ".dsh", "voice-dict.json");

let entries = [];
let root = null;
let lastError = null;
let reloadTimer = null;

const isWordChar = (c) => c !== undefined && /[A-Za-z0-9_]/.test(c);
const isCJK = (c) => c !== undefined && /[\u3400-\u9fff\u3040-\u30ff]/.test(c);

// 取紧邻的"实义"字符（跳过空白、标点、符号，最多跨 4 个）：语音里 "这个 kill 能用吗"
// 与 "用AR。" 的邻居分别是空格和句号，直接看相邻字符会漏判。
const SKIP = /[\s\p{P}\p{S}]/u;
function neighbour(text, index, dir) {
  for (let i = index, n = 0; i >= 0 && i < text.length && n < 4; i += dir, n++) {
    const c = text[i];
    if (SKIP.test(c)) continue;
    return c;
  }
  return void 0;
}

function buildAC(list) {
  const r = { next: /* @__PURE__ */ new Map(), fail: null, out: [] };
  for (let i = 0; i < list.length; i++) {
    let node = r;
    for (const ch of list[i].from) {
      if (!node.next.has(ch)) node.next.set(ch, { next: /* @__PURE__ */ new Map(), fail: null, out: [] });
      node = node.next.get(ch);
    }
    node.out.push(i);
  }
  const queue = [];
  for (const child of r.next.values()) {
    child.fail = r;
    queue.push(child);
  }
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const [ch, child] of cur.next) {
      let f = cur.fail;
      while (f && f !== r && !f.next.has(ch)) f = f.fail;
      child.fail = f && f.next.has(ch) && f.next.get(ch) !== child ? f.next.get(ch) : r;
      if (child.fail !== r) child.out = child.out.concat(child.fail.out);
      queue.push(child);
    }
  }
  return r;
}

export function reload() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DICT_PATH, "utf8"));
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.entries) ? parsed.entries : [];
    const clean = list.filter((e) => e && typeof e.from === "string" && e.from.length > 0 && typeof e.to === "string");
    entries = clean;
    root = buildAC(clean);
    lastError = null;
    return clean.length;
  } catch (err) {
    // 文件缺失或损坏时保留上一次可用的表；绝不因为词表问题影响识别
    lastError = err && err.message ? err.message : String(err);
    if (!root) {
      entries = [];
      root = buildAC([]);
    }
    return entries.length;
  }
}

function matches(text) {
  if (!root || entries.length === 0 || !text) return [];
  const hits = [];
  let node = root;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    while (node !== root && !node.next.has(ch)) node = node.fail;
    node = node.next.has(ch) ? node.next.get(ch) : root;
    for (const idx of node.out) {
      hits.push({ start: i + 1 - entries[idx].from.length, end: i + 1, idx });
    }
  }
  if (hits.length === 0) return [];
  hits.sort((a, b) => a.start - b.start || b.end - a.end);

  const picked = [];
  let last = -1;
  for (const h of hits) {
    if (h.start < last) continue;
    const e = entries[h.idx];
    const before = text[h.start - 1];
    const after = text[h.end];
    if (e.boundary && (isWordChar(before) || isWordChar(after))) continue;
    if (e.cjk && !isCJK(neighbour(text, h.start - 1, -1)) && !isCJK(neighbour(text, h.end, 1))) continue;
    if (Array.isArray(e.notBefore) && e.notBefore.length > 0) {
      const win = text.slice(Math.max(0, h.start - 24), h.start);
      if (e.notBefore.some((s) => win.includes(s))) continue;
    }
    if (Array.isArray(e.notAfter) && e.notAfter.length > 0) {
      const win = text.slice(h.end, h.end + 24);
      if (e.notAfter.some((s) => win.includes(s))) continue;
    }
    picked.push(h);
    last = h.end;
  }
  return picked;
}

export function rewrite(text) {
  try {
    const picked = matches(text);
    if (picked.length === 0) return text;
    let out = "";
    let cur = 0;
    for (const h of picked) {
      out += text.slice(cur, h.start) + entries[h.idx].to;
      cur = h.end;
    }
    return out + text.slice(cur);
  } catch (err) {
    lastError = err && err.message ? err.message : String(err);
    return text;
  }
}

export const dictSize = () => entries.length;
export const dictError = () => lastError;

reload();
try {
  fs.watchFile(DICT_PATH, { interval: 1000 }, () => {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      reload();
    }, 200);
  });
} catch {
  /* 监听失败不影响纠错本身 */
}
