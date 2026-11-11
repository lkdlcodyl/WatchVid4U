// B站字幕：发现、选择、核对与解析。网络传输由调用方注入（在页面同源上下文中发起，不伪造来源/签名）。
import { AppError } from './errors.js';

const API = 'https://api.bilibili.com';

export function parseBiliUrl(href) {
  let u;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (!/(^|\.)bilibili\.com$/.test(u.hostname)) return null;
  const m = u.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10}|av\d+)\/?/i);
  if (m) {
    const id = m[1];
    const p = Math.max(1, parseInt(u.searchParams.get('p') || '1', 10) || 1);
    if (/^av/i.test(id)) return { kind: 'video', aid: id.slice(2), bvid: null, p };
    return { kind: 'video', bvid: id, aid: null, p };
  }
  if (/^\/(bangumi|cheese)\//.test(u.pathname)) return { kind: 'unsupported' };
  if (/^\/list\//.test(u.pathname)) {
    const bvid = u.searchParams.get('bvid');
    if (bvid && /^BV[0-9A-Za-z]{10}$/.test(bvid)) return { kind: 'video', bvid, aid: null, p: Math.max(1, parseInt(u.searchParams.get('p') || '1', 10) || 1) };
    return { kind: 'unsupported' };
  }
  return null;
}

export function biliVideoKey(href) {
  const v = parseBiliUrl(href);
  if (!v || v.kind !== 'video') return null;
  return `bili:${v.bvid || 'av' + v.aid}:p${v.p}`;
}

export function viewUrl(v) {
  return v.bvid ? `${API}/x/web-interface/view?bvid=${encodeURIComponent(v.bvid)}` : `${API}/x/web-interface/view?aid=${encodeURIComponent(v.aid)}`;
}

export function playerUrls(aid, cid, bvid) {
  const q = `aid=${encodeURIComponent(aid)}&cid=${encodeURIComponent(cid)}${bvid ? `&bvid=${encodeURIComponent(bvid)}` : ''}`;
  return [`${API}/x/player/wbi/v2?${q}`, `${API}/x/player/v2?${q}`];
}

/** 只允许访问 B站接口与字幕文件域名 */
export function isAllowedBiliUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    return u.hostname === 'api.bilibili.com' || /(^|\.)hdslb\.com$/.test(u.hostname) || u.hostname === 'aisubtitle.hdslb.com';
  } catch {
    return false;
  }
}

function apiCodeError(code, j) {
  if (code === -101 || code === -111) return new AppError('sub_need_login', { stage: 'subtitle', diag: { api: code } });
  if (code === -403 || code === -352 || code === -412 || code === 62002 || code === 62012) return new AppError('sub_access', { stage: 'subtitle', diag: { api: code } });
  if (code === -404 || code === 62004) return new AppError('sub_access', { stage: 'subtitle', detail: '视频不存在或不可见', diag: { api: code } });
  return new AppError('sub_access', { stage: 'subtitle', diag: { api: code, msg: typeof j?.message === 'string' ? j.message.slice(0, 40) : '' } });
}

/** 从 view 接口数据中选出当前分P */
export function pickPage(view, v) {
  if (!view || typeof view !== 'object') throw new AppError('sub_bad_data', { stage: 'subtitle' });
  if (v.bvid && view.bvid && view.bvid.toLowerCase() !== v.bvid.toLowerCase()) throw new AppError('sub_mismatch', { stage: 'subtitle', detail: '视频编号不一致' });
  if (v.aid && view.aid && String(view.aid) !== String(v.aid)) throw new AppError('sub_mismatch', { stage: 'subtitle', detail: '视频编号不一致' });
  const pages = Array.isArray(view.pages) ? view.pages : [];
  const page = pages.find((x) => x.page === v.p) || (v.p === 1 ? pages[0] || { cid: view.cid, duration: view.duration, page: 1, part: view.title } : null);
  if (!page || !page.cid) throw new AppError('sub_bad_data', { stage: 'subtitle', detail: '找不到对应分P' });
  return { aid: view.aid, bvid: view.bvid, cid: page.cid, duration: page.duration || view.duration || 0, part: page.part || '', title: view.title || '' };
}

export function classifyTrack(t) {
  const lan = String(t.lan || '');
  if (/^ai-/i.test(lan) || (typeof t.ai_type === 'number' && t.ai_type > 0) || t.type === 1) return 'auto';
  if (t.type === 0 && (t.ai_type === 0 || t.ai_type === undefined) && !/^ai-/i.test(lan) && typeof t.type === 'number') return 'manual';
  return 'unknown';
}

export function isChineseLan(lan) {
  return /^(ai-)?(zh|cmn)([-_]|$)/i.test(String(lan || ''));
}

export const KIND_LABELS = { manual: '人工字幕', auto: '自动生成字幕', unknown: '来源未知字幕' };

/** 校验 player 接口返回与当前视频一致，提取字幕轨道 */
export function extractTracks(player, expect) {
  if (!player || typeof player !== 'object') throw new AppError('sub_bad_data', { stage: 'subtitle' });
  if (player.cid && String(player.cid) !== String(expect.cid)) throw new AppError('sub_mismatch', { stage: 'subtitle', detail: '分P编号不一致' });
  if (player.aid && expect.aid && String(player.aid) !== String(expect.aid)) throw new AppError('sub_mismatch', { stage: 'subtitle', detail: '视频编号不一致' });
  if (player.bvid && expect.bvid && player.bvid.toLowerCase() !== expect.bvid.toLowerCase()) throw new AppError('sub_mismatch', { stage: 'subtitle', detail: '视频编号不一致' });
  const list = player.subtitle && Array.isArray(player.subtitle.subtitles) ? player.subtitle.subtitles : [];
  const tracks = list
    .filter((t) => t && typeof t === 'object')
    .map((t) => ({
      id: String(t.id_str || t.id || ''),
      lan: String(t.lan || ''),
      lanDoc: String(t.lan_doc || t.lan || ''),
      url: normalizeSubUrl(t.subtitle_url),
      kind: classifyTrack(t),
      rawType: { type: t.type, ai_type: t.ai_type, ai_status: t.ai_status },
    }));
  return { tracks, needLogin: !!player.need_login_subtitle };
}

export function normalizeSubUrl(s) {
  if (!s || typeof s !== 'string') return '';
  if (s.startsWith('//')) return 'https:' + s;
  if (s.startsWith('http://')) return 'https://' + s.slice(7);
  return s;
}

/**
 * 按设置策略选轨道：中文优先；人工 > 自动 > 未知；非中文只有在允许时才用。
 * 返回 {track} 或抛出说明原因的错误
 */
export function chooseTrack(tracks, policy) {
  if (!tracks.length) throw new AppError('sub_none', { stage: 'subtitle' });
  const rankKind = { manual: 0, auto: 1, unknown: 2 };
  const allowedKind = (k) => k === 'manual' || (k === 'auto' && policy.acceptAuto) || (k === 'unknown' && policy.acceptUnknown);
  const zhPref = (lan) => (/^(ai-)?zh[-_]?(cn|hans)$/i.test(lan) || /^(ai-)?zh$/i.test(lan) ? 0 : 1);
  const candidates = tracks
    .filter((t) => t.url)
    .filter((t) => isChineseLan(t.lan) || policy.allowNonChinese)
    .filter((t) => allowedKind(t.kind))
    .sort((a, b) => (isChineseLan(a.lan) ? 0 : 1) - (isChineseLan(b.lan) ? 0 : 1) || rankKind[a.kind] - rankKind[b.kind] || zhPref(a.lan) - zhPref(b.lan));
  if (candidates.length) return candidates[0];
  if (tracks.every((t) => !t.url)) throw new AppError('sub_need_login', { stage: 'subtitle', detail: '接口未返回字幕文件地址' });
  const reasons = [];
  if (!policy.allowNonChinese && !tracks.some((t) => isChineseLan(t.lan))) reasons.push('只有非中文字幕');
  if (!policy.acceptAuto && tracks.some((t) => t.kind === 'auto')) reasons.push('不采用自动生成字幕');
  if (!policy.acceptUnknown && tracks.some((t) => t.kind === 'unknown')) reasons.push('不采用来源未知字幕');
  throw new AppError('sub_policy_rejected', { stage: 'subtitle', detail: reasons.join('，') });
}

/** 解析字幕正文并核对完整性 */
export function parseSubtitleBody(json, durationSec) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.body)) throw new AppError('sub_bad_data', { stage: 'subtitle' });
  const lines = [];
  for (const it of json.body) {
    if (!it || typeof it.content !== 'string') continue;
    const from = Number(it.from);
    const to = Number(it.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) throw new AppError('sub_bad_data', { stage: 'subtitle', detail: '时间轴异常' });
    const content = it.content.replace(/\s+/g, ' ').trim();
    if (content) lines.push({ from, to, content });
  }
  if (!lines.length) throw new AppError('sub_empty', { stage: 'subtitle' });
  lines.sort((a, b) => a.from - b.from);
  const lastTo = lines[lines.length - 1].to;
  if (durationSec > 0) {
    if (lastTo > durationSec + 15 || lines[0].from > durationSec) throw new AppError('sub_mismatch', { stage: 'subtitle', detail: '字幕时间超出视频时长' });
    const coverage = lastTo / durationSec;
    if (coverage < 0.6 && durationSec - lastTo > 90) throw new AppError('sub_incomplete', { stage: 'subtitle', detail: `字幕约覆盖 ${Math.round(coverage * 100)}%` });
  }
  return { lines, lastTo };
}

/** 字幕 → 可读逐字稿：按停顿分段，段内以空格分隔原始字幕行（不臆造标点） */
export function subtitleText(lines) {
  const paras = [];
  let cur = [];
  let prevTo = null;
  let len = 0;
  for (const l of lines) {
    if (cur.length && ((prevTo != null && l.from - prevTo > 1.6) || len > 360)) {
      paras.push(cur.join(' '));
      cur = [];
      len = 0;
    }
    cur.push(l.content);
    len += l.content.length;
    prevTo = l.to;
  }
  if (cur.length) paras.push(cur.join(' '));
  return paras.join('\n\n');
}

/**
 * 完整获取流程。fetchJson(url) 由调用方提供（在 B站页面上下文中发起）。
 * checkIdentity() 在关键步骤后调用，若页面已换片则抛错。
 */
export async function fetchBiliSubtitle({ href, fetchJson, policy, checkIdentity }) {
  const v = parseBiliUrl(href);
  if (!v) throw new AppError('sub_no_video_id', { stage: 'subtitle' });
  if (v.kind !== 'video') throw new AppError('sub_unsupported_page', { stage: 'subtitle' });
  const vj = await fetchJson(viewUrl(v));
  if (!vj || typeof vj !== 'object') throw new AppError('sub_bad_data', { stage: 'subtitle' });
  if (vj.code !== 0) throw apiCodeError(vj.code, vj);
  const page = pickPage(vj.data, v);
  await checkIdentity();
  let lastErr = null;
  let tracksInfo = null;
  for (const url of playerUrls(page.aid, page.cid, page.bvid)) {
    try {
      const pj = await fetchJson(url);
      if (!pj || typeof pj !== 'object') throw new AppError('sub_bad_data', { stage: 'subtitle' });
      if (pj.code !== 0) throw apiCodeError(pj.code, pj);
      tracksInfo = extractTracks(pj.data, page);
      if (tracksInfo.tracks.length || url.includes('/x/player/v2')) break;
    } catch (e) {
      lastErr = e;
      if (e.code === 'sub_mismatch') throw e;
    }
  }
  if (!tracksInfo) throw lastErr || new AppError('sub_access', { stage: 'subtitle' });
  if (!tracksInfo.tracks.length) {
    if (tracksInfo.needLogin && !policy.useLogin) throw new AppError('sub_need_login', { stage: 'subtitle' });
    throw new AppError('sub_none', { stage: 'subtitle' });
  }
  const track = chooseTrack(tracksInfo.tracks, policy);
  const body = await fetchJson(track.url);
  await checkIdentity();
  const parsed = parseSubtitleBody(body, page.duration);
  return {
    video: { bvid: page.bvid, aid: page.aid, cid: page.cid, p: v.p, duration: page.duration, title: page.title, part: page.part },
    track: { id: track.id, lan: track.lan, lanDoc: track.lanDoc, kind: track.kind, rawType: track.rawType },
    availableTracks: tracksInfo.tracks.map((t) => ({ lan: t.lan, lanDoc: t.lanDoc, kind: t.kind })),
    lines: parsed.lines,
    lastTo: parsed.lastTo,
    text: subtitleText(parsed.lines),
    raw: body,
  };
}
