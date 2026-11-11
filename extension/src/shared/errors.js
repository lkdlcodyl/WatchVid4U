// 统一错误：stage 标明失败环节，code 为稳定的安全标识，message 为给用户看的中文说明。
// diag 仅包含安全诊断（HTTP 状态、类型、长度），绝不包含 Key、Header、原始响应或私密正文。

export const STAGES = {
  detect: '识别视频',
  subtitle: '获取字幕',
  capture: '录音',
  playback: '网页播放控制',
  save: '保存材料',
  stt: '语音转写',
  local: '本地转写服务',
  llm: '生成笔记',
  settings: '设置',
  storage: '本地存储',
};

const MESSAGES = {
  // 通用网络
  network: '无法连接到服务（网络中断、地址错误或被浏览器拦截）。',
  timeout: '等待服务响应超时。',
  cancelled: '已取消本地等待（服务商可能仍在处理或计费）。',
  permission_missing: '尚未授予访问该服务地址的浏览器权限，请在设置中点击“授权并保存”。',
  consent_missing: '尚未同意向该服务发送数据，请在设置中确认授权。',
  key_missing: '尚未填写 API Key（或会话结束后已清除），请在设置中重新填写。',
  not_configured: '尚未配置该服务。',
  invalid_url: '服务地址无效：需要 https://（本地服务可用 http://127.0.0.1 或 http://localhost）。',
  http_auth: '服务拒绝了凭据（HTTP 401/403），请检查 Key 或账户权限。',
  local_http_auth: '本地服务拒绝了请求（HTTP 401/403）：它可能要求 API Key，或只允许特定来源访问。请确认该地址上运行的是你要用的服务，并在设置的“本地服务”中填写它的 Key。',
  local_network: '无法连接到本地服务，请确认它已启动，且地址和端口与设置一致。',
  local_not_found: '本地服务上找不到该接口或模型（HTTP 404），请检查本地服务地址（可填完整的 …/audio/transcriptions）与模型名。',
  local_bad_request: '本地服务拒绝了请求参数（HTTP 400/422），请检查模型名（不确定时可填 auto 或留空）。',
  http_not_found: '服务地址或模型不存在（HTTP 404），请检查地址与模型名。',
  http_too_large: '服务商拒绝：上传内容超过其大小限制（HTTP 413）。可在设置中降低“单次上传上限”。',
  http_rate_limit: '服务商限流或额度不足（HTTP 429），请稍后再试或检查额度。',
  http_bad_request: '服务拒绝了请求参数（HTTP 400），请检查模型名与响应格式设置。',
  http_server: '服务端出错（HTTP 5xx），请稍后重试。',
  http_other: '服务返回了非预期的 HTTP 状态。',
  html_response: '服务返回了网页而不是 API 数据，通常是地址填错（例如少了 /v1）或被网关拦截。',
  unexpected_stream: '服务返回了流式（SSE）响应，但本插件使用非流式请求；请确认该地址支持 stream=false。',
  body_read_failed: '读取服务响应正文时失败（连接中途断开）。',
  empty_response: '服务返回了空响应。',
  invalid_json: '服务响应不是有效的 JSON。',
  empty_content: '模型返回的内容为空。',
  incomplete_output: '模型输出被截断（达到长度上限），已保留旧笔记，未保存不完整结果。',
  unexpected_shape: '服务响应缺少预期字段。',
  empty_transcript: '转写结果为空（可能是静音或服务未识别出语音）。',
  // 本地限制
  local_too_large: '内容超过设置中的本地处理上限，已停止发送；可在设置中调整上限。',
  audio_missing: '音频已被清理或缺失，无法转写；已有文字仍可阅读和导出。',
  transcript_missing: '尚无可用逐字稿。',
  // 字幕
  sub_no_video_id: '无法从页面地址识别 B站视频编号。',
  sub_unsupported_page: '当前 B站页面类型暂不支持字幕获取。',
  sub_none: '该视频没有可用字幕。',
  sub_need_login: '该视频的字幕需要登录后才能获取（可在设置中允许使用当前浏览器的 B站登录状态）。',
  sub_policy_rejected: '可用字幕不符合你设置的采用策略。',
  sub_mismatch: '字幕接口返回的数据与当前视频/分P不一致，已拒绝使用以免串字幕。',
  sub_incomplete: '字幕覆盖时长明显短于视频时长，判定为不完整。',
  sub_empty: '字幕正文为空。',
  sub_bad_data: '字幕数据格式异常。',
  sub_access: '字幕接口访问失败或受限。',
  sub_identity_changed: '获取字幕期间页面已切换到其他视频。',
  sub_timeout: '获取字幕超时。',
  // 录音
  capture_not_invoked: '浏览器要求先通过工具栏图标或快捷键在本页启动一次扩展，才允许录制标签页声音（浮窗无法代替这一步）。',
  capture_failed: '无法开始录制标签页声音。',
  capture_busy: '该标签页已被其他程序或扩展录制。',
  media_not_found: '页面上找不到可控制的视频或音频。',
  play_blocked: '浏览器阻止了自动继续播放，请在网页上点一下播放（录音已就绪）。',
  target_lost: '目标视频已不可用（页面切换、换片或媒体异常）。',
  tab_closed: '来源标签页已关闭。',
  navigated: '页面已导航到其他内容。',
  media_error: '视频播放出错。',
  ad_wait_cancelled: '已取消等待广告结束。',
  task_busy: '已有一个任务正在进行。',
  // 存储
  quota: '本地存储空间不足。',
  db: '本地数据库操作失败。',
  unknown: '发生未预期的错误。',
};

export class AppError extends Error {
  constructor(code, { stage = null, detail = '', diag = null, cause } = {}) {
    super(MESSAGES[code] || MESSAGES.unknown);
    this.name = 'AppError';
    this.code = MESSAGES[code] ? code : 'unknown';
    this.stage = stage;
    this.detail = detail; // 额外的人类可读说明（不得包含秘密）
    this.diag = diag;
    if (cause) this.cause = cause;
  }
  toJSON() {
    return { code: this.code, stage: this.stage, message: this.message, detail: this.detail, diag: this.diag };
  }
}

export function messageFor(code) {
  return MESSAGES[code] || MESSAGES.unknown;
}

/** 把任意异常转为可序列化的安全错误对象 */
export function toSafeError(err, stage = null) {
  if (err instanceof AppError) {
    const j = err.toJSON();
    if (!j.stage) j.stage = stage;
    return j;
  }
  if (err && typeof err === 'object' && err.code && MESSAGES[err.code]) {
    return { code: err.code, stage: err.stage || stage, message: MESSAGES[err.code], detail: err.detail || '', diag: err.diag || null };
  }
  if (err && err.name === 'QuotaExceededError') return { code: 'quota', stage: stage || 'storage', message: MESSAGES.quota, detail: '', diag: null };
  return { code: 'unknown', stage, message: MESSAGES.unknown, detail: String(err && err.message ? err.message : err).slice(0, 200), diag: null };
}

export function describeError(e) {
  if (!e) return '';
  const st = e.stage && STAGES[e.stage] ? `【${STAGES[e.stage]}】` : '';
  return `${st}${e.message}${e.detail ? `（${e.detail}）` : ''}`;
}
