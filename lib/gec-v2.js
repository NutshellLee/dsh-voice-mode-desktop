// Sec-MS-GEC v2 令牌（2026-10-14 补丁）。
// 微软把 Edge 朗读端点迁到 v2 令牌后，老的纯 SHA-256 票据会被直接拒绝（握手 403）。
// 出处：rany2/edge-tts 7.3.0（PR #492，2026-10-13）。
// 变化点：令牌从「纯 64 位十六进制」变成「16 位 CS64 - 64 位 SHA256」，
// 算法本体是一个换过常量的 SHA-256 加一个自制的 CS64 校验和。
// 逐行对照移植，并用上游 Python 的同一时间戳输出做过一致性验证。
const U32 = 0xFFFFFFFFn;
const WIN_EPOCH = 11644473600;
const S_TO_NS = 1e9;

const _SHA256_INITIAL = [0x6A09E667n, 0xBB67AE85n, 0x3C6EF372n, 0xA54FF53An, 0x510E527Fn, 0x9B05688Cn, 0x1F83D9ABn, 0x5BE0CD19n];
const _SHA256_STATE = [0xFD9FBEA2n, 0x91243CE7n, 0xBE499094n, 0xCD2E1E0An, 0x6C006F49n, 0x4BD35ABn, 0xFEB0A7E4n, 0x3EFFBD2n];
const _SHA256_SCHEDULE = [0xEB24BF9En, 0x1558691Fn, 0xA0C09EE2n, 0xCFA32BAn, 0xA622EE8Cn, 0xD1DD9491n, 0xC0DD25A0n, 0xF9E70AB6n, 0xF0C31573n, 0x7058CE4En, 0x7188E606n, 0xE5AB33n, 0xD258B060n, 0x72766564n];
const _SHA256_ROUND_CONSTANTS = [0x428A2F98n, 0x71374491n, 0xB5C0FBCFn, 0xE9B5DBA5n, 0x3956C25Bn, 0x59F111F1n, 0x923F82A4n, 0xAB1C5ED5n, 0xD807AA98n, 0x12835B01n, 0x243185BEn, 0x550C7DC3n, 0x72BE5D74n, 0x80DEB1FEn, 0x9BDC06A7n, 0xC19BF174n, 0xE49B69C1n, 0xEFBE4786n, 0xFC19DC6n, 0x240CA1CCn, 0x2DE92C6Fn, 0x4A7484AAn, 0x5CB0A9DCn, 0x76F988DAn, 0x983E5152n, 0xA831C66Dn, 0xB00327C8n, 0xBF597FC7n, 0xC6E00BF3n, 0xD5A79147n, 0x6CA6351n, 0x14292967n, 0x27B70A85n, 0x2E1B2138n, 0x4D2C6DFCn, 0x53380D13n, 0x650A7354n, 0x766A0ABBn, 0x81C2C92En, 0x92722C85n, 0xA2BFE8A1n, 0xA81A664Bn, 0xC24B8B70n, 0xC76C51A3n, 0xD192E819n, 0xD6990624n, 0xF40E3585n, 0x106AA070n, 0x19A4C116n, 0x1E376C08n, 0x2748774Cn, 0x34B0BCB5n, 0x391C0CB3n, 0x4ED8AA4An, 0x5B9CCA4Fn, 0x682E6FF3n, 0x748F82EEn, 0x78A5636Fn, 0x84C87814n, 0x8CC70208n, 0x90BEFFFAn, 0xA4506CEBn, 0xBEF9A3F7n, 0xC67178F2n];
const _SHA256_ADJUSTMENT = 0xC9DC06A7n;
const _SHA256_BLOCK_CONSTANTS = [0x428A2F98n, 0x71374491n, 0xB5C0FBCFn, 0xE9B5DBA5n, 0x3956C25Bn, 0x59F111F1n, 0x923F82A4n, 0xAB1C5ED5n, 0xD807AA98n, 0x12835B01n, 0x243185BEn, 0x550C7DC3n, 0x72BE5D74n, 0x80DEB1FEn, 0xC9DC06A7n, 0xC19BF174n, 0xE49B69C1n, 0xEFBE4786n, 0xFC19DC6n, 0x240CA1CCn, 0x2DE92C6Fn, 0x4A7484AAn, 0x5CB0A9DCn, 0x76F988DAn, 0x983E5152n, 0xA831C66Dn, 0xB00327C8n, 0xBF597FC7n, 0xC6E00BF3n, 0xD5A79147n, 0x6CA6351n, 0x14292967n, 0x27B70A85n, 0x2E1B2138n, 0x4D2C6DFCn, 0x53380D13n, 0x650A7354n, 0x766A0ABBn, 0x81C2C92En, 0x92722C85n, 0xA2BFE8A1n, 0xA81A664Bn, 0xC24B8B70n, 0xC76C51A3n, 0xD192E819n, 0xD6990624n, 0xF40E3585n, 0x106AA070n, 0x19A4C116n, 0x1E376C08n, 0x2748774Cn, 0x34B0BCB5n, 0x391C0CB3n, 0x4ED8AA4An, 0x5B9CCA4Fn, 0x682E6FF3n, 0x748F82EEn, 0x78A5636Fn, 0x84C87814n, 0x8CC70208n, 0x90BEFFFAn, 0xA4506CEBn, 0xBEF9A3F7n, 0xC67178F2n];
const _SHA256_SIGMA0_ADJUSTMENT = 0x59C0B80n;
const _SHA256_SIGMA1_ADJUSTMENT = 0xB92C0n;
const _CS64_COEFFICIENTS = [
  [0xE82E91B1n, 0xB32700D0n], [0x44DE24C6n, 0x88DFF51Dn], [0x3BEB65BCn, 0x29514038n], [0xC89C5933n, 0xB328CBDFn], [0x8D1EC211n, 0xD405B4D5n], [0x314EF5D5n, 0x26E55F3Cn], [0xE92491B1n, 0x607801C6n], [0xF0A5B9D5n, 0x82B2C1FBn], [0x6064CF3n, 0xFA51A3DAn], [0xDA79FA60n, 0x207CC464n], [0xBED20560n, 0x3C3C74F3n], [0x89F9C9F8n, 0xD2D14B61n], [0x35FA38C6n, 0xBB04A2C1n], [0xCB49E3C6n, 0xC5626167n],
];
const _CS64_FACTOR = 0x82893933n;
const _CS64_ADJUSTMENT0 = 0xF2F90B1An;
const _CS64_ADJUSTMENT1 = 0xB1A0000n;

function _rol16(v) { v &= U32; return ((v << 16n) | (v >> 16n)) & U32; }
function _rotr(v, n) { const b = BigInt(n); return ((v >> b) | (v << (32n - b))) & U32; }
function _sigma0(v) { return (_rotr(v, 7) ^ _rotr(v, 18) ^ (v >> 3n)) & U32; }
function _sigma1(v) { return (_rotr(v, 17) ^ _rotr(v, 19) ^ (v >> 10n)) & U32; }

function _wordsLe4Even(data) {
  const pad = (4 - (data.length % 4)) % 4;
  const buf = pad ? Buffer.concat([data, Buffer.alloc(pad)]) : data;
  const words = [];
  for (let i = 0; i < buf.length; i += 4) words.push(BigInt(buf.readUInt32LE(i)));
  if (words.length % 2) words.push(0n);
  return words;
}

function _expandSchedule(words, firstWord) {
  for (let i = firstWord; i < 64; i++) {
    const x = words[i - 2], y = words[i - 15];
    words.push((_sigma1(x) + words[i - 7] + _sigma0(y) + words[i - 16]) & U32);
  }
}

function _sha256Rounds(state, words, firstRound) {
  let [a, b, c, d, e, f, g, h] = state;
  const K = firstRound === 14 ? _SHA256_BLOCK_CONSTANTS : _SHA256_ROUND_CONSTANTS;
  for (let i = firstRound; i < 64; i++) {
    const S1 = _rotr(e, 6) ^ _rotr(e, 11) ^ _rotr(e, 25);
    const ch = g ^ (e & (f ^ g));
    const t1 = (h + S1 + ch + K[i] + words[i]) & U32;
    const S0 = _rotr(a, 2) ^ _rotr(a, 13) ^ _rotr(a, 22);
    const maj = (a & b) | (c & (a | b));
    const t2 = (S0 + maj) & U32;
    h = g; g = f; f = e; e = (d + t1) & U32;
    d = c; c = b; b = a; a = (t1 + t2) & U32;
  }
  return [a, b, c, d, e, f, g, h];
}

function _sha256Init(data) {
  const words = new Array(14).fill(0n);
  words.push(BigInt(data.readUIntBE(0, 3)));
  words.push(BigInt(data.readUIntBE(3, 4)));
  for (let index = 16; index < 30; index++) {
    let value = _SHA256_SCHEDULE[index - 16];
    if (index - 2 >= 14) {
      value += index === 16 ? (_sigma1(words[index - 2]) ^ _SHA256_SIGMA1_ADJUSTMENT) : _sigma1(words[index - 2]);
    }
    if (index - 7 >= 14) value += words[index - 7];
    if (index - 15 >= 14) {
      value += index === 29 ? (_sigma0(words[index - 15]) ^ _SHA256_SIGMA0_ADJUSTMENT) : _sigma0(words[index - 15]);
    }
    words.push(value & U32);
  }
  words.push((_sigma1(words[28]) + words[23] + _sigma0(words[15]) + words[14] + _SHA256_ADJUSTMENT - _SHA256_ROUND_CONSTANTS[14]) & U32);
  _expandSchedule(words, 31);
  const working = _sha256Rounds(_SHA256_STATE, words, 14);
  return _SHA256_INITIAL.map((v, i) => (v + working[i]) & U32);
}

function _sha256Digest(data) {
  if (data.length < 7) throw new Error("Token salt must contain at least seven bytes");
  const length = 57 + data.length;
  const padLen = ((55 - length) % 64 + 64) % 64;
  const tail = Buffer.alloc(8);
  tail.writeBigUInt64BE(BigInt(length) * 8n);
  const padded = Buffer.concat([data.subarray(7), Buffer.from([0x80]), Buffer.alloc(padLen), tail]);
  let state = _sha256Init(Buffer.from(data.subarray(0, 7)));
  for (let offset = 0; offset < padded.length; offset += 64) {
    const words = [];
    for (let i = 0; i < 16; i++) words.push(BigInt(padded.readUInt32BE(offset + i * 4)));
    _expandSchedule(words, 16);
    const working = _sha256Rounds(state, words, 0);
    state = state.map((v, i) => (v + working[i]) & U32);
  }
  const out = Buffer.alloc(32);
  state.forEach((v, i) => out.writeUInt32BE(Number(v), i * 4));
  return out;
}

function _cs64Digest(data, digest) {
  const keyA = BigInt(digest.readUInt32LE(0)) | 1n;
  const keyB = BigInt(digest.readUInt32LE(4)) | 1n;
  const factors = [(keyA * _CS64_FACTOR) & U32, (keyB * _CS64_FACTOR) & U32];
  const terms = _CS64_COEFFICIENTS.map(([coefficient], index) => (coefficient * factors[index % 2]) & U32);
  const offsets = _CS64_COEFFICIENTS.map(([, offset]) => offset);
  _wordsLe4Even(Buffer.concat([Buffer.from([0]), data])).forEach((word, index) => {
    let term = word * (index % 2 === 0 ? keyA : keyB);
    let offset = _rol16(word) * (index % 2 === 0 ? 0xEF0569FBn : 0xC31713DBn);
    if (index === 0) {
      term += _CS64_ADJUSTMENT0 * factors[0];
      offset += _CS64_ADJUSTMENT1;
    }
    terms.push(term & U32);
    offsets.push(offset & U32);
  });
  let swapAcc = 0n, swapLast = 0n, state = 0n, acc = 0n;
  for (let index = 0; index < terms.length; index += 2) {
    const x = terms[index], y = terms[index + 1];
    let t = _rol16((offsets[index] + x) & U32);
    let q = (t * 0x76F50F34n) & U32;
    swapAcc = (swapAcc + ((_rol16(q) * 0xC3EFEA97n + q) & U32)) & U32;
    t = _rol16((offsets[index + 1] + y) & U32);
    q = (t * 0x1881CE3Cn) & U32;
    swapLast = (_rol16(q) * 0x35BD1EC9n + q) & U32;
    swapAcc = (swapAcc + swapLast) & U32;

    state = (state * keyA + x) & U32;
    state = (_rol16(state) * 0xCF98B111n) & U32;
    state = (_rol16(state) * 0x87085B9Fn) & U32;
    state = (_rol16(state) * 0x12CEB96Dn) & U32;
    state = (_rol16(state) * 0x257E1D83n) & U32;
    acc = (acc + state) & U32;
    t = (state * keyB + y) & U32;
    t = (_rol16(t) * 0xA27416F5n) & U32;
    t = (_rol16(t) * 0xD38396FFn) & U32;
    state = (_rol16((_rol16(t) * 0x7C932B89n) & U32) * 0xBFA49F69n) & U32;
    acc = (acc + state) & U32;
  }
  return [swapLast ^ state, swapAcc ^ acc];
}

function _tokenHash(data) {
  const digest = _sha256Digest(data);
  const [a, b] = _cs64Digest(data, digest);
  const buf = Buffer.alloc(8);
  buf.writeUInt32LE(Number(a), 0);
  buf.writeUInt32LE(Number(b), 4);
  return [buf.toString("hex").toUpperCase(), digest.toString("hex").toUpperCase()];
}

function generateSecMsGecV2(unixTimestamp, trustedClientToken) {
  let ticks = (unixTimestamp === undefined || unixTimestamp === null) ? Date.now() / 1000 : Number(unixTimestamp);
  ticks += WIN_EPOCH;
  ticks -= ticks % 300;
  ticks *= S_TO_NS / 100;
  const strToHash = ticks.toFixed(0) + trustedClientToken;
  const [cs64, sha] = _tokenHash(Buffer.from(strToHash, "ascii"));
  return cs64 + "-" + sha;
}

export { generateSecMsGecV2 };
