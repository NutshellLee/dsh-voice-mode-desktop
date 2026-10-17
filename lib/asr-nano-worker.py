#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Fun-ASR-Nano 的常驻识别 worker（第 1 层：显卡 + bf16 + torch）。

形态跟 tts-zipvoice-worker.py 一致：常驻进程，stdin 收 JSON 行、stdout 回 JSON 行。
请求： {"id":N,"samples":"<base64 float32>","sampleRate":16000,"keywords":["DSH",...]}
回应： {"id":N,"ok":true,"text":"..."} 或 {"id":N,"ok":false,"error":"..."}
启动： 就绪后先发 {"ready":true,"tier":"nano-gpu","loadMs":...}；
       显卡不可用则发 {"ready":false,"reason":"cuda_unavailable"} 后退出，交给上层降级。

2026-10-17：新建。对应文档《ASR优化与预热方案》第十一节/第十三节的三层阶梯。
"""
import argparse
import base64
import io
import json
import os
import sys
import time

import numpy as np

# 2026-10-17 修：跟 tts-zipvoice-worker.py 同一个坑——Windows 上 Python 的 stdin/stdout
# 默认按系统编码（cp936）走，而插件那边收发的是 UTF-8。中文会被解成乱码，
# 表现就是识别出来的字全是方块。必须放在最前面，所有读写都走 UTF-8。
for _stream in (sys.stdin, sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-dir", required=True, help="Fun-ASR-Nano 的 HF 权重目录")
    ap.add_argument("--device", default="cuda:0")
    ap.add_argument("--dtype", default="bfloat16", choices=["bfloat16", "float32"])
    ap.add_argument("--max-new-tokens", type=int, default=200)
    ap.add_argument("--keywords", default="", help="热词，逗号分隔（留空表示不用热词）")
    ap.add_argument("--warmup", type=int, default=1, help="启动后是否跑一次预热（0/1）")
    args = ap.parse_args()

    t0 = time.time()
    try:
        import torch
        from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor
    except Exception as e:
        send({"ready": False, "reason": "import_failed", "error": str(e)[:200]})
        return 1
    if not torch.cuda.is_available():
        send({"ready": False, "reason": "cuda_unavailable"})
        return 1

    dtype = torch.bfloat16 if args.dtype == "bfloat16" else torch.float32
    try:
        proc = AutoProcessor.from_pretrained(args.model_dir, local_files_only=True)
        model = AutoModelForSpeechSeq2Seq.from_pretrained(
            args.model_dir, local_files_only=True, dtype=dtype,
            low_cpu_mem_usage=True, device_map=args.device)
        model.eval()
    except Exception as e:
        send({"ready": False, "reason": "load_failed", "error": str(e)[:200]})
        return 1

    kw = [w for w in (args.keywords or "").split(",") if w.strip()]
    kw = kw or None

    def transcribe(samples, sample_rate):
        audio = np.asarray(samples, dtype=np.float32)
        if sample_rate != 16000:
            import librosa
            audio = librosa.resample(audio, orig_sr=sample_rate, target_sr=16000)
        inp = proc.apply_transcription_request(audio=audio, keywords=kw, language="中文")
        inp = inp.to(model.device)
        with torch.inference_mode():
            out = model.generate(**inp, max_new_tokens=args.max_new_tokens)
        return proc.decode(out[0][inp.input_ids.shape[1]:], skip_special_tokens=True).strip()

    if args.warmup:
        try:
            transcribe(np.zeros(8000, dtype=np.float32), 16000)
        except Exception:
            pass

    send({"ready": True, "tier": "nano-gpu", "dtype": args.dtype,
          "keywords": len(kw or []), "loadMs": int((time.time() - t0) * 1000)})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            continue
        if msg.get("type") == "close":
            break
        mid = msg.get("id", 0)
        try:
            raw = base64.b64decode(msg["samples"])
            samples = np.frombuffer(raw, dtype=np.float32)
            text = transcribe(samples, int(msg.get("sampleRate") or 16000))
            send({"id": mid, "ok": True, "text": text})
        except Exception as e:
            send({"id": mid, "ok": False, "error": str(e)[:300]})
    return 0


if __name__ == "__main__":
    sys.exit(main())
