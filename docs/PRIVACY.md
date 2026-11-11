# WatchVid4U Privacy Policy / 隐私说明

[English](#english) | [简体中文](#简体中文)

---

## English

**In short:** WatchVid4U has no project servers and no analytics. Your materials stay in your browser. Data is sent only to the transcription and notes services that you configure and explicitly authorize, and only what each task needs.

### Limited Use

The use of information received through WatchVid4U adheres to the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), including the Limited Use requirements. WatchVid4U collects and uses data only to provide its single purpose (turning videos you watch into transcripts and study notes). It does not sell user data, does not transfer it to advertising platforms or data brokers, does not use it for advertising or creditworthiness purposes, and no one at the project reads your data.

### Data stored on your device

| Data | Where | Removed when |
|---|---|---|
| Recordings (16 kHz mono PCM chunks), transcripts, notes, original subtitles | The extension's own IndexedDB | You delete them on the materials page; when audio exceeds about 1 GB, the oldest transcribed audio is cleaned up automatically (text is kept) |
| Screenshots taken while recording (only if "Video frames → Screenshots while recording" is on; downscaled JPEG) | The extension's own IndexedDB | You delete the material |
| Settings (no keys) | `chrome.storage.local` | The extension is uninstalled |
| API keys (default: "Remember key on this device") | The extension's own IndexedDB, **unencrypted** | You click "Clear key" or change the service address |
| API keys (when "Remember key" is off) | `chrome.storage.session` (this browser session only; not readable by content scripts) | The browser closes, you click "Clear key", or change the service address |
| YouTube diagnostics (off by default) | `chrome.storage.local`, at most 300 entries; states, times and positions only, no titles or URLs | Settings → Diagnostics → Clear |

Recordings can be played back inside the extension but are not offered for download.

### Data sent off your device

| Recipient | When | What is sent | Never sent |
|---|---|---|---|
| The **transcription service** you configure and authorize | After a recording ends (automatically or when you click) | The current recording's audio (long audio in slices), model name, language, punctuation prompt, a little text from the end of the previous slice | Titles, URLs, accounts, cookies, other materials |
| The **notes service** you configure and authorize | When generating notes | The material's effective transcript and fixed prompts; only if you separately enable and confirm "When generating notes, send screenshots to the notes model for reference", a few screenshots picked over time (none from ad periods) | Same as above, plus audio |
| Bilibili (`api.bilibili.com`, `*.hdslb.com`) | Fetching subtitles for a Bilibili task | Ordinary API requests made from the Bilibili page itself (the same as the page's own requests). Your login state is included only if you allow it in settings | The extension never reads, copies or stores cookies |
| Connection tests | When you click "Test connection" / "Test transcription" | A fixed test tone (1.5 s) or one fixed test message | Any of your recordings or text |

Authorization is tied to "recipient address + purpose" ("send screenshots to the notes model" is a separate authorization). Changing the key or model doesn't require confirming again; changing the address does, and an old key is never sent to a new address. Revoking authorization, clearing keys and deleting materials are independent of each other.

### What WatchVid4U never does

- No yt-dlp, no video downloads, no reading cookie values, no extra credentials, no forged logins, signatures or origins, no bypassing DRM or site access restrictions.
- Web pages can't use the extension to read materials or keys, or make it access arbitrary addresses. Only the tab where you start a task is recorded.
- No remote code. User text and model output are shown as plain text / safe Markdown; scripts, HTML and instructions in them are never executed.

### Optional local backend

Listens only on `127.0.0.1` and by default only accepts `chrome-extension://` origins; doesn't log request contents; never downloads models; temporary data is released after each request.

### Contact

Questions or concerns: open an issue at <https://github.com/lkdlcodyl/WatchVid4U/issues>.

---

## 简体中文

**一句话**：没有项目方服务器，也没有统计。你的材料只保存在你的浏览器里；只有你配置并明确授权的转写/笔记服务会收到数据，而且只收到完成这件事所需的最少内容。

### 有限使用声明（Limited Use）

WatchVid4U 对所获信息的使用遵守 [Chrome 应用店用户数据政策](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)，包括其中的“有限使用”要求。WatchVid4U 只为实现其单一用途（把你观看的视频整理为逐字稿与学习笔记）而收集和使用数据；不出售用户数据，不转交给广告平台或数据经纪商，不用于广告或信用评估，项目方的任何人都不会查看你的数据。

### 保存在本机的数据

| 数据 | 位置 | 何时删除 |
|---|---|---|
| 录音（16 kHz 单声道 PCM 分块）、逐字稿、笔记、原始字幕 | 扩展专属 IndexedDB | 你在材料页删除；音频超出约 1 GB 缓存时，最旧的已转写音频会被自动清理（文字保留） |
| 录制时的截图（仅在开启“视频画面 → 录制时截图”时；缩小后的 JPEG） | 扩展专属 IndexedDB | 你在材料页删除该材料 |
| 设置（不含 Key） | `chrome.storage.local` | 卸载扩展 |
| API Key（默认：“在本机记住”） | 扩展专属 IndexedDB，**未加密** | 点击“清除 Key”或更换服务地址 |
| API Key（取消“在本机记住”时） | `chrome.storage.session`（仅本次浏览器会话，内容脚本不可读） | 关闭浏览器、点击“清除 Key”、或更换服务地址 |
| YouTube 诊断记录（默认关闭） | `chrome.storage.local`，最多 300 条，只有状态/时间/进度，不含标题和网址 | 设置 → 诊断 → 清除 |

录音只能在插件内试听，不提供下载。

### 发送到外部的数据

| 接收方 | 何时 | 发送内容 | 不发送 |
|---|---|---|---|
| 你配置并授权的**转写服务** | 录音结束后（自动或你手动点击） | 当前录音音频（长音频分片发送）、模型名、语言、标点引导文字、前一分片末尾少量文字 | 标题、网址、账号、Cookie、其他材料 |
| 你配置并授权的**笔记服务** | 生成笔记时 | 当前材料的有效逐字稿与固定提示词；只有你另外开启并确认“生成笔记时，把截图发给笔记模型参考”时，还会发送按时间挑选的少量截图（不含广告时段） | 同上，以及音频 |
| B站（`api.bilibili.com`、`*.hdslb.com`） | B站任务的字幕获取 | 由 B站页面本身发起的普通接口请求（与网页自身行为相同）。只有你在设置中允许后才带上登录状态 | 插件不读取、复制或保存 Cookie |
| 连接测试 | 你点击“测试连接”或“测试转写”时 | 固定测试音（1.5 秒）或一句固定测试消息 | 你的任何录音或文字 |

授权绑定在“接收地址 + 用途”上（“把截图发给笔记模型”是单独的一项授权）：换 Key 或模型不需要重新确认；换地址需要重新确认，且旧 Key 不会被发往新地址。撤销授权、清除 Key、删除材料三者互相独立。

### 不会做的事

- 不使用 yt-dlp，不下载视频，不读取 Cookie 值，不获取额外凭据，不伪造登录、签名或来源，不绕过 DRM 或站点访问限制。
- 网页无法通过插件读取材料、Key，或让插件访问任意地址；只录制你启动任务的那个标签页。
- 不运行远程代码；用户文字与模型输出一律作为纯文本/安全 Markdown 显示，不执行其中的脚本、HTML 或指令。

### 本地后端（可选）

只监听 `127.0.0.1`，默认只接受 `chrome-extension://` 来源；不记录请求内容；不联网下载模型；临时数据在请求结束后释放。

### 联系方式

有疑问或顾虑，请在 <https://github.com/lkdlcodyl/WatchVid4U/issues> 提交 issue。
