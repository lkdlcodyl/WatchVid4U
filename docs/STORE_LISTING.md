# Chrome Web Store listing / 应用店上架资料

Text to paste into the Chrome Web Store developer dashboard. Wording avoids anything that reads as bypassing site protections or downloading media.
上架时粘贴到 Chrome 应用店开发者后台的文案。措辞刻意避免“绕过网站保护”或“下载媒体”的含义。

---

## English

### Name
WatchVid4U · Video transcripts & notes

### Short description (≤132 characters)
Transcripts and study notes for the videos you watch: subtitles first, otherwise speech-to-text via your own API or local Whisper.

### Detailed description
WatchVid4U turns the videos you watch into readable transcripts and study notes.

• Subtitles first: on Bilibili, the full subtitle track is saved as the transcript when available.
• Speech-to-text: for videos without usable subtitles, the extension transcribes the audio of the tab you're watching, using the transcription service you choose (any OpenAI-compatible API, or a Whisper service running on your own computer).
• Study notes: optionally summarize the transcript with any Chat Completions model, in concise, detailed or minutes style.
• Optional screenshots: let a vision-capable notes model refer to slides, charts and on-screen demos.
• Works on several tabs at once, with transcriptions queued one after another.
• Pauses the page when the video ends so the next video doesn't autoplay.
• English and Simplified Chinese interface.

Privacy: there are no project servers and no analytics. Materials are stored only in your browser. Data is sent only to services you configure and explicitly authorize. The extension does not download videos, does not provide audio files for download, and does not bypass logins, paywalls or DRM.

Bring your own API key; no shared keys are included. Open source (MIT): https://github.com/lkdlcodyl/WatchVid4U

### Single purpose
Create transcripts and study notes for videos the user is watching in the browser.

### Permission justifications
| Permission | Justification |
|---|---|
| `tabCapture` | Captures the audio (and, only if the user enables it, periodic screenshots) of the tab where the user starts a task, to produce a transcript. Only started by an explicit user action on that tab. |
| `offscreen` | Runs audio processing and transcription requests in an offscreen document so they continue when the popup is closed. |
| `activeTab` | Accesses the current tab only after the user clicks the toolbar icon or uses a shortcut, to start a task on that page. |
| `scripting` | Injects the extension's own content script into the current page (after the user starts a task) to find the video element, pause it at the end and show progress. No remote code. |
| `storage` | Stores settings and task state. |
| `unlimitedStorage` | Stores recordings, transcripts and notes locally until the transcript is ready; long videos can exceed the default quota. |
| `notifications` | Tells the user when a transcript or notes are ready, or when a task fails. Can be turned off. |
| Optional host permissions (`https://*/*`, `http://127.0.0.1/*`, `http://localhost/*`) | Requested at runtime only for the single transcription / notes service address the user enters, so the extension can send requests to it. Never requested at install time. |
| Content scripts on bilibili.com, youtube.com, douyin.com | Detect the video, pause at the end, prevent autoplay of the next video, and show the optional floating panel. |

### Data usage disclosures (dashboard "Privacy" tab)
- Collected: **Website content** (audio and, if enabled, screenshots of the tab the user starts a task on; subtitles on Bilibili). Used only to create the user's transcript and notes; sent only to the services the user configures.
- Not collected: personally identifiable information, health, financial, authentication information, personal communications, location, web history, user activity.
- Certify: not sold to third parties; not used or transferred for purposes unrelated to the single purpose; not used to determine creditworthiness or for lending.
- Privacy policy URL: https://github.com/lkdlcodyl/WatchVid4U/blob/main/docs/PRIVACY.md

### Notes for reviewers
The extension never downloads video or audio files and offers no media export; recordings are kept locally only to produce the transcript and can be played back inside the extension. YouTube ads are only detected so that they are excluded from the transcript; they are not blocked or skipped. Optional Bilibili login use: subtitle requests are made by the Bilibili page itself; the extension never reads cookie values.

---

## 简体中文

### 名称
WatchVid4U · 帮你看视频

### 简短描述（不超过 132 个字符）
为你正在观看的视频生成逐字稿与学习笔记：优先使用字幕，否则用你自己的 API 或本地 Whisper 转写。

### 详细描述
WatchVid4U 把你正在观看的视频整理成可阅读的逐字稿和学习笔记。

• 字幕优先：在 B站有完整字幕时，直接保存为逐字稿。
• 语音转写：没有可用字幕时，转写你正在观看的标签页的声音，使用你选择的转写服务（任意 OpenAI 兼容 API，或运行在你电脑上的 Whisper 服务）。
• 学习笔记：可选用任意 Chat Completions 模型整理笔记，提供精简、详细、纪要三种风格。
• 视频画面（可选）：让支持图片的笔记模型参考幻灯片、图表和屏幕操作。
• 支持多个标签页同时处理，转写依次排队。
• 视频播完自动暂停，避免自动播放下一条。
• 中英文界面。

隐私：没有项目方服务器，也没有统计。材料只保存在你的浏览器里，数据只发给你配置并明确授权的服务。插件不下载视频，不提供音频文件下载，不绕过登录、付费墙或 DRM。

需要使用你自己的 API Key，插件不内置任何共享 Key。开源（MIT）：https://github.com/lkdlcodyl/WatchVid4U

### 单一用途
为用户在浏览器中观看的视频生成逐字稿与学习笔记。

### 权限说明
| 权限 | 用途 |
|---|---|
| `tabCapture` | 录制用户启动任务的那个标签页的声音（仅在用户开启时，另外定时截图），用于生成逐字稿。只在用户于该页面主动操作后开始。 |
| `offscreen` | 在后台文档中处理音频和转写请求，关闭弹窗后任务仍能继续。 |
| `activeTab` | 只在用户点击工具栏图标或按快捷键后访问当前标签页，用于在该页面开始任务。 |
| `scripting` | 用户开始任务后，向当前页面注入插件自带的内容脚本，用于找到视频、播完时暂停并显示进度。不运行远程代码。 |
| `storage` | 保存设置和任务状态。 |
| `unlimitedStorage` | 在逐字稿生成前把录音、逐字稿和笔记保存在本机；长视频可能超出默认存储配额。 |
| `notifications` | 逐字稿或笔记完成、任务失败时通知用户，可关闭。 |
| 可选主机权限（`https://*/*`、`http://127.0.0.1/*`、`http://localhost/*`） | 只在用户填写某个转写/笔记服务地址后，针对这一个地址在运行时申请，用于向它发送请求；安装时不申请。 |
| B站、YouTube、抖音上的内容脚本 | 识别视频、播完暂停、阻止自动播放下一条，并显示可选的浮窗。 |

### 数据使用披露（后台“隐私”页）
- 收集：**网站内容**（用户启动任务的标签页的声音；开启时的截图；B站字幕）。只用于生成用户自己的逐字稿和笔记，只发给用户配置的服务。
- 不收集：个人身份信息、健康、财务、身份验证信息、个人通讯、位置、浏览历史、用户活动。
- 声明：不出售给第三方；不用于与单一用途无关的目的；不用于信用评估或贷款。
- 隐私政策链接：https://github.com/lkdlcodyl/WatchVid4U/blob/main/docs/PRIVACY.md

### 给审核员的说明
插件不下载视频或音频文件，也不提供任何媒体导出；录音只在本机保存，用于生成逐字稿，可在插件内试听。YouTube 广告只用于识别并排除在逐字稿之外，不屏蔽、不跳过。可选的 B站登录状态：字幕请求由 B站页面自身发起，插件从不读取 Cookie 值。
