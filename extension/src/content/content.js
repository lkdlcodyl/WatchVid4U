// 内容脚本：页面代理（定位/控制视频、结束判定、播完暂停保护、B站字幕请求）+ 网页浮窗与站内单键。
// 只响应来自本扩展的消息；网页脚本无法向这里发消息，也无法读取材料或 Key。
(function () {
  'use strict';
  if (window.__wv4uLoaded) return;
  window.__wv4uLoaded = true;

  const D = globalThis.WV4U_DETECT;
  const platform = D.platformOf(location.href);
  const now = () => Date.now();

  let userGestureAt = 0;
  let target = null;
  let armed = null; // 录音进行中的目标状态
  let guard = null; // 播完后的暂停保护
  let prepareAbort = null;
  let lastTask = null;
  let settings = null;

  // ---------- 用户操作跟踪（区分用户主动播放与网页脚本自动播放） ----------
  const markGesture = (e) => {
    if (e.isTrusted) userGestureAt = now();
  };
  ['pointerdown', 'mousedown', 'keydown', 'touchstart'].forEach((t) => window.addEventListener(t, markGesture, true));

  // ---------- 捕获阶段拦截：正文结束时阻止网站收到 ended（防止自动下一条） ----------
  window.addEventListener(
    'ended',
    (e) => {
      const el = e.target;
      if (!(el instanceof HTMLMediaElement)) return;
      if (armed && el === target) {
        const verdict = judge(el);
        diag('ended', verdict);
        if (verdict === 'content-end') {
          e.stopImmediatePropagation();
          handleContentEnd('ended');
        } else if (verdict === 'unknown') {
          send({ type: 'media-event', event: 'unknown-end', taskId: armed.taskId, text: '检测到一次播放结束，但无法确认是否为正文结束（可能是广告或页面变化），继续录音；如已结束请手动停止。' });
        }
        return;
      }
      if (guard && guard.state === 'guarded') {
        // 保护期间，其他媒体结束也不让网站据此切换下一条
        e.stopImmediatePropagation();
      }
    },
    true,
  );

  // 保护期间：拦截非用户触发的播放
  const onAnyPlay = (e) => {
    const el = e.target;
    if (!(el instanceof HTMLMediaElement) || !guard || guard.state !== 'guarded') return;
    if (now() - userGestureAt < 1500) {
      releaseGuard('user');
      return;
    }
    if (el.muted && el !== guard.el && el.tagName === 'VIDEO' && !el.closest('#movie_player, .bpx-player-container')) return; // 无声预览不影响
    el.pause();
    guard.count++;
    send({ type: 'media-event', event: 'guard', state: 'repaused', count: guard.count, taskId: guard.taskId });
  };
  document.addEventListener('play', onAnyPlay, true);
  document.addEventListener('playing', onAnyPlay, true);

  function judge(el) {
    return D.judgeEnd({
      platform,
      adState: platform === 'youtube' ? D.youtubeAdState(document) : 'content',
      duration: el.duration,
      currentTime: el.currentTime,
      contentDuration: armed ? armed.contentDuration : 0,
    });
  }

  // ---------- 消息 ----------
  function send(msg) {
    try {
      return chrome.runtime.sendMessage({ target: 'sw', ...msg }).catch(() => null);
    } catch (e) {
      return Promise.resolve(null); // 扩展已重载
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.target !== 'content' || sender.id !== chrome.runtime.id) return false;
    Promise.resolve(handle(msg))
      .then((r) => sendResponse(r || { ok: true }))
      .catch((e) => sendResponse({ ok: false, code: e && e.code ? e.code : 'unknown', detail: e && e.detail ? e.detail : '' }));
    return true;
  });

  async function handle(msg) {
    switch (msg.type) {
      case 'ping':
        return { ok: true, platform };
      case 'probe':
        return probe();
      case 'bili-fetch':
        return biliFetch(msg.url, msg.withLogin);
      case 'prepare':
        return prepare(msg.taskId, msg.mode);
      case 'arm-and-play':
        return armAndPlay(msg.taskId);
      case 'pause-for-stop':
        return pauseForStop();
      case 'disarm':
        disarm();
        return { ok: true };
      case 'guard-status':
        return guardStatus(msg.taskId);
      case 'task-update':
        lastTask = msg.task;
        renderFloat();
        return { ok: true };
      case 'float-toggle':
        toggleFloat(msg.show);
        return { ok: true, visible: floatVisible() };
      case 'toast':
        toast(msg.text);
        return { ok: true };
    }
    return { ok: false };
  }

  function probe() {
    target = D.pickTarget(document, window, platform) || target;
    const t = target;
    return {
      ok: true,
      platform,
      url: location.href,
      videoKey: D.videoKeyOf(location.href),
      title: D.cleanTitle(document.title, platform),
      ad: platform === 'youtube' ? D.youtubeAdState(document) : null,
      media: t ? { duration: finite(t.duration), currentTime: finite(t.currentTime), paused: t.paused, muted: t.muted || t.volume === 0, tag: t.tagName.toLowerCase() } : null,
    };
  }

  function finite(x) {
    return Number.isFinite(x) ? x : null;
  }

  // ---------- B站字幕请求：在页面同源上下文中发起，不修改请求头，不读取 Cookie 值 ----------
  async function biliFetch(url, withLogin) {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return { ok: false, code: 'bad_url' };
    }
    if (platform !== 'bilibili' || u.protocol !== 'https:' || !(u.hostname === 'api.bilibili.com' || /(^|\.)hdslb\.com$/.test(u.hostname))) return { ok: false, code: 'bad_url' };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(u.href, { credentials: withLogin && u.hostname === 'api.bilibili.com' ? 'include' : 'omit', signal: ctrl.signal, cache: 'no-store' });
      if (!res.ok) return { ok: false, code: 'http', status: res.status };
      const text = await res.text();
      if (text.length > 20 * 1024 * 1024) return { ok: false, code: 'too_large' };
      return { ok: true, json: JSON.parse(text) };
    } catch (e) {
      return { ok: false, code: 'network' };
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------- 准备：定位起点 ----------
  async function prepare(taskId, mode) {
    stopGuard();
    target = D.pickTarget(document, window, platform);
    if (!target) return { ok: false, code: 'media_not_found' };
    prepareAbort = { aborted: false };
    const ab = prepareAbort;
    if (platform === 'youtube') {
      if (D.youtubeAdState(document) === 'ad') {
        send({ type: 'media-event', event: 'waiting-ad', taskId });
        diag('wait-ad', 'ad');
        const t0 = now();
        while (D.youtubeAdState(document) === 'ad') {
          if (ab.aborted) return { ok: false, code: 'ad_wait_cancelled' };
          if (now() - t0 > 15 * 60 * 1000) return { ok: false, code: 'target_lost', detail: '广告等待超时' };
          await sleep(400);
        }
        send({ type: 'media-event', event: 'ad-done', taskId });
        diag('wait-ad', 'content');
        await sleep(300);
        target = D.pickTarget(document, window, platform);
        if (!target) return { ok: false, code: 'media_not_found' };
      }
      if (D.youtubeAdState(document) === 'unknown') return { ok: false, code: 'media_not_found', detail: '无法识别 YouTube 播放器' };
    }
    const wasPaused = target.paused;
    target.pause();
    if (mode === 'beginning') {
      if (target.currentTime > 0.05) {
        const ok = await seekTo(target, 0);
        if (!ok) return { ok: false, code: 'target_lost', detail: '无法定位到视频开头' };
      }
    }
    if (ab.aborted) return { ok: false, code: 'ad_wait_cancelled' };
    return { ok: true, startOffset: target.currentTime || 0, wasPaused };
  }

  function seekTo(el, t) {
    return new Promise((resolve) => {
      let doneFlag = false;
      const fin = (v) => {
        if (doneFlag) return;
        doneFlag = true;
        el.removeEventListener('seeked', onSeeked);
        resolve(v);
      };
      const onSeeked = () => fin(el.currentTime < 1);
      el.addEventListener('seeked', onSeeked);
      try {
        el.currentTime = t;
      } catch (e) {
        fin(false);
      }
      setTimeout(() => fin(el.currentTime < 1), 6000);
    });
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ---------- 录音期间的监测 ----------
  async function armAndPlay(taskId) {
    if (!target || !target.isConnected) target = D.pickTarget(document, window, platform);
    if (!target) return { ok: false, code: 'media_not_found' };
    const el = target;
    armed = {
      taskId,
      el,
      videoKey: D.videoKeyOf(location.href),
      src: el.currentSrc,
      contentDuration: platform === 'youtube' && D.youtubeAdState(document) !== 'content' ? 0 : finite(el.duration) || 0,
      lastTime: el.currentTime,
      lastProgress: 0,
      adState: platform === 'youtube' ? D.youtubeAdState(document) : 'content',
      origLoop: el.loop,
      ourPause: false,
    };
    if (el.loop) el.loop = false; // 抖音等：本条任务期间不自动从头循环（结束后用户继续播放时恢复）
    el.addEventListener('pause', onPause);
    el.addEventListener('play', onPlay);
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('error', onError);
    el.addEventListener('emptied', onEmptied);
    armed.watch = setInterval(watchTarget, 700);
    window.addEventListener('pagehide', onPageHide);
    let blocked = false;
    try {
      await el.play();
    } catch (e) {
      blocked = e && e.name === 'NotAllowedError';
      if (!blocked) {
        detach();
        return { ok: false, code: 'media_error' };
      }
    }
    diag('armed', armed ? armed.adState : '');
    return { ok: true, blocked, muted: el.muted || el.volume === 0 };
  }

  function detach() {
    const a = armed;
    if (!a) return;
    a.el.removeEventListener('pause', onPause);
    a.el.removeEventListener('play', onPlay);
    a.el.removeEventListener('timeupdate', onTime);
    a.el.removeEventListener('error', onError);
    a.el.removeEventListener('emptied', onEmptied);
    window.removeEventListener('pagehide', onPageHide);
    clearInterval(a.watch);
    clearInterval(a.endWatch);
    armed = null;
    return a;
  }

  function onPause() {
    const a = armed;
    if (!a || a.ourPause) return;
    const el = a.el;
    if (D.isPauseAtEnd(el.currentTime, el.duration) && judge(el) === 'content-end') {
      handleContentEnd('pause-at-end');
      return;
    }
    if (platform === 'youtube' && D.youtubeAdState(document) === 'ad') return; // 广告切换引起的暂停
    send({ type: 'media-event', event: 'paused', taskId: a.taskId });
  }

  function onPlay() {
    if (armed) send({ type: 'media-event', event: 'playing', taskId: armed.taskId });
  }

  function onTime() {
    const a = armed;
    if (!a) return;
    const el = a.el;
    const ct = el.currentTime;
    if (D.isLoopWrap(a.lastTime, ct, el.duration, now() - userGestureAt) && !(platform === 'youtube' && D.youtubeAdState(document) === 'ad')) {
      // 播放器自行从头循环：视为正文结束（循环开头可能已录入不到 1 秒）
      diag('loop-wrap', 'content-end');
      handleContentEnd('loop');
      return;
    }
    a.lastTime = ct;
    // 抖音等页面可能反复把 loop 设回 true：任务期间持续压制，临近结尾时提高频率
    if (el.loop) el.loop = false;
    if (!a.endWatch && Number.isFinite(el.duration) && el.duration - ct < 1.5) {
      a.endWatch = setInterval(() => {
        if (el.loop) el.loop = false;
      }, 40);
    }
    if (platform === 'youtube' && D.youtubeAdState(document) === 'content' && Number.isFinite(el.duration) && el.duration > 0) a.contentDuration = el.duration;
    if (now() - a.lastProgress > 3000) {
      a.lastProgress = now();
      send({ type: 'media-event', event: 'progress', taskId: a.taskId, currentTime: ct, duration: finite(el.duration) });
    }
  }

  function onError() {
    const a = armed;
    if (!a) return;
    if (platform === 'youtube' && D.youtubeAdState(document) === 'ad') return;
    lose('media_error', '视频播放出错');
  }

  function onEmptied() {
    const a = armed;
    if (!a) return;
    if (platform === 'youtube') return; // 广告切换会清空并更换媒体源，由视频编号判断换片
    setTimeout(() => {
      if (armed !== a) return;
      const key = D.videoKeyOf(location.href);
      if (platform === 'generic' && a.el.currentSrc && a.src && a.el.currentSrc !== a.src && !a.src.startsWith('blob:')) lose('target_lost', '媒体源已更换');
      else if (key && a.videoKey && key !== a.videoKey) lose('navigated', '页面切换到了其他视频');
    }, 1500);
  }

  function onPageHide() {
    if (armed) lose('navigated', '页面已离开或刷新');
  }

  function watchTarget() {
    const a = armed;
    if (!a) return;
    if (!a.el.isConnected) return lose('target_lost', '视频元素已被移除');
    const key = D.videoKeyOf(location.href);
    if (a.videoKey && key && key !== a.videoKey) return lose('navigated', '页面切换到了其他视频');
    if (platform === 'douyin') {
      // 抖音信息流：另一条视频开始播放且目标已暂停 → 已划走
      const others = Array.from(document.querySelectorAll('video')).filter((v) => v !== a.el && !v.paused && !v.muted);
      if (others.length && a.el.paused) return lose('target_lost', '已切换到其他视频');
    }
    if (platform === 'youtube') {
      const s = D.youtubeAdState(document);
      if (s !== a.adState) {
        a.adState = s;
        diag('ad-state', s);
        send({ type: 'media-event', event: 'ad', ad: s === 'ad', taskId: a.taskId });
      }
    }
  }

  function lose(code, detail) {
    const a = detach();
    if (!a) return;
    if (a.origLoop) a.el.loop = true;
    send({ type: 'media-event', event: 'target-lost', code, detail, taskId: a.taskId });
  }

  function handleContentEnd(kind) {
    const a = detach();
    if (!a) return;
    a.ourPause = true;
    try {
      a.el.pause();
      // 已被播放器绕回开头时，把画面停回结尾，保持“播完暂停”的状态
      if (kind === 'loop' && Number.isFinite(a.el.duration)) a.el.currentTime = Math.max(0, a.el.duration - 0.05);
    } catch (e) {
      /* ignore */
    }
    startGuard(a, kind);
    send({ type: 'media-event', event: 'ended', kind, paused: a.el.paused, taskId: a.taskId });
  }

  // ---------- 播完暂停保护 ----------
  function startGuard(a, kind) {
    stopGuard();
    guard = { taskId: a.taskId, el: a.el, origLoop: a.origLoop, count: 0, state: 'guarded', kind, startedAt: now() };
    guard.timer = setInterval(guardTick, 500);
    guard.navKey = D.videoKeyOf(location.href);
    guardTick();
  }

  function guardTick() {
    const g = guard;
    if (!g || g.state !== 'guarded') return;
    // YouTube 结束倒计时 / 续播：点“取消”（不修改自动播放全局设置）
    if (platform === 'youtube') {
      const cancel = document.querySelector('.ytp-autonav-endscreen-upnext-cancel-button, .ytp-upnext-cancel-button');
      if (cancel && cancel.getClientRects().length) cancel.click();
    }
    // 兜底：任何非用户触发而在播放的媒体都暂停
    const playing = Array.from(document.querySelectorAll('video, audio')).filter((v) => !v.paused && !v.muted);
    if (playing.length && now() - userGestureAt > 1500) {
      playing.forEach((v) => v.pause());
      g.count++;
      send({ type: 'media-event', event: 'guard', state: 'repaused', count: g.count, taskId: g.taskId });
    }
    // 用户主动选择其他视频（有操作且页面换片）：解除
    const key = D.videoKeyOf(location.href);
    if (key !== g.navKey && now() - userGestureAt < 3000) releaseGuard('user-nav');
  }

  function releaseGuard(why) {
    const g = guard;
    if (!g) return;
    g.state = 'released';
    clearInterval(g.timer);
    if (g.origLoop && g.el) g.el.loop = true;
    guard = null;
    send({ type: 'media-event', event: 'guard', state: 'released', why, taskId: g.taskId });
  }

  function stopGuard() {
    if (guard) {
      clearInterval(guard.timer);
      if (guard.origLoop && guard.el) guard.el.loop = true;
      guard = null;
    }
  }

  function guardStatus(taskId) {
    if (!guard || guard.taskId !== taskId) return { ok: true, state: 'released' };
    const el = guard.el;
    if (el && !el.paused) {
      el.pause();
      if (!el.paused) return { ok: true, state: 'failed', repauses: guard.count };
    }
    return { ok: true, state: 'guarded', repauses: guard.count };
  }

  function pauseForStop() {
    const a = detach();
    const el = a ? a.el : target;
    if (a && a.origLoop) el.loop = true;
    if (el) el.pause();
    return { ok: !!el && el.paused };
  }

  function disarm() {
    if (prepareAbort) prepareAbort.aborted = true;
    const a = detach();
    if (a && a.origLoop) a.el.loop = true;
  }

  // ---------- 低频诊断（仅在设置开启时记录；不含标题、URL 等私密内容） ----------
  function diag(event, state) {
    if (platform !== 'youtube' || !settings || !settings.diag || !settings.diag.youtube) return;
    const el = (armed && armed.el) || target;
    send({ type: 'diag', entry: { event, state, reason: '', ct: el ? el.currentTime : null, dur: el ? el.duration : null } });
  }

  // ---------- 浮窗 ----------
  let host = null;
  let shadow = null;
  let expanded = false;
  let hidden = false;
  let pos = null;

  async function loadPrefs() {
    try {
      const r = await chrome.storage.local.get(['settings', 'float.hidden', 'float.pos']);
      settings = r.settings || {};
      hidden = !!r['float.hidden'];
      pos = r['float.pos'] || null;
    } catch (e) {
      settings = {};
    }
  }

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    if (ch.settings) {
      settings = ch.settings.newValue || {};
      applyDensity();
      ensureFloat();
    }
    if (ch['float.hidden']) {
      hidden = !!ch['float.hidden'].newValue;
      ensureFloat();
    }
  });

  function floatEnabled() {
    return !settings || !settings.float || settings.float.enabled !== false;
  }

  function floatVisible() {
    return !!host && host.isConnected && host.style.display !== 'none';
  }

  function toggleFloat(show) {
    const want = typeof show === 'boolean' ? show : !floatVisible();
    hidden = !want;
    chrome.storage.local.set({ 'float.hidden': hidden }).catch(() => {});
    if (want) {
      ensureFloat(true);
      expanded = true;
      renderFloat();
      refreshTask();
    } else ensureFloat();
  }

  function ensureFloat(force) {
    const shouldShow = (floatEnabled() || force) && !hidden;
    if (!shouldShow) {
      if (host) host.style.display = 'none';
      return;
    }
    if (!document.body) return;
    if (!host) buildFloat();
    if (!host.isConnected) document.documentElement.appendChild(host);
    host.style.display = '';
    renderFloat();
  }

  // 不使用 innerHTML：YouTube 等站点启用 Trusted Types，且浮窗内容一律以 DOM API 构建
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'hidden') el.hidden = !!v;
      else el.setAttribute(k, v);
    }
    for (const c of kids) if (c) el.append(c);
    return el;
  }

  function iconSvg() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const mk = (tag, attrs) => {
      const e = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
      svg.appendChild(e);
    };
    mk('rect', { x: '2.5', y: '3.5', width: '19', height: '17', rx: '5', fill: 'currentColor', opacity: '.16' });
    mk('path', { d: 'M8.5 8.2v7.6l6-3.8z', fill: 'currentColor' });
    mk('path', { d: 'M16.5 15.5h3M16.5 18h2', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round' });
    return svg;
  }

  // 尺寸自适应：与扩展页面同一套规则（shared/uiscale.js：平台基准 × 实测中文字形 × 用户微调）。
  // 浮窗在网页中以 px 排版，不受网页自身字号影响
  let floatWrap = null;
  function applyDensity() {
    if (!floatWrap) return;
    const SC = globalThis.WV4UScale;
    const r = SC ? SC.compute({ ui: settings && settings.ui }) : { os: 'other', scale: 1 };
    floatWrap.style.setProperty('--k', String(r.scale));
    floatWrap.dataset.os = r.os;
  }

  function buildFloat() {
    host = document.createElement('wv4u-float');
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483646;';
    applyPos();
    shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = FLOAT_CSS;
    const wrap = (floatWrap = h(
      'div',
      { class: 'wrap' },
      h('button', { class: 'handle', 'aria-label': 'WatchVid4U 浮窗（拖动可移动，Alt+方向键微调，点击展开）', 'aria-expanded': 'false' }, iconSvg(), h('span', { class: 'dot', 'aria-hidden': 'true' })),
      h(
        'div',
        { class: 'panel', role: 'dialog', 'aria-label': 'WatchVid4U 快捷操作', hidden: true },
        h('div', { class: 'head' }, h('span', { class: 'brand', text: 'WatchVid4U' }), h('button', { class: 'ghost close', 'aria-label': '收起浮窗', text: '收起' }), h('button', { class: 'ghost hide', 'aria-label': '隐藏浮窗（快捷键可再次呼出）', text: '隐藏' })),
        h('p', { class: 'status', role: 'status', 'aria-live': 'polite' }),
        h('div', { class: 'actions idle' }, h('button', { class: 'primary act-start', text: '从当前开始' }), h('button', { class: 'secondary act-begin', text: '从头开始' })),
        h('div', { class: 'actions running', hidden: true }, h('button', { class: 'danger act-stop', text: '停止并保存' }), h('button', { class: 'secondary act-cancel', text: '取消' })),
        h('label', { class: 'mon' }, h('input', { type: 'checkbox', class: 'act-monitor' }), document.createTextNode(' 同时听声音')),
        h('div', { class: 'links' }, h('button', { class: 'link act-lib', text: '材料与笔记' }), h('button', { class: 'link act-opt', text: '设置' })),
      ),
      h('div', { class: 'toast', role: 'status', 'aria-live': 'polite', hidden: true }),
    ));
    applyDensity();
    shadow.append(style, wrap);
    const $ = (s) => shadow.querySelector(s);
    const handleBtn = $('.handle');
    // 拖动
    let drag = null;
    handleBtn.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY, moved: false, rect: host.getBoundingClientRect() };
      handleBtn.setPointerCapture(e.pointerId);
    });
    handleBtn.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      if (drag.moved) {
        pos = { left: clamp(drag.rect.left + dx, 4, innerWidth - 52), top: clamp(drag.rect.top + dy, 4, innerHeight - 52) };
        applyPos();
      }
    });
    handleBtn.addEventListener('pointerup', () => {
      if (drag && drag.moved) chrome.storage.local.set({ 'float.pos': pos }).catch(() => {});
      else {
        expanded = !expanded;
        renderFloat();
        if (expanded) refreshTask();
      }
      drag = null;
    });
    handleBtn.addEventListener('keydown', (e) => {
      if (!e.altKey) return;
      const step = 24;
      const r = host.getBoundingClientRect();
      const m = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (m) {
        e.preventDefault();
        pos = { left: clamp(r.left + m[0], 4, innerWidth - 52), top: clamp(r.top + m[1], 4, innerHeight - 52) };
        applyPos();
        chrome.storage.local.set({ 'float.pos': pos }).catch(() => {});
      }
    });
    $('.close').addEventListener('click', () => {
      expanded = false;
      renderFloat();
      handleBtn.focus();
    });
    $('.hide').addEventListener('click', () => {
      toggleFloat(false);
      toast('浮窗已隐藏，可用快捷键或工具栏重新显示');
    });
    const act = (action, extra) => async () => {
      const r = await send({ type: 'float-action', action, ...extra });
      if (r && r.task) lastTask = r.task;
      if (r && !r.ok && r.error) toast(r.error.message + (r.error.detail ? `（${r.error.detail}）` : ''));
      refreshTask();
    };
    $('.act-start').addEventListener('click', act('start'));
    $('.act-begin').addEventListener('click', act('start-beginning'));
    $('.act-stop').addEventListener('click', act('stop'));
    $('.act-cancel').addEventListener('click', act('cancel'));
    $('.act-lib').addEventListener('click', act('open-library'));
    $('.act-opt').addEventListener('click', act('open-options'));
    $('.act-monitor').addEventListener('change', (e) => send({ type: 'float-action', action: 'monitor', on: e.target.checked }));
    shadow.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && expanded) {
        expanded = false;
        renderFloat();
        handleBtn.focus();
      }
    });
  }

  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }

  function applyPos() {
    if (!host) return;
    if (pos) {
      host.style.left = clamp(pos.left, 4, innerWidth - 52) + 'px';
      host.style.top = clamp(pos.top, 4, innerHeight - 52) + 'px';
      host.style.right = 'auto';
      host.style.bottom = 'auto';
    } else {
      host.style.right = '20px';
      host.style.bottom = '96px';
    }
  }

  const PHASE_TEXT = {
    detecting: '正在识别视频…',
    subtitle: '正在获取字幕…',
    preparing: '正在准备录音…',
    waiting_ad: '等待广告结束…',
    recording: '录音中',
    saving: '正在保存…',
    transcribing: '正在转写…',
    noting: '正在生成笔记…',
    needs_action: '需要你的授权',
    done: '已完成',
    failed: '失败',
    cancelled: '已取消',
    interrupted: '已中断',
  };

  async function refreshTask() {
    const r = await send({ type: 'get-task' });
    if (r && r.ok) {
      lastTask = r.task;
      renderFloat();
    }
  }

  function renderFloat() {
    if (!shadow) return;
    const $ = (s) => shadow.querySelector(s);
    const t = lastTask;
    const active = t && !['done', 'failed', 'cancelled', 'interrupted'].includes(t.phase);
    const here = t && active && t.tabId != null && t.videoKey === D.videoKeyOf(location.href);
    const panel = $('.panel');
    panel.hidden = !expanded;
    $('.handle').setAttribute('aria-expanded', String(expanded));
    const dot = $('.dot');
    dot.className = 'dot' + (t && t.phase === 'recording' ? ' rec' : active ? ' busy' : t && (t.phase === 'failed' || t.phase === 'interrupted') ? ' err' : '');
    let status = '准备就绪：一键获取逐字稿';
    if (t) {
      const ph = PHASE_TEXT[t.phase] || t.phase;
      if (active && !here) status = `另一页面有任务进行中：${ph}`;
      else status = t.phaseText || ph;
      if (t.phase === 'recording' && t.audio && t.audio.seconds) status = `${t.phaseText || '录音中'} · ${fmt(t.audio.seconds)}`;
    }
    $('.status').textContent = status;
    $('.actions.idle').hidden = !!active;
    $('.actions.running').hidden = !(active && here);
    $('.act-stop').textContent = t && t.phase === 'recording' ? '停止并保存' : '停止';
    $('.act-monitor').checked = !!(t ? t.monitor : settings && settings.record && settings.record.monitor);
  }

  function fmt(s) {
    s = Math.round(s);
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  }

  let toastTimer = null;
  function toast(text) {
    ensureFloat(true);
    if (!shadow) return;
    const el = shadow.querySelector('.toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 6000);
  }

  // 站内单键呼出（默认关闭；输入框、评论区与输入法组合输入时不响应）
  window.addEventListener(
    'keydown',
    (e) => {
      const f = settings && settings.float;
      if (!f || !f.hotkeyEnabled || !f.hotkey) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.keyCode === 229) return;
      const path = e.composedPath ? e.composedPath() : [e.target];
      if (path.some((n) => n instanceof Element && D.isEditableTarget(n))) return;
      if (e.key !== f.hotkey) return;
      e.preventDefault();
      e.stopPropagation();
      if (!floatVisible()) toggleFloat(true);
      else if (!expanded) {
        expanded = true;
        renderFloat();
        refreshTask();
      } else toggleFloat(false);
    },
    true,
  );

  const FLOAT_CSS = `
    :host{all:initial}
    .wrap{--bg:#fffdf8;--fg:#1f2430;--mut:#5d6472;--line:#e4e0d6;--acc:#3451d1;--acc-fg:#fff;--rec:#d6336c;--warn:#e8590c;--ok:#2b8a3e;
      --k:1;--fs:calc(13px * var(--k));--hs:calc(44px * var(--k));--pw:calc(248px * var(--k));--w-strong:600;--w-head:650;
      font:var(--fs)/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei UI","Microsoft YaHei",sans-serif;color:var(--fg);position:relative}
    .wrap[data-os="windows"],.wrap[data-os="linux"],.wrap[data-os="chromeos"]{--fs:calc(14px * var(--k));--w-strong:400;--w-head:700;line-height:1.4}
    @media (prefers-color-scheme: dark){.wrap{--bg:#1d2129;--fg:#e8e6e1;--mut:#a3a9b6;--line:#353b47;--acc:#8ea2ff;--acc-fg:#10131a;--rec:#ff6b9a}}
    button{font:inherit;cursor:pointer}
    button:focus-visible,input:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
    .handle{width:var(--hs);height:var(--hs);border-radius:14px;border:1px solid var(--line);background:var(--bg);color:var(--acc);display:grid;place-items:center;box-shadow:0 4px 16px rgba(0,0,0,.18);touch-action:none;position:relative;padding:0}
    .handle svg{width:calc(var(--hs) * .6);height:calc(var(--hs) * .6)}
    .dot{position:absolute;right:5px;top:5px;width:8px;height:8px;border-radius:50%;background:transparent}
    .dot.rec{background:var(--rec);animation:pulse 1.4s infinite}
    .dot.busy{background:var(--acc)}
    .dot.err{background:var(--warn)}
    @keyframes pulse{50%{opacity:.35}}
    .panel{position:absolute;right:0;bottom:calc(var(--hs) + 8px);width:var(--pw);max-width:calc(100vw - 24px);background:var(--bg);border:1px solid var(--line);border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.22);padding:calc(12px * var(--k))}
    .panel[hidden],.actions[hidden],.toast[hidden]{display:none}
    .head{display:flex;align-items:center;gap:6px;margin-bottom:6px}
    .brand{font-weight:var(--w-head);flex:1;letter-spacing:.2px}
    .ghost{background:none;border:0;color:var(--mut);padding:2px 6px;border-radius:6px}
    .ghost:hover{background:color-mix(in srgb,var(--fg) 8%,transparent)}
    .status{margin:0 0 10px;color:var(--mut);min-height:1.45em;word-break:break-word}
    .actions{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px}
    .primary,.secondary,.danger{border-radius:9px;padding:calc(8px * var(--k)) 6px;border:1px solid transparent;font-weight:var(--w-strong)}
    .primary{background:var(--acc);color:var(--acc-fg)}
    .secondary{background:transparent;border-color:var(--line);color:var(--fg)}
    .danger{background:var(--rec);color:#fff}
    .mon{display:flex;gap:6px;align-items:center;color:var(--mut);margin-bottom:6px}
    .links{display:flex;gap:10px;border-top:1px solid var(--line);padding-top:8px}
    .link{background:none;border:0;color:var(--acc);padding:0}
    .toast{position:absolute;right:0;bottom:calc(var(--hs) + 8px);width:calc(var(--pw) + 12px);max-width:calc(100vw - 24px);background:var(--fg);color:var(--bg);padding:10px 12px;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.25)}
    .panel:not([hidden]) ~ .toast{bottom:auto;top:calc(var(--hs) + 8px)}
    @media (prefers-reduced-motion: reduce){.dot.rec{animation:none}}
  `;

  // 启动
  loadPrefs().then(() => {
    const start = () => {
      if (platform !== 'generic') ensureFloat();
      else ensureFloat(true);
      refreshTask();
    };
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  });
  window.addEventListener('resize', applyPos);
})();
