// Checks the cloud read-aloud path end to end without starting DSH.
//
//   node scripts/check-tts.mjs
//
// Covers the default rate as well as a modified one: an SSML request without
// prosody attributes is dropped by the service, which is exactly the case a
// user hits before ever touching the settings page.

import { synthesize, listVoices } from "../lib/edge-tts.js";

const cases = [
  ["默认语速（不传 rate）", {}],
  ["rate = 1", { rate: 1 }],
  ["rate = 1.6", { rate: 1.6 }]
];

let failed = 0;
for (const [label, options] of cases) {
  try {
    const audio = await synthesize("这是一次朗读自检。", { voice: "zh-CN-XiaoxiaoNeural", ...options });
    const ok = audio.length > 0 && audio[0] === 0xff;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}：${audio.length} 字节`);
    if (!ok) failed += 1;
  } catch (error) {
    console.log(`FAIL  ${label}：${error.message}`);
    failed += 1;
  }
}

try {
  const voices = await listVoices();
  console.log(`${voices.length > 0 ? "PASS" : "FAIL"}  音色列表 ${voices.length} 个（示例 ${voices[0]?.ShortName ?? "-"}）`);
  if (voices.length === 0) failed += 1;
} catch (error) {
  console.log(`FAIL  音色列表：${error.message}`);
  failed += 1;
}

process.exit(failed === 0 ? 0 : 1);
