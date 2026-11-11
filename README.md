# WatchVid4U · 帮你看视频

**English** | [简体中文](README.zh-CN.md)

A Chrome extension that turns videos into transcripts and study notes. It uses subtitles when available; otherwise it records the tab's audio while the video plays and transcribes it. Nothing is downloaded, so it isn't blocked by sites' anti-download measures.

## Features

- **Subtitles first** on Bilibili; otherwise records automatically and pauses the page when the video ends (blocks autoplay of the next video)
- **Speech-to-text** via any OpenAI-compatible cloud service, or any local Whisper service
- **Record several tabs at once** (up to 3 by default); transcriptions are queued one after another
- **Video frames** (optional): screenshots while recording, which a vision-capable notes model can refer to
- **Study notes** (optional) from any Chat Completions model, in concise / detailed / minutes styles
- **Local-first**: materials are stored only in your browser; only services you authorize receive data
- **English and Simplified Chinese** interface, following your browser language by default

Supported: Bilibili, YouTube, Douyin and other pages that play audio. Not supported: YouTube Shorts, players in iframes, DRM-protected content.

## Installation

1. Download `WatchVid4U-<version>.zip` from [Releases](https://github.com/lkdlcodyl/WatchVid4U/releases) and unzip it.
2. Open `chrome://extensions` and turn on "Developer mode".
3. Click "Load unpacked" and select the unzipped folder.
4. The settings page opens automatically.

Requires Chrome / Edge 116 or later.

## Setup

| You want | Configure |
|---|---|
| Bilibili videos with subtitles → transcript | Nothing |
| Recording + transcription | Settings → "Speech-to-text" |
| Study notes | Settings → "Notes model" |
| Notes that also use what's on screen | Settings → "Video frames" |

- **Cloud transcription**: pick a preset (e.g. Groq) or enter any OpenAI-compatible `/audio/transcriptions` address, paste your API key, then "Save & authorize".
- **Local transcription**: choose "Local service (optional)", enter the address (e.g. `http://127.0.0.1:8765`) and a model name, then "Test transcription". Use the [bundled backend](local-backend/README.md) or any compatible local service.
- **Language**: switch with the 🌐 中文 / English control at the top of the settings sidebar.

## Usage

Start from the toolbar popup, the floating panel on video pages, or a shortcut:

| Action | Shortcut |
|---|---|
| Start from the current position | `Alt+Shift+S` |
| Start from the beginning | `Alt+Shift+B` |
| Stop and save | `Alt+Shift+E` |
| Show/hide the floating panel | `Alt+Shift+F` |

Results appear on the "Materials & notes" page, where you can read, copy, export, and generate notes.

> The browser only allows recording on pages where you've clicked the toolbar icon or used a shortcut. If a page asks for permission, click the toolbar icon once.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Needs your permission to record" | Click the toolbar icon on that page, then "Authorize and continue recording". |
| "The service returned a web page" | The address probably lacks `/v1`; check the "Request URL" shown in settings. |
| HTTP 401/403 | Check the API key. For a local service, make sure the service at that address is the one you configured. |
| HTTP 413 | Lower "Max upload per request" under Advanced. |
| Notes fail with screenshots attached | The model doesn't support images; switch models or turn off sending screenshots. |

## Privacy

No project servers or analytics. Data goes only to the services you authorize, and only what each task needs. See [docs/PRIVACY.md](docs/PRIVACY.md).

## Development

No build step and no runtime dependencies. Tests need Python 3.10+ and Google Chrome.

```bash
python3 tests/run_unit.py
```

```bash
python3 tests/run_e2e.py
```

```bash
python3 tests/test_i18n.py
```

```bash
python3 scripts/package.py
```

English UI text lives in `extension/src/shared/i18n-en.js`; `tests/test_i18n.py` reports any missing translation.

## Notes

- Developed with AI assistance (Claude by Anthropic).
- For personal study and research. Follow each site's terms of service and respect creators' copyrights.

## License

[MIT](LICENSE) © 2026 lkdlcodyl
