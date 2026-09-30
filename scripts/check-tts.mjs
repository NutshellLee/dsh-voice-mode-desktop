// Checks the cloud read-aloud path end to end without starting DSH:
// synthesizes one short phrase and lists the available voices.
//
//   node scripts/check-tts.mjs

import { synthesize, listVoices } from "../lib/edge-tts.js";

const audio = await synthesize("这是一次朗读自检。", { voice: "zh-CN-XiaoxiaoNeural", rate: 1.1 });
if (audio.length === 0 || audio[0] !== 0xff) {
  console.error(`FAIL  合成返回的不是 MP3 数据（${audio.length} 字节）`);
  process.exit(1);
}
console.log(`PASS  合成 ${audio.length} 字节 MP3`);

const voices = await listVoices();
if (voices.length === 0) {
  console.error("FAIL  音色列表为空");
  process.exit(1);
}
console.log(`PASS  音色列表 ${voices.length} 个（示例 ${voices[0].ShortName}）`);
