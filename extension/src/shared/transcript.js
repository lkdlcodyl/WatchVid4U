// 逐字稿合成：分片结果 → 普通稿 / 说话人分段稿 → 唯一“有效逐字稿”。
import { joinTexts } from './stt.js';

const PARA_GAP_SEC = 2.0;
const PARA_MAX_CHARS = 420;

/**
 * slices: [{index, offsetSec, text, segments|null}]（segments 的时间相对于本片）
 * 返回 {plain, segments(绝对时间)}
 */
export function mergeSlices(slices) {
  const ordered = [...slices].sort((a, b) => a.index - b.index);
  const allSegs = [];
  const paras = [];
  let cur = [];
  let curLen = 0;
  let lastEnd = null;
  let anySegments = false;
  for (const s of ordered) {
    if (s.segments && s.segments.length) {
      anySegments = true;
      for (const seg of s.segments) {
        const abs = { ...seg, start: seg.start + s.offsetSec, end: seg.end + s.offsetSec };
        allSegs.push(abs);
        const t = seg.text.trim();
        if (!t) continue;
        const gap = lastEnd == null ? 0 : abs.start - lastEnd;
        if (cur.length && (gap >= PARA_GAP_SEC || curLen >= PARA_MAX_CHARS)) {
          paras.push(joinTexts(cur));
          cur = [];
          curLen = 0;
        }
        cur.push(t);
        curLen += t.length;
        lastEnd = abs.end;
      }
    } else if ((s.text || '').trim()) {
      if (cur.length) {
        paras.push(joinTexts(cur));
        cur = [];
        curLen = 0;
      }
      paras.push(...splitLongText(s.text.trim()));
      lastEnd = null;
    }
  }
  if (cur.length) paras.push(joinTexts(cur));
  return { plain: paras.join('\n\n'), segments: anySegments ? allSegs : null };
}

/** 无时间戳的长文本按句末标点切成适合阅读的段落 */
export function splitLongText(text) {
  if (text.length <= PARA_MAX_CHARS) return [text];
  const sentences = text.match(/[^。！？!?；;\n]+[。！？!?；;]?/g) || [text];
  const out = [];
  let buf = '';
  for (const s of sentences) {
    if ((buf + s).length > PARA_MAX_CHARS && buf) {
      out.push(buf.trim());
      buf = '';
    }
    buf += s;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/**
 * 说话人分段稿：只有可靠且多人时才生成；无法确认归属的段落标注“未确认”，不猜。
 * speakersInfo: {count, reliable}
 */
export function buildSpeakerTranscript(segments, speakersInfo) {
  if (!segments || !speakersInfo || !speakersInfo.reliable || !(speakersInfo.count >= 2)) return null;
  const labelMap = new Map();
  const letter = (raw) => {
    if (!labelMap.has(raw)) labelMap.set(raw, String.fromCharCode(65 + labelMap.size));
    return labelMap.get(raw);
  };
  const blocks = [];
  for (const seg of segments) {
    const t = seg.text.trim();
    if (!t) continue;
    const who = seg.speaker == null ? '?' : letter(seg.speaker);
    const last = blocks[blocks.length - 1];
    if (last && last.who === who) last.parts.push(t);
    else blocks.push({ who, parts: [t] });
  }
  if (labelMap.size < 2) return null;
  return blocks.map((b) => `${b.who === '?' ? '【说话人未确认】' : `【说话人 ${b.who}】`}${joinTexts(b.parts)}`).join('\n\n');
}

/** 组装保存到材料上的逐字稿对象 */
export function composeTranscript({ plain, speaker, source, model, segments, droppedSegments = 0, sliceCount = 1, sttMeta = null }) {
  const kind = speaker ? 'speaker' : 'plain';
  return {
    plain,
    speaker: speaker || null,
    kind,
    effective: speaker || plain,
    source, // subtitle | stt
    model: model || null,
    segments: segments ? segments.map((s) => ({ s: round2(s.start), e: round2(s.end), t: s.text, k: s.speaker ?? undefined })) : null,
    droppedSegments,
    sliceCount,
    sttMeta,
    createdAt: Date.now(),
  };
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

/** 有效逐字稿：显示、复制、TXT、导出和 LLM 都用这一份 */
export function effectiveText(material) {
  return material?.transcript?.effective || '';
}

/**
 * 给 LLM 的材料：若录音期间检测到 YouTube 平台广告时段，且有分段时间戳，
 * 在对应段落前后插入标记作为“检测证据”。不修改保存的逐字稿。
 * 返回 {text, adEvidence:boolean}
 */
export function textForLlm(material, { timestamps = false } = {}) {
  const tr = material.transcript;
  const ads = material.audio?.adIntervals || [];
  if (!tr || !tr.segments || tr.kind === 'speaker' || (!ads.length && !timestamps)) return { text: tr ? tr.effective : '', adEvidence: false, timed: false };
  const inAd = (s, e) => ads.some(([a, b]) => Math.min(e, b) - Math.max(s, a) > 0.5 * Math.max(0.1, e - s));
  const lines = [];
  let state = false;
  let marked = false;
  let lastMark = -Infinity;
  for (const seg of tr.segments) {
    const ad = inAd(seg.s, seg.e);
    // 附带画面时：约每 30 秒插入一次时间标记，便于模型把画面与讲解对应起来
    if (timestamps && seg.s - lastMark >= 30) {
      lines.push(`\n[${fmtClock(seg.s)}] `);
      lastMark = seg.s;
    }
    if (ad && !state) {
      lines.push('\n[平台插播广告时段开始（播放器检测）]');
      marked = true;
    }
    if (!ad && state) lines.push('[平台插播广告时段结束]\n');
    state = ad;
    lines.push(seg.t.trim());
  }
  if (state) lines.push('[平台插播广告时段结束]');
  return { text: lines.join('').trim(), adEvidence: marked, timed: timestamps };
}

function fmtClock(sec) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
