# -*- coding: utf-8 -*-
"""ZipVoice 子进程。

插件用 stdin/stdout 的 JSON 行跟它说话：进程启动时把模型加载一次常驻，
之后每来一行合成请求，回一行 WAV 采样（base64 的 float32）。

为什么是独立进程：ZipVoice 是 PyTorch 的，跟插件不在同一个运行时里。
跟原来那个 sherpa 的 TTS 子进程是同一个思路。
"""
import argparse
import random
import base64
import glob
import json
import os
import sys
import tempfile
import traceback

# 2026-10-15：显存碎片是这几轮崩溃的嫌疑之一。expandable_segments 让分配器按需扩段，
# 减少反复申请/释放留下的碎片。必须在 import torch 之前设置才生效。
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

# 2026-10-15 修：Windows 上 Python 的 stdin 默认按系统编码（cp936）解码，而插件那边
# 送进来的是 UTF-8。中文文本会被解成乱码 —— 模型于是"假装在说话"、发音全错。
# 这一行必须放在最前面，所有读写都走 UTF-8。
for _stream in (sys.stdin, sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _error_log_paths():
    """出错日志的落点：先环境变量，再 %LOCALAPPDATA%\\dsh-voice-mode\\logs，最后临时目录。"""
    out = []
    env = os.environ.get("DSH_VOICE_TTS_ERROR_LOG")
    if env:
        out.append(env)
    base = os.environ.get("LOCALAPPDATA")
    if base:
        out.append(os.path.join(base, "dsh-voice-mode", "logs", "tts-zipvoice-errors.log"))
    out.append(os.path.join(tempfile.gettempdir(), "tts-zipvoice-errors.log"))
    return out


def log_error(mid, raw_text, spoken_text):
    """2026-10-16：偶发 `integer division or modulo by zero` 之前只回了一行异常文本，
    查不到是哪一句、也查不到行号。现在出错时把原始文本、归一化后的文本和完整
    调用栈写到本机日志（best-effort：写日志本身绝不再抛，免得盖掉原始错误）。"""
    import datetime as _dt
    tb = traceback.format_exc()
    blob = "\n".join([
        "=" * 60,
        "[%s] id=%s" % (_dt.datetime.now().isoformat(timespec="seconds"), mid),
        "raw   : %r" % (raw_text,),
        "spoken: %r" % (spoken_text,),
        tb,
    ]) + "\n"
    for path in _error_log_paths():
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "a", encoding="utf-8") as f:
                f.write(blob)
            break
        except Exception:
            continue
    try:
        sys.stderr.write("[tts-zipvoice] synth failed id=%s\n%s" % (mid, tb))
    except Exception:
        pass


def _wsola(y, factor, sr, frame_ms=40.0, tol_ms=12.0):
    """时域时长压缩（WSOLA）：不改相位，只在波形里找最像的接缝再拼。

    2026-10-15：原来用 librosa 的相位声码器，用户听出"发虚、发重音"——那是相位改动
    带来的老毛病。改成时域拼接之后他认可了（原话"Z3 还不错"），而且快得多：
    一句 0.02 秒，相位声码器要 2 秒。
    """
    import numpy as _np
    N = int(round(sr * frame_ms / 1000.0))
    Hs = N // 2
    Ha = int(round(Hs * factor))      # 提速 factor 倍 => 每帧多消耗输入，输出就更短
    tol = int(round(sr * tol_ms / 1000.0))
    y = _np.asarray(y, dtype=_np.float64)
    pad = N + tol
    x = _np.concatenate([_np.zeros(pad), y, _np.zeros(2 * N + tol)])
    n_out = int(len(y) / factor) + 4 * N
    out = _np.zeros(n_out)
    wsum = _np.zeros(n_out)
    win = _np.hanning(N)
    target = pad
    o = 0
    prev = None
    while target + N + tol < len(x) and o + N < n_out:
        if prev is None:
            off = target
        else:
            lo = max(0, target - tol)
            hi = min(len(x) - N - Hs, target + tol)
            best = lo
            bestc = -1e18
            for cand in range(lo, hi + 1, 2):
                c = float(_np.dot(x[cand:cand + Hs], prev))
                if c > bestc:
                    bestc = c
                    best = cand
            off = best
        out[o:o + N] += x[off:off + N] * win
        wsum[o:o + N] += win
        prev = x[off + Hs:off + Hs + Hs]
        o += Hs
        target += Ha
    m = wsum > 1e-6
    out[m] /= wsum[m]
    return _np.asarray(out[:o], dtype=_np.float32)


def _time_stretch(y, factor, sr):
    """时长压缩（保持音高）。失败就原样返回，宁可不提速也不能把音频弄坏。"""
    try:
        return _wsola(y, factor, sr)
    except Exception as e:  # noqa: BLE001
        sys.stderr.write("时长压缩失败，按原速返回：%s\n" % e)
        return y


MODEL_SPEED_MAX = 1.3
QUALITY_SPEED_MAX = 2.0


# 2026-10-15：只补模型自带转换没做对的「固定形状」，其余一律不动。
#   · 版本号      0.1.6       -> 零点一点六
#   · 日期        2026-10-15  -> 二零二六年十月十五号（点分写法同样处理）
#   · 时间        05:00       -> 五点；12:30 -> 十二点三十
#   · 时分秒      12:30:45    -> 十二点三十四分四十五秒
#   · 比分        3:1         -> 三比一（右边只有一位，时间不会这么写）
#   · 年份带空格  2026 年     -> 二零二六年
#   · 波浪号区间  0.5~3       -> 零点五到三
#   · 千分位      1,234.5     -> 1234.5（再交给模型的转换读成一千二百三十四点五）
# 有歧义的一概不碰：编号（4090）、光秃秃的 2026、负号减号、
# 右边两位的冒号（3:10 既可能是时间也可能是比分）。
_DIGITS = "零一二三四五六七八九"


def _digits_zh(s):
    return "".join(_DIGITS[int(c)] for c in s if c.isdigit())


def _num_zh(v):
    import cn2an
    try:
        return cn2an.transform(str(int(v)), "an2cn")
    except Exception:
        return str(v)


def _mm_zh(mi):
    """两位的分或秒：00 -> 零，05 -> 零五，30 -> 三十。"""
    if mi == "00":
        return "零"
    if mi[0] == "0":
        return "零" + _digits_zh(mi[1])
    return _num_zh(mi)


def _has_readable(text):
    """模型只认汉字(\u4e00-\u9fa5)和英文字母；一个都没有的段它必然报错跳过。"""
    import re as _re
    return bool(_re.search(r"[A-Za-z\u4e00-\u9fa5]", text))


def _digits_only_zh(text):
    """整段只剩数字和标点时，把数字念成汉字，而不是当"念不出来"整段丢掉。

    2026-10-16：30 字分块会把「570、580）。」这种碎片单独成段送进来。它没有汉字，
    按老规矩会被静音，结果数字整个消失（实测用户听到「550、570、580」只念出 550）。
    数字本身模型是能念的，只是要先由汉字承载，所以这里补一层转换。
    """
    import re as _re

    def _rep(m):
        s = m.group(0)
        if len(s) > 1 and s[0] == "0":
            return _digits_zh(s)          # 005 这种当编号逐位念
        return _num_zh(s)

    text = _re.sub(
        r"(\d+)\.(\d+)",
        lambda m: _num_zh(m.group(1)) + "点" + _digits_zh(m.group(2)),
        text)
    return _re.sub(r"\d+", _rep, text)


def _speak_numbers(text):
    import re as _re
    if not text:
        return text
    # 逗号：一律照写念「逗号」，不判是千分位还是列表
    text = _re.sub(r"(?<=\d),(?=\d)", "逗号", text)
    # 点分日期先处理，免得被当版本号
    text = _re.sub(
        r"(\d{4})\.(\d{1,2})\.(\d{1,2})(?![\d.])",
        lambda m: _digits_zh(m.group(1)) + "年" + _num_zh(m.group(2)) + "月" + _num_zh(m.group(3)) + "号",
        text)
    # 版本号：两个点以上
    text = _re.sub(
        r"\d+(?:\.\d+){2,}",
        lambda m: "点".join(_digits_zh(g) for g in m.group(0).split(".")),
        text)
    # 横杠：照写念「杠」，不判是日期还是减号
    text = _re.sub(r"(?<=\d)-(?=\d)", "杠", text)
    # 冒号：一律照写念「冒号」，不判是时间还是比分
    text = _re.sub(r"(?<=\d):(?=\d)", "冒号", text)
    # 年份后面带空格
    text = _re.sub(r"(\d{4})\s+年", lambda m: _digits_zh(m.group(1)) + "年", text)
    # 数字之间的波浪号
    text = _re.sub(r"(?<=\d)\s*~\s*(?=\d)", "波浪号", text)
    return text


_CHUNK_BREAKS = "。！？；，、,;:!?…）)】」』》） \t\n"


def _is_tok_char(c):
    return c.isalnum() or c in "._-"


def _safe_cut(text, pos):
    """别在数字/英文单词中间下刀；避不开就往后让到词的边界。"""
    n = len(text)
    if pos <= 0:
        return 1
    if pos >= n:
        return n
    if _is_tok_char(text[pos - 1]) and _is_tok_char(text[pos]):
        j = pos
        while j > 0 and _is_tok_char(text[j - 1]):
            j -= 1
        if j > 0:
            return j
        j = pos
        while j < n and _is_tok_char(text[j]):
            j += 1
        return j
    return pos


def _chunk_for_synthesis(text, max_chars):
    """长文本先切块再合成：显存峰值跟单块长度挂钩，切短才压得住。

    2026-10-15 实测：峰值约 2.3G + 每秒钟音频 0.62G。18 秒的长句峰值 13.4G，
    会把显存撑爆并用系统内存兜底（又慢又吃内存）。切成小块后峰值跟块长走。
    优先在标点处切，其次让 _safe_cut 避开数字和英文单词。
    """
    text = (text or "").strip()
    if max_chars <= 0 or len(text) <= max_chars:
        return [text] if text else []
    pieces = []
    rest = text
    while len(rest) > max_chars:
        window = rest[:max_chars]
        cut = 0
        for i in range(len(window) - 1, -1, -1):
            if window[i] in _CHUNK_BREAKS:
                cut = i + 1
                break
        if cut < max_chars // 3:
            cut = _safe_cut(rest, max_chars)
        if cut <= 0:
            cut = max_chars
        pieces.append(rest[:cut])
        rest = rest[cut:]
    if rest:
        pieces.append(rest)
    return [p for p in pieces if p.strip()]


def _ref_text(prompt_wav, fallback):
    """参考文本：优先用参考音频旁边同名的 .txt。

    2026-10-15：音频和它的文本必须成对。插件的设置里可能还留着旧的参考文本
    （改设置要重启才生效），和新的参考音频对不上会直接合成出乱码 —— 实测短参考
    配旧长文本，输出只剩 0.75 秒的"千ん"。所以只要旁边有 .txt 就以它为准。
    """
    if prompt_wav:
        p = os.path.splitext(prompt_wav)[0] + ".txt"
        if os.path.isfile(p):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    t = f.read().strip()
                if t:
                    return t
            except Exception:
                pass
    return fallback


def _seed_all(seed=42):
    """固定随机种子。

    2026-10-15 修：模型采样用的初始噪声是随机的，所以每一段合成出来的音色和
    语气都会飘一点 —— 用户听到的就是"声音会变"。每次合成前把种子重置成同一个
    值，整条回复的每一段就都用同一份噪声，音色保持一致。
    """
    try:
        random.seed(seed)
        import numpy as _np
        _np.random.seed(seed)
        torch.manual_seed(seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(seed)
    except Exception:
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True, help="ZipVoice 源码目录")
    ap.add_argument("--model-dir", required=True)
    ap.add_argument("--vocos-dir", required=True)
    ap.add_argument("--num-step", type=int, default=4)
    ap.add_argument("--trt-engine-path", default="",
                    help="TensorRT 引擎路径；留空则自动找 <模型目录>/trt 里的 .plan")
    ap.add_argument("--max-chars", type=int, default=30,
                    help="单块合成的最长字符数：越小显存峰值越低，切缝越多")
    ap.add_argument("--guidance-scale", type=float, default=3.0)
    ap.add_argument("--num-thread", type=int, default=2)
    ap.add_argument("--prompt-wav", default="")
    ap.add_argument("--prompt-text", default="")
    ap.add_argument("--seed", type=int, default=42, help="固定采样种子，保证音色稳定")
    ap.add_argument("--amp", default="off", choices=["off", "bf16", "fp16"],
                    help="半精度推理。bf16 更快但可能影响音质，默认关")
    ap.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"],
                    help="auto：优先显卡，显存不够就回落到 CPU（慢，但不会把整机拖垮）")
    args = ap.parse_args()

    # 2026-10-15：参考音频和它的文本必须成对。插件的设置里可能还留着旧的参考文本
    # （改设置要重启才生效），跟新参考音频对不上会直接合成出乱码 —— 实测短参考配上
    # 旧长文本，输出只剩 0.75 秒的"千ん"。所以只要参考音频旁边有同名的 .txt，
    # 就以它为准，插件传什么文本都不影响。没有 .txt 时才用插件传的（自定义参考音频走这条）。
    _ref_txt = os.path.splitext(args.prompt_wav)[0] + ".txt" if args.prompt_wav else ""
    if _ref_txt and os.path.isfile(_ref_txt):
        try:
            with open(_ref_txt, "r", encoding="utf-8") as _f:
                _t = _f.read().strip()
            if _t and _t != args.prompt_text:
                sys.stderr.write("参考文本以 %s 为准\n" % os.path.basename(_ref_txt))
                args.prompt_text = _t
        except Exception:
            pass

    sys.path.insert(0, args.repo)
    import numpy as np
    import soundfile as sf
    import torch

    # 2026-10-15：打开 TF32（张量核心跑 fp32 矩阵乘）。实测同一条文本，
    # 合成 4.52 秒 → 2.67 秒，实时率 1.50 → 0.89。数值精度影响极小，音质听不出差别。
    try:
        torch.set_float32_matmul_precision("high")
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
    except Exception:
        pass

    torch.set_num_threads(args.num_thread)
    torch.set_num_interop_threads(args.num_thread)

    from zipvoice.bin.infer_zipvoice import generate_sentence, get_vocoder
    from zipvoice.models.zipvoice_distill import ZipVoiceDistill
    from zipvoice.tokenizer.tokenizer import EmiliaTokenizer
    from zipvoice.utils.checkpoint import load_checkpoint
    from zipvoice.utils.feature import VocosFbank

    token_file = os.path.join(args.model_dir, "tokens.txt")
    config_path = os.path.join(args.model_dir, "model.json")
    ckpt_path = os.path.join(args.model_dir, "model.pt")
    tokenizer = EmiliaTokenizer(token_file=token_file)
    with open(config_path, "r", encoding="utf-8") as f:
        model_config = json.load(f)

    def build(dev):
        m = ZipVoiceDistill(**model_config["model"],
                            vocab_size=tokenizer.vocab_size, pad_id=tokenizer.pad_id)
        load_checkpoint(filename=ckpt_path, model=m, strict=True)
        m = m.to(dev).eval()
        v = get_vocoder(args.vocos_dir).to(dev).eval()
        return m, v

    if args.device == "cpu":
        want = [torch.device("cpu")]
    elif args.device == "cuda":
        want = [torch.device("cuda", 0)] if torch.cuda.is_available() else []
    else:
        want = [torch.device("cuda", 0), torch.device("cpu")] if torch.cuda.is_available() else [torch.device("cpu")]
    if not want:
        raise RuntimeError("要求用显卡，但这台机器上没有可用的 CUDA 设备")

    model = None
    device = want[0]
    last_err = None
    for dev in want:
        try:
            model, vocoder = build(dev)
            device = dev
            if str(dev) != str(want[0]):
                sys.stderr.write("显卡这条路走不通（%s），已回落到 %s，速度会慢\n" % (last_err, dev))
            break
        except Exception as e:  # noqa: BLE001
            last_err = e
            model = None
            try:
                torch.cuda.empty_cache()
            except Exception:
                pass
    if model is None:
        raise RuntimeError("模型加载失败：%s" % last_err)

    if args.amp != "off":
        # 半精度：只包住采样那一步，声码器仍旧走 fp32（声码器对精度敏感）。
        _amp_dtype = torch.bfloat16 if args.amp == "bf16" else torch.float16
        _orig_sample = model.sample

        def _amp_sample(*a, **k):
            with torch.autocast("cuda", dtype=_amp_dtype):
                return _orig_sample(*a, **k)

        model.sample = _amp_sample

    # 2026-10-16：TensorRT 引擎（固定内存池 + fp16）。实测同一块文本：PyTorch 峰值 4.8G、
    # 单块 0.6 秒；换成引擎后显存固定 740 MiB、单块 0.12 秒。引擎放在 <模型目录>/trt/ 里，
    # 有就用；没有或者加载失败就照原样走 PyTorch，行为不变。
    trt_path = args.trt_engine_path
    if not trt_path and device.type == "cuda":
        _cands = sorted(glob.glob(os.path.join(args.model_dir, "trt", "*.plan")))
        # 只挑 fp16 引擎：fp32 引擎和本文件的 fp16 包装不兼容，试过会出噪音
        _fp16 = [c for c in _cands if "fp16" in os.path.basename(c).lower()]
        trt_path = (_fp16 or _cands)[0] if _cands else ""
    if trt_path and device.type == "cuda":
        try:
            from zipvoice.utils.tensorrt import load_trt
            load_trt(model, trt_path)
            sys.stderr.write("已启用 TensorRT 引擎 %s\n" % os.path.basename(trt_path))
        except Exception as e:  # noqa: BLE001
            sys.stderr.write("TensorRT 引擎加载失败，退回 PyTorch：%s\n" % e)
            trt_path = ""

    feature_extractor = VocosFbank()
    sampling_rate = model_config["feature"]["sampling_rate"]
    if device.type == "cuda":
        sys.stderr.write("模型加载完 reserved=%.2fG allocated=%.2fG\n" % (
            torch.cuda.memory_reserved() / 1024 ** 3, torch.cuda.memory_allocated() / 1024 ** 3))

    # 先合成一段短的把核烧热，免得上第一句真话时慢一截
    try:
        warm = tempfile.NamedTemporaryFile(suffix=".wav", delete=False).name
        generate_sentence(save_path=warm, prompt_text=args.prompt_text,
                          prompt_wav=args.prompt_wav, text="预热。", model=model,
                          vocoder=vocoder, tokenizer=tokenizer,
                          feature_extractor=feature_extractor, device=device,
                          num_step=args.num_step, guidance_scale=args.guidance_scale,
                          speed=1.0, sampling_rate=sampling_rate)
        os.unlink(warm)
    except Exception:
        pass

    send({"id": 0, "ok": True, "ready": True, "sampleRate": sampling_rate,
          "device": str(device), "numStep": args.num_step})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            continue
        mid = msg.get("id", 0)
        if msg.get("type") == "close":
            break
        try:
            prompt_wav = msg.get("promptWav") or args.prompt_wav
            prompt_text = _ref_text(msg.get("promptWav") or args.prompt_wav,
                                    msg.get("promptText") or args.prompt_text)
            if not prompt_wav or not os.path.isfile(prompt_wav):
                raise RuntimeError("找不到参考音频: " + str(prompt_wav))
            # 2026-10-15：上一版为了救句尾丢字，在末尾补了个逗号。补逗号确实能救回最后一个字，
            # 但模型会把那个标点的时长当成一拍，填出"啊/诶"这类多出来的音。
            # 所以撤掉，改用降语速的办法（见下面的上限）。
            text = _speak_numbers(msg.get("text") or "")
            # 2026-10-15：整段没有任何汉字/字母时，模型会抛"整数除零"，重试三次再跳过。
            # 直接回一小段静音：不出错、不白等，反正这段本来也念不出来。
            if not _has_readable(text):
                spoken = _digits_only_zh(text)
                if _has_readable(spoken):
                    text = spoken           # 纯数字碎片：照念，别丢
                else:
                    send({"id": mid, "ok": True, "sampleRate": int(sampling_rate),
                          "samples": base64.b64encode(
                              np.zeros(int(sampling_rate * 0.06), dtype=np.float32).tobytes()).decode("ascii")})
                    continue

            if "speed" in msg:
                speed_req = float(msg.get("speed") or 1.0)
            else:
                speed_req = 1.0
            speed_req = max(0.5, min(speed_req, QUALITY_SPEED_MAX))
            model_speed = min(speed_req, MODEL_SPEED_MAX)

            _mc = int(msg.get("maxChars") or args.max_chars)
            if trt_path and _mc > 30:
                _mc = 30   # 引擎的固定 profile 只到 1000 帧，块太长会超范围
            pieces = _chunk_for_synthesis(text, _mc)
            wavs = []
            sr = sampling_rate
            # 2026-10-17：模型偶尔把某块预测成 0 帧，产出空波形（日志里表现为 pydub 除零）。
            # 以前一块失败整段回复都丢掉；现在每块重试一次，仍失败就跳过这一块，
            # 让剩下的部分照常念出来，并把失败块写进 stderr。
            failed_pieces = []
            for pi, piece in enumerate(pieces, 1):
                piece_wav = None
                last_err = None
                for attempt in (1, 2):
                    out = tempfile.NamedTemporaryFile(suffix=".wav", delete=False).name
                    try:
                        _seed_all(args.seed + attempt - 1)
                        generate_sentence(
                            save_path=out,
                            prompt_text=prompt_text,
                            prompt_wav=prompt_wav,
                            text=piece,
                            model=model,
                            vocoder=vocoder,
                            tokenizer=tokenizer,
                            feature_extractor=feature_extractor,
                            device=device,
                            num_step=int(msg.get("numStep") or args.num_step),
                            guidance_scale=args.guidance_scale,
                            # 2026-10-15：模型语速封 1.3（再快会把句尾的字挤掉），超过的部分由下面的
                            # 时长压缩补上，所以这里给的是"模型该用的语速"。
                            speed=model_speed,
                            sampling_rate=sampling_rate,
                        )
                        # 2026-10-15：常驻进程 + PyTorch 缓存分配器会让占用一路爬升
                        # （实测单个进程爬到 7381 MiB / 8192 MiB，下一次大分配就 out of memory）。
                        # 每块合成完就把闲置缓存还给驱动。
                        try:
                            if torch.cuda.is_available() and torch.cuda.memory_reserved() > 1 << 30:
                                sys.stderr.write("显存回收(第%d/%d块) reserved=%.2fG allocated=%.2fG 峰值=%.2fG\n" % (
                                    pi, len(pieces),
                                    torch.cuda.memory_reserved() / 1024 ** 3,
                                    torch.cuda.memory_allocated() / 1024 ** 3,
                                    torch.cuda.max_memory_allocated() / 1024 ** 3))
                                torch.cuda.empty_cache()
                        except Exception:
                            pass
                        w, sr = sf.read(out, dtype="float32")
                        if getattr(w, "ndim", 1) > 1:
                            w = w.mean(axis=1)
                        if w.size == 0:
                            raise RuntimeError("zipvoice_empty_waveform: 该块合成结果为空(0 采样)")
                        piece_wav = np.ascontiguousarray(w, dtype=np.float32)
                        break
                    except Exception as e:
                        last_err = e
                        sys.stderr.write("块 %d/%d 第 %d 次合成失败: %s\n" % (
                            pi, len(pieces), attempt, str(e)[:160]))
                    finally:
                        try:
                            if os.path.exists(out):
                                os.unlink(out)
                        except Exception:
                            pass
                if piece_wav is None:
                    failed_pieces.append("第%d块: %s" % (pi, str(last_err)[:80]))
                    continue
                wavs.append(piece_wav)
            if not wavs:
                raise RuntimeError("全部 %d 块都没合成出音频: %s" % (len(pieces), "; ".join(failed_pieces[:3])))
            wav = wavs[0] if len(wavs) == 1 else np.concatenate(wavs)
            if speed_req > model_speed + 0.02:
                wav = np.ascontiguousarray(
                    _time_stretch(wav, speed_req / model_speed, sampling_rate), dtype=np.float32)
            else:
                wav = np.ascontiguousarray(wav, dtype=np.float32)
            send({"id": mid, "ok": True, "sampleRate": int(sr),
                  "samples": base64.b64encode(wav.tobytes()).decode("ascii")})
        except Exception as e:
            try:
                log_error(mid, msg.get("text"), locals().get("text"))
            except Exception:
                pass
            send({"id": mid, "ok": False, "error": str(e)})


if __name__ == "__main__":
    main()
