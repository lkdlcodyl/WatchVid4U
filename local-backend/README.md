# WatchVid4U 本地转写服务（可选）

用你电脑上已有的 Whisper 模型做转写，可选区分说话人。**使用云端 API 的用户不需要安装它。**

## 特点

- 服务本身只依赖 Python 3.10+ 标准库；推理依赖按需安装，彼此独立，不修改其他项目的环境。
- 只监听本机回环地址，默认只接受 `chrome-extension://` 来源（建议用 `--allow-origin chrome-extension://<你的扩展ID>` 进一步限定）。
- **绝不在运行时下载模型**（强制 `HF_HUB_OFFLINE=1` / `local_files_only`）。
- 一次只处理一个请求；处理完释放内存。

## 安装（任选一种引擎，建议放在独立虚拟环境中）

```bash
python3 -m venv ~/.venvs/wv4u && source ~/.venvs/wv4u/bin/activate
```

Apple Silicon（推荐）：

```bash
pip install mlx-whisper numpy
```

其他平台（CPU/NVIDIA）：

```bash
pip install faster-whisper numpy
```

可选说话人区分：

```bash
pip install pyannote.audio torch
```

## 准备模型（只使用你本地已有的）

- **mlx-whisper**：若 `~/.cache/huggingface/hub/` 下已有 `models--mlx-community--whisper-*`，服务会自动复用（优先 large-v3-turbo → large-v3 → …）。也可用 `--model /path/to/model` 指定目录。
- **faster-whisper**：用 `--model /path/to/ctranslate2-model` 指定已转换的模型目录，或已在缓存中的模型名（如 `large-v3`）。
- **pyannote**（可选）：用 `--diarization-model /path/to/pipeline/config.yaml` 指定本地流水线配置（其中引用的子模型也必须在本地）。

如需下载模型，请你自己在服务之外有意识地完成（例如用 `huggingface-cli download`），服务不会代劳。

## 启动

```bash
python3 local-backend/server.py --port 8765
```

示例（指定扩展来源与说话人模型）：

```bash
python3 local-backend/server.py --port 8765 --allow-origin chrome-extension://<扩展ID> --diarization-model ~/models/pyannote-3.1/config.yaml
```

启动后在扩展：设置 → 语音转写 → 「本地服务」→ 地址 `http://127.0.0.1:8765` → 「保存并授权」→ 「测试转写」。

## 接口

- `GET /health` → `{engine, model, diarization, note, maxUploadMB}`
- `POST /v1/audio/transcriptions`（multipart：`file`=16-bit PCM WAV，`language`，`prompt`，`response_format`=`json|verbose_json|text`，`diarize`=`true|false`）
  - `verbose_json` 返回 `segments[{start,end,text,avg_logprob,no_speech_prob,compression_ratio,speaker}]` 与 `speakers{count,reliable,error}`。
  - 说话人：段落与某位说话人重叠 ≥60% 才归属，否则为 `null`（不猜）；有效说话人 ≥2 且 ≥80% 的段落有归属才标记为可靠。

## 测试

```bash
python3 tests/test_local_backend.py
```

该测试使用 `--engine fake`，只验证协议、来源校验与说话人对齐逻辑，**不代表真实识别质量**。

## 选项

| 参数 | 说明 |
|---|---|
| `--port` | 端口，默认 8765 |
| `--engine` | `auto`（默认）/ `mlx` / `faster` |
| `--model` | 模型目录或已缓存模型名 |
| `--diarization-model` | pyannote 本地流水线 |
| `--allow-origin` | 只允许的来源 |
| `--max-mb` | 单次上传上限，默认 2048 |
| `--verbose` | 输出调试日志（不含音频与文本内容） |
