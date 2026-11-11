# WatchVid4U · 帮你看视频

**English** | [简体中文](README.zh-CN.md)

**No downloading, no dependence on subtitles: it "watches" the video the way you would**, and gives you a saved transcript and study notes. A Chrome extension (Manifest V3).

> **Note:** The extension's interface is currently in Simplified Chinese, and its defaults are tuned for Chinese transcripts and notes (the transcription language and prompts can be changed in settings).

## Why this project

Most video summarizers get their content in one of three ways, and each has a weak spot:

| Approach | Weakness |
|---|---|
| Read the video's subtitles | Useless when a video has no subtitles |
| Download the audio with tools like yt-dlp, then transcribe | Frequently blocked by sites' anti-download measures; needs constant updates to the downloader and cookies to keep working |
| OCR the subtitles burned into the picture | Compute-heavy, and subtitle styles vary too much from video to video |

WatchVid4U takes a different route: **use subtitles when they are available; otherwise, really play the video in the browser and record the tab's audio, then transcribe it.** The video is genuinely playing and the audio is recorded rather than downloaded, so to the site it is no different from you watching it yourself, and anti-download measures are not triggered. The trade-off is speed: a video has to play through at normal length to get the full recording.

**A stable core pipeline:** the main path, "record tab audio → speech-to-text → LLM summary", relies only on standard browser capabilities and generic APIs, not on any video site's interfaces, so it does not need changes when sites are redesigned. The parts that do follow site changes (subtitle APIs, ad detection, and so on) are deliberately kept small: subtitle fetching currently covers Bilibili only.

**Where it works:** major free video sites (with specific support for Bilibili, YouTube and Douyin; other pages that play audio normally can be recorded too). Not every site is guaranteed to work: for example, browsers may not allow recording DRM-protected content from paid streaming services.

**One click:** on Bilibili, if subtitles are available the full subtitle track is saved as the transcript. Without usable subtitles (or on YouTube, Douyin and ordinary web pages), the **same task automatically switches to recording**. When the main content finishes, it **pauses the page, blocks autoplay of the next item or looping, and stops recording**, then sends the audio to the transcription service you configured. Optionally, a separate LLM then writes notes. Closing the popup or switching tabs does not interrupt the task.

---

## Contents

- [Installation](#installation)
- [First-time setup](#first-time-setup)
- [Everyday use](#everyday-use)
- [Platform support](#platform-support)
- [Optional: local transcription service](#optional-local-transcription-service)
- [Troubleshooting](#troubleshooting)
- [Privacy](#privacy)
- [Project structure and development](#project-structure-and-development)
- [Testing status and known limitations](#testing-status-and-known-limitations)
- [Roadmap](#roadmap)
- [Usage notice](#usage-notice)
- [License](#license)

## Installation

1. Download `WatchVid4U-<version>.zip` from the GitHub Releases page and unzip it (or clone the repository and use the `extension/` source folder directly).
2. Open `chrome://extensions` and turn on "Developer mode" in the top-right corner.
3. Click "Load unpacked" and select the unzipped folder (the one containing `manifest.json`).
4. Pinning the extension to the toolbar is recommended. The settings page opens automatically after the first install.

Requirements: Chrome, Edge or another Chromium-based browser, version 116 or later.

**Adaptive interface sizing:** the interface adapts to your operating system rather than simply scaling up or down:

- **Per-platform profiles:** Windows and Linux logical pixels are larger than on macOS and native interfaces are more compact, so a smaller base scale and a gentler type scale are used (small text stays readable; headings shrink more).
- **Font weight:** Chinese fonts such as Microsoft YaHei have no semi-bold, and `600` renders as full bold, so body text, buttons and labels use regular weight and only headings are bold.
- **Glyph correction:** at runtime the extension measures the actual size of the Chinese system font (YaHei glyphs are larger than PingFang's) and normalizes it to PingFang.
- **Manual adjustment:** Settings → "存储与外观" (Storage & appearance) → "界面比例" (Interface scale), 80%–125%, with live preview. The detected system, glyph correction and resulting scale are shown below it. It applies to the popup, materials page, settings page and the in-page floating panel; the browser's own zoom and font settings still apply.

## First-time setup

| You want | What to configure |
|---|---|
| Bilibili videos with subtitles → transcript | **Nothing** |
| Recording + transcription (Bilibili without subtitles, YouTube, Douyin, other pages) | Settings → "语音转写" (Speech-to-text) |
| Study notes (concise / detailed / minutes) | Settings → "笔记模型" (Notes model) |

**Speech-to-text (cloud, recommended):** any synchronous transcription service compatible with OpenAI's `/audio/transcriptions`.

1. Click a preset (for example Groq: `https://api.groq.com/openai/v1`, model `whisper-large-v3`) or enter the address and model yourself.
2. Paste your own API key (the extension ships with no shared keys and does not promise that any service stays free).
3. Review the recipient, the data sent and possible costs listed under "用途与授权" (Purpose & authorization), then click "保存并授权" (Save & authorize) → confirm → allow the browser to access that address.
4. Optionally click "测试连接" (Test connection): it sends only a fixed 1.5-second test tone, never your recordings.

**Notes model:** any non-streaming Chat Completions service. The address can be `https://host/v1`, with a trailing slash, or the full `…/chat/completions`; the final request URL is shown so you can check it (presets such as MiMo, DeepSeek and OpenAI are examples only; follow your provider's documentation for model names).

**Key storage:** "在本机记住 Key" (Remember key on this device) is checked by default. The key is stored **unencrypted** in the extension's own local data (web pages and content scripts cannot read it), so you don't need to re-enter it after restarting the browser. Uncheck it to keep the key only for the current browser session (cleared when the browser closes). When you change a service's address, the old key is discarded and never sent to the new address.

## Everyday use

**Three entry points, one workflow** (same task, same status, same Bilibili-subtitles-first logic with automatic fallback to recording):

- **Toolbar popup:** "开始录制" (Start from the current position) / "从头录制" (Start from the beginning of the main content).
- **In-page floating panel:** a small square in the bottom-right corner of Bilibili, YouTube and Douyin pages. It can be dragged or hidden (hiding it does not affect the task).
- **Browser shortcuts** (changeable at `chrome://extensions/shortcuts`):

| Action | Default |
|---|---|
| Start from the current position | `Alt+Shift+S` |
| Start from the beginning | `Alt+Shift+B` |
| Stop and save | `Alt+Shift+E` |
| Show/hide the floating panel | `Alt+Shift+F` |

You can also enable a **single-key in-page shortcut** for the floating panel in settings (off by default; it does not respond while you type in input boxes, comment areas or an IME).

**What one task does automatically:** detect the platform → (Bilibili) try the full subtitle track → save it as the transcript on success, otherwise switch to recording → find the starting point (starting from the beginning seeks to 0 s; on YouTube it waits for the main content after ads) → start playback only once recording is ready → when the main content ends naturally, pause the page and keep blocking autoplay → save the audio → transcribe automatically → (optionally) generate notes → notify (optional).

- Recording is **muted by default** (you don't hear it, but the recording is complete); you can turn on "同时听声音" (Listen while recording) at any time.
- Recording pauses while the video is paused; buffering, seeking and switching to a background tab are not mistaken for the end.
- "停止并保存" (Stop and save) means a manual end; it is marked separately from a normal finish and from an abnormal interruption. Recordings from abnormal interruptions are **not uploaded automatically**; you can listen to them on the materials page and decide.
- After the video finishes, the page stays paused **until you press play or choose another video yourself**; this protection applies only to the current task and does not change the site's autoplay settings.

**Materials & notes page:** pick a material on the left (filter, select all, batch delete, batch export text as JSON) and view on the right:

- **Transcript:** the single "effective transcript" (speaker-segmented with anonymous speakers when there are several and the result is reliable, otherwise a plain transcript); copy it or download it as TXT.
- **Notes:** at the top of the "笔记" (Notes) tab, choose a note style first (concise / detailed / minutes; styles marked ● already have notes). The button right next to it generates or regenerates notes in that style. Switching styles only shows existing notes and never goes online by itself; if the transcript changes, you are told the old notes may be outdated.
- **Audio & source:** WAV playback (true duration, seekable) and download, how recording started and ended, YouTube ad periods; for Bilibili subtitles, the type (human / auto-generated / unknown), language, part number and export of the original subtitles.
- If transcription fails, completed slices are kept and "继续转写" (Continue transcription) processes only what remains; a failure never overwrites an existing complete transcript.

## Platform support

| Platform | Subtitles | Recording | After the video ends | Notes |
|---|---|---|---|---|
| Bilibili regular videos (including multi-part videos and `/list/` playlist pages) | ✅ Full track fetched first automatically, checked against BV ID / part | ✅ Automatic fallback when subtitles are unavailable | Pause + block autoplay / recommendations | Bangumi and course pages skip subtitles and record directly |
| YouTube regular watch page `/watch` | — | ✅ | Pause + cancel the up-next countdown + block delayed autoplay | Distinguishes pre-roll and mid-roll ads; "from the beginning" waits for the main content to start |
| Douyin video pages / feed | — | ✅ | Pause + block looping from the start | Swiping to the next video counts as a change of video; the task stops and keeps what was recorded |
| Other web pages with audio | — | ✅ | Ends automatically when a `<video>/<audio>` element can be found | If no controllable media is found, use "Stop and save" manually |

YouTube Shorts, players embedded in iframes and DRM-protected content are not supported in this version.

## Optional: local transcription service

Use this if you don't want a cloud service or want speaker separation. You can use this project's bundled backend, or any transcription service compatible with OpenAI's `/audio/transcriptions` running on your own machine (`127.0.0.1` / `localhost`).

**Bundled backend** (see [local-backend/README.md](local-backend/README.md), in Chinese):

- Listens only on `127.0.0.1` and accepts only `chrome-extension://` origins (use `--allow-origin` to restrict it to your extension ID).
- Automatically picks mlx-whisper (Apple Silicon; reuses `mlx-community/whisper-*` models already in your Hugging Face cache) or faster-whisper; **it never downloads models at runtime**.
- Speaker separation needs a local pyannote model; if it is unavailable or fails, you still get a complete plain transcript.
- Settings → "语音转写" (Speech-to-text) → choose "本地服务" (Local service) → "保存并授权" (Save & authorize) → "测试转写" (Test transcription).

**Other local services:** under "本地服务" (Local service), enter its address (`http://127.0.0.1:port`, `…/v1` or the full `…/audio/transcriptions`) and a model name it accepts; enter a key only if the service requires one (optional). "测试转写" (Test transcription) sends a fixed test tone through the complete request, so if it passes, the service is ready to use.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| The floating panel says it "needs your authorization to record" (需要你授权录音) | Browser rule: tab audio can only be recorded on pages where you have **clicked the toolbar icon or used a browser shortcut** to invoke the extension. Click the toolbar icon once and choose "授权并继续录音" (Authorize and continue recording) in the popup; that page won't ask again. |
| Bilibili says login is required for subtitles | In Settings → "B站字幕" (Bilibili subtitles), enable "允许使用当前浏览器的 B站登录状态" (Allow using this browser's Bilibili login). Otherwise the extension records and transcribes instead. |
| Subtitles "don't match the adoption policy" | Auto-generated, unknown-source or non-Chinese subtitles are turned off in settings; the extension records instead. |
| Recording reports "continuous silence" | The video isn't playing, the page is muted, or the volume is 0. |
| "The browser blocked automatic playback" | Recording is ready; click play on the page once. |
| Transcription: "the service returned a web page" | The address probably lacks `/v1` or points at a website's home page; compare it with the "请求地址" (Request URL) shown in settings. |
| Transcription: HTTP 413 | The provider's upload limit is smaller than the setting; lower "单次上传上限" (Max upload per request) under Advanced. The extension slices audio accordingly. |
| Transcription: HTTP 401/403, 429 | Invalid key or missing permission; or rate limiting / insufficient quota. |
| Notes: "streaming response / output truncated / empty content" | The service doesn't support `stream:false`; or "max output tokens" is too small; or the model refused. Old notes are kept. |
| Notes: "exceeds the maximum input length" | The extension never truncates silently; raise the limit in Settings → Notes model → Advanced. |
| A task stays "processing" | Open the popup to see which step it is on; you can cancel. Cancelling only stops the local wait; the provider may still charge. |

## Privacy

See [docs/PRIVACY.md](docs/PRIVACY.md) (in Chinese). In short: there is no project server, proxy or analytics; materials are stored only on your device; only the transcription and notes services you authorize receive data (transcription receives only the current audio and necessary parameters; notes receive only the current effective transcript and fixed prompts); titles, URLs and accounts are never sent; cookie values are never read; videos are never downloaded; no access restrictions are bypassed.

## Project structure and development

```
extension/                 Extension source (no build step, no third-party runtime dependencies, native ES modules)
  manifest.json
  src/background/sw.js     Task state machine (single entry point, locks, tab lifecycle, auto transcription/notes orchestration)
  src/offscreen/           Recording (AudioWorklet → 16 kHz PCM → IndexedDB chunks) and transcription/notes jobs
  src/content/             Page agent: locate the video, start point, end detection, post-play protection, YouTube ad state, Bilibili subtitle requests, floating panel
  src/shared/              Settings/consent, STT/LLM clients, slicing, transcript assembly, prompts, Bilibili subtitles, safe Markdown rendering, database
  src/ui/                  Popup, materials & notes, settings
local-backend/server.py    Optional local transcription service (standard-library HTTP; inference dependencies optional)
tests/                     In-browser unit tests, extension end-to-end tests, local backend tests, fixture server and media
scripts/                   Icon generation, packaging
docs/                      Privacy notice
```

Common commands (require Python 3.10+ and Google Chrome installed locally; tests don't need Node):

```bash
python3 tests/run_unit.py
```

```bash
python3 tests/run_e2e.py
```

```bash
python3 tests/test_local_backend.py
```

```bash
python3 scripts/package.py
```

## Testing status and known limitations

- **Actually run and passing locally:** 77 in-browser unit tests; 106 extension end-to-end checks (including interface checks under a simulated Windows UA and 1.5× DPI) (real Chrome 155 loading the extension, simulated Bilibili/YouTube/Douyin pages and APIs, simulated STT/LLM services); 7 local backend protocol tests.
- **Stand-ins and simulations:** the tab audio source (`tabCapture` must be authorized by a user clicking the toolbar icon, which automation can't trigger, so tests use a media stream generated from the same test audio); all three platforms' pages and APIs are local fixtures; STT/LLM are local mock services; the local backend uses a fake engine.
- **Additional real-world check:** the bundled local backend has completed a real transcription request on macOS with mlx-whisper (whisper-large-v3-turbo).
- **Not yet systematically tested:** the real Bilibili/YouTube/Douyin sites, real cloud STT/LLM services, faster-whisper / pyannote inference, Windows, the real `tabCapture` recording path, and long (>1 hour) recordings.

## Roadmap

Planned directions, not yet implemented. Discussion is welcome in Issues:

- **Subtitle fetching on more sites:** like Bilibili, prefer subtitles on other sites too (especially subtitles uploaded by the creator); it is always the fastest and most accurate option.
- **Multimodal understanding:** capture a frame at regular intervals while recording and give the frames to a multimodal model together with the transcript, to help with content where audio alone isn't enough (charts, slides, on-screen demos), at only a small cost in storage and compute.
- **Recording several tabs at once:** play and record multiple videos simultaneously, each producing its own transcript, instead of waiting for them one by one.

## Usage notice

This project is intended for personal study and research only. Please follow each video site's terms of service and local laws, respect creators' copyrights, and do not redistribute recorded audio or content generated from it.

## License

[MIT](LICENSE) © 2026 lkdlcodyl
