# dsh-voice-mode-desktop

English | [中文](./README.zh.md)

Full-duplex voice mode for **DeepSeek Harness 0.2 (desktop)**: speak and the words stream into the draft, pause and the message sends, the reply is read sentence by sentence, and speaking again interrupts the read-aloud. Ships an in-app settings page for reading speed, input mode and captions.

This is an adapted fork of [`dsh-voice-mode`](https://github.com/qishuilalala/dsh-voice-mode) 0.7.15 (which in turn derives from [`haoku123/dsh-voice`](https://github.com/haoku123/dsh-voice)). Both are MIT licensed; see [LICENSE](./LICENSE).

**What this fork is:** the compatibility adaptation that makes that plugin run on DSH 0.2 desktop — it adapts the client API the plugin depends on, adds an in-app settings page, and replaces the cloud read-aloud dependency with a small client kept inside this repository. The recognition, barge-in and local-TTS engines are upstream work, unchanged.

- Upstream declares compatibility up to DSH 0.1.7-rc.1 and is written against the 0.1 client API.
- This fork targets DSH **0.2.0-rc.2** (the engine shipped with DSH NEXT desktop `2.0.17-next`), where the client service `settingsScope` no longer exists and plugin settings forms only render `volatile` fields.
- Verified on Windows, DSH NEXT desktop `2.0.17-next`, `@deepseek-ai/* 0.2.0-rc.2`. Other versions are untested.

## What it does

- **Voice in**: press-and-hold or continuous listening, streaming recognition into an editable draft, silence-based auto-send.
- **Voice out**: sentence-by-sentence read-aloud (Edge cloud TTS by default; local VITS / Kokoro optional), live captions.
- **Full duplex**: speaking while the reply is read stops playback and cancels the running turn.
- **Settings page**: reading speed (0.5–2.0), input mode (hold / continuous), caption show-hide, and a one-click audio self-test. Reachable from the sidebar **Plugins** page as the item **语音模式 / Voice mode**. The self-test deliberately separates synthesis from playback, so a silent reply can be traced to the engine or to the audio output instead of being guessed at.

## How to use it: hold to speak

Day to day this plugin is meant to be used **hold-to-speak**: hold the shortcut, say one sentence, release. In the voice session pick "hold" as the recording mode and "manual" as the barge-in mode.

**Full duplex (always listening + auto barge-in) is not the recommended everyday mode, and it has no regression coverage.** The reason is practical: it hands the timing to the model. It may start acting before you finish, or keep listening after you are done, and you lose control over when it stops and when it acts. Hold-to-speak keeps both decisions with you: release means the sentence is finished, and only then may it act.

- Want predictable control: hold-to-speak + manual barge-in (recommended).
- Trying full duplex: fine, but treat it as experimental. If it talks over you or fails to stop, switch back to hold-to-speak before blaming the plugin.

## Differences from upstream `dsh-voice-mode` 0.7.15

| Area | Change | Why |
|---|---|---|
| Client half | `inject` no longer declares `settingsScope`; the access is wrapped in `try`/`catch` | `settingsScope` was removed from the DSH client API; the host treats "one entry did not activate" as fatal and the desktop app drops into recovery |
| Settings schema | `rate` and `mode` are marked `volatile`, and volatile values are unwrapped at every read site | DSH 0.2 renders only `volatile` fields in plugin forms; a wrapped value passed to the TTS engine makes synthesis fail silently |
| Settings UI | New in-app page (sidebar Plugins → 语音模式) plus host endpoint `POST /voice-mode/settings`; laid out like the host's own settings pages and themed with host design tokens (`--dsw-alias-*`) | The upstream settings card depends on the removed client API, and the host page that renders plugin config forms is not mounted in the desktop deployment |
| Captions | Added a show/hide switch; caption max width capped (420 px default tier) | Captions are optional; the previous default could span most of the window |
| Status bar | Width is content-sized, centered, capped at 480 px | It previously stretched across the whole composer |
| Diagnostics | One log line when a model stream is skipped because the voice session does not match | Makes a silent "no read-aloud" reproducible from logs |
| Packaging | Renamed package; the bundle patch mounts this package by a package-relative path | Makes the adaptation installable instead of a pile of local edits, and avoids the host's bare-specifier resolution for profile plugins |
| Cloud TTS | The `msedge-tts` dependency is replaced by an in-repo Edge read-aloud client (`lib/edge-tts.js`) | `msedge-tts` ships `require("buffer/index")`, which the DSH desktop host cannot resolve, so importing it failed and the plugin never loaded. Shipping the ~180-line client makes installation a single step with no dependency patching |

Everything else — recognition, TTS engines, barge-in, wake word, backchannel yield, model pinning — is upstream code, unchanged.

### Change scope

Baseline: `dsh-voice-mode@0.7.15` as published on npm (itself derived from `haoku123/dsh-voice`). Files touched by this fork:

| File | Nature of change |
|---|---|
| `lib/index.js` | host half: `volatile` fields in the settings schema, `POST /voice-mode/settings`, one diagnostic log line; the Edge engine now calls the in-repo client instead of `msedge-tts` |
| `lib/client.js` | client half: `inject` list, `settingsScope` guard, the settings page, caption show/hide and width, status-bar width |
| `lib/edge-tts.js` | new in this fork |
| `cordis.patch.yml`, `package.json` | mount point and packaging metadata (renamed package, no install scripts) |
| `scripts/verify-compat.mjs`, `scripts/check-tts.mjs` | new in this fork |

`lib/sense-worker.mjs` and `lib/tts-vits-worker.cjs` are upstream files, byte-identical. The upstream project keeps its own git history, tests and build pipeline; this fork is a compatibility adaptation, not a rewrite.

## Install

The plugin is a DSH bundle. In a profile:

```bash
# from the npm registry …
dsh plugin add @nutshelllee/dsh-voice-mode-desktop

# … or from a local checkout
dsh plugin add link:/path/to/dsh-voice-mode-desktop

# … or straight from the repository, without a registry entry
#   dependency: "@nutshelllee/dsh-voice-mode-desktop": "git+https://github.com/NutshellLee/dsh-voice-mode-desktop.git"
```

Then enable it in the profile manifest (`dsh.profile.bundles`) and, optionally, override defaults in the profile patch:

```yaml
- id: voice-mode
  config:
    enabled: true
    voice: zh-CN-XiaoxiaoNeural
    rate: 1.1
    mode: hold          # hold = push to talk, toggle = continuous listening
    ttsEngine: edge     # edge | vits | kokoro
    bargeInMode: detect
    silenceMs: 1500
    autoSend: true
    spokenFormat: true
```

Restart the app after the first install, then open **Plugins → 语音模式** to adjust settings, or press `Ctrl+Shift+V` inside a conversation.

### Cloud read-aloud status

The Edge engine talks to Microsoft's read-aloud endpoint directly from `lib/edge-tts.js` (WebSocket handshake, SSML request, MP3 frames). No third-party TTS wrapper is involved, so installation needs no install script and no dependency patching. To check the path on your machine:

```bash
node scripts/check-tts.mjs
```

The read-aloud connection picks up a proxy automatically: `HTTPS_PROXY` / `HTTP_PROXY` first, otherwise the Windows system proxy from Settings (the `ProxyServer` value under `Internet Settings`). Microsoft is picky about the source IP — on some networks a direct connection is answered with 403 while going through a proxy works, and `ws` ignores the system proxy by default, so the client has to do this itself. To force a direct connection, set `NO_PROXY` to `speech.platform.bing.com`.

## Verify

```bash
node scripts/verify-compat.mjs [path-to-dsh-app]
```

Checks the contract this fork depends on: the DSH app is present, all nine client inject targets exist, the host no longer serves `settingsScope`, the plugin's client half declares no missing service, and `rate`/`mode` project as live-editable fields. Exit code 0 means all checks passed.

## Models

No model files are bundled. The plugin downloads what it needs the first time that capability is used, then reuses the local copy.

| Capability | Downloaded when | Source repository |
|---|---|---|
| Streaming recognition (default) | first voice input | `csukuangfj/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30` (encoder / decoder / joiner / tokens) |
| Voice activity detection | first voice input | Silero VAD (`silero_vad.onnx`) |
| SenseVoice recognition (`senseVoice: true`) | first voice input | SenseVoice int8 (`model.int8.onnx` + tokens) |
| Local VITS read-aloud (`ttsEngine: vits`) | first read-aloud with that engine | `csukuangfj/sherpa-onnx-vits-zh-ll` |
| Local Kokoro read-aloud (`ttsEngine: kokoro`) | first read-aloud with that engine | Kokoro int8 model set |

- **Hosts**: `huggingface.co` first, `hf-mirror.com` as fallback. Only those two (plus `hf.co`) are accepted unless `allowCustomHost: true` is set in the profile patch. Set `modelHost` to pin a mirror.
- **Cache directory**: `%LOCALAPPDATA%\dsh-voice-mode\models` on Windows, `~/.cache/dsh-voice-mode/models` elsewhere.
- **Integrity**: every file is checked against a pinned SHA-256 before use; partial downloads are written next to the target and only renamed once they verify.
- **Progress**: download and load progress is reported in the voice status bar; failures are surfaced in the chat rather than silently ignored.
- **Offline**: recognition needs the model files (and `ttsEngine: edge` needs network on every read-aloud). To run fully offline, pre-populate the cache directory and use `vits` / `kokoro`.

## Restart-plugin integration

This plugin can pair with [`dsh-agent-restart`](https://github.com/NutshellLee/dsh-agent-restart). When the agent restarts the app itself, that plugin records whether voice mode was on and writes a handover file after restart; this plugin reads it on startup, restores voice mode automatically (hold and speak), and deletes the file after a confirmed resume.

It only applies to agent-initiated restarts; closing and reopening the app by hand does not auto-restore. Without the restart plugin, this plugin works on its own.

## Known limitations

- **Compiled artifacts**: `lib/` is upstream's built output with this fork's edits applied, not regenerated from source. Read the diff against `dsh-voice-mode@0.7.15` rather than expecting readable source.
- **Cloud TTS by default**: `ttsEngine: edge` sends the spoken text to Microsoft. Use `vits` or `kokoro` for fully local synthesis.
- **Barge-in on speakers** depends on the browser's echo cancellation; on Windows, hold-to-talk or headphones give the most reliable interruption.
- **Settings persistence** covers `rate` and `mode` (the two `volatile` fields). Other options are read from the profile patch at startup.
- **Diagnostics write to a local log**: to pin down "an entire utterance went missing", the plugin writes every finalised segment (up to 400 characters) plus a set of pipeline events into DSH's application log (`desktop-next.log`). The log stays on the machine and the diagnostics endpoint listens on loopback only (`POST /voice-mode/diag`, same-origin checked); its content, however, is your own dictated text — clear the log periodically, and avoid installing this on a shared account.
- **The correction dictionary is a local file**: entries live in `~/.dsh/voice-dict.json` (override with the `DSH_VOICE_DICT` environment variable) and are not shipped with this package; the repository carries the matching logic only, never anyone's entries.
- **Full duplex has no automated regression**: always-listening + auto barge-in depends on echo cancellation and endpointing, and its timing varies with device and room. The checks in this repo only cover the hold-to-speak path; full duplex gets manual smoke testing only, so verify it by hand when you touch that code.

## Compatibility matrix

| DSH (`@deepseek-ai/*`) | Desktop shell | Status |
|---|---|---|
| 0.2.0-rc.2 | DSH NEXT `2.0.17-next` (Windows) | verified (load, settings, TTS, recognition) |
| 0.1.7-rc.1 and older | — | use upstream `dsh-voice-mode` |
| other | — | untested |

## License and attribution

MIT. Copyright notices for the upstream projects are preserved in [LICENSE](./LICENSE). This fork is unofficial and not endorsed by the upstream authors; the package name is different on purpose.

The full adaptation log — what failed, in what order, and how each change was verified — is in [docs/CHANGELOG.md](./docs/CHANGELOG.md).
