// 本机材料库（IndexedDB）。音频以 PCM Blob 分块保存，浏览器把 Blob 落盘，不长期占用内存。

const DB_NAME = 'watchvid4u';
const DB_VERSION = 1;
export const AUDIO_CACHE_LIMIT = 1024 * 1024 * 1024; // ~1 GB
const CLEAN_TARGET = 0.8 * AUDIO_CACHE_LIMIT;

let dbPromise = null;
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('wv4u-materials') : null;

export function onMaterialsChanged(cb) {
  if (!channel) return () => {};
  const h = (ev) => cb(ev.data);
  channel.addEventListener('message', h);
  return () => channel.removeEventListener('message', h);
}

function notify(detail) {
  try {
    channel?.postMessage({ type: 'materials', ...detail, at: Date.now() });
  } catch {
    /* ignore */
  }
}

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('materials')) {
        const s = db.createObjectStore('materials', { keyPath: 'id' });
        s.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('chunks')) {
        const c = db.createObjectStore('chunks', { keyPath: ['materialId', 'seq'] });
        c.createIndex('materialId', 'materialId');
      }
      if (!db.objectStoreNames.contains('raw')) db.createObjectStore('raw', { keyPath: ['materialId', 'kind'] });
      // 仅扩展页面可访问的键值区（内容脚本运行在网页源下，无法读取）：用于“记住在本机”的 Key
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('aborted'));
  });
}

function reqP(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function getMaterial(id) {
  const db = await openDb();
  return reqP(db.transaction('materials').objectStore('materials').get(id));
}

export async function listMaterials() {
  const db = await openDb();
  const all = await reqP(db.transaction('materials').objectStore('materials').getAll());
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function putMaterial(m, { silent = false } = {}) {
  const db = await openDb();
  const tx = db.transaction('materials', 'readwrite');
  m.updatedAt = Date.now();
  tx.objectStore('materials').put(m);
  await done(tx);
  if (!silent) notify({ ids: [m.id] });
  return m;
}

/** 事务内读-改-写，fn 返回新对象（或修改后的同一对象）；返回 null 表示不写 */
export async function updateMaterial(id, fn, { silent = false } = {}) {
  const db = await openDb();
  const tx = db.transaction('materials', 'readwrite');
  const store = tx.objectStore('materials');
  const cur = await reqP(store.get(id));
  if (!cur) {
    tx.abort();
    await done(tx).catch(() => {});
    return null;
  }
  const next = fn(structuredClone(cur));
  if (next) {
    next.updatedAt = Date.now();
    store.put(next);
  }
  await done(tx);
  if (next && !silent) notify({ ids: [id] });
  return next || cur;
}

export async function addChunk(chunk) {
  const db = await openDb();
  const tx = db.transaction('chunks', 'readwrite');
  tx.objectStore('chunks').put(chunk);
  await done(tx);
}

export async function getChunks(materialId) {
  const db = await openDb();
  const idx = db.transaction('chunks').objectStore('chunks').index('materialId');
  const list = await reqP(idx.getAll(IDBKeyRange.only(materialId)));
  return list.sort((a, b) => a.seq - b.seq);
}

/** 只取元数据（rms、采样区间），不触碰 Blob 内容 */
export async function getChunkMeta(materialId) {
  const list = await getChunks(materialId);
  return list.map((c) => ({ seq: c.seq, startSample: c.startSample, sampleCount: c.sampleCount, rms: c.rms, bytes: c.bytes }));
}

export async function putRaw(materialId, kind, data) {
  const db = await openDb();
  const tx = db.transaction('raw', 'readwrite');
  tx.objectStore('raw').put({ materialId, kind, data, savedAt: Date.now() });
  await done(tx);
}

export async function getRaw(materialId, kind) {
  const db = await openDb();
  const r = await reqP(db.transaction('raw').objectStore('raw').get([materialId, kind]));
  return r ? r.data : null;
}

async function deleteByIndex(store, materialId) {
  const keys = await reqP(store.index('materialId').getAllKeys(IDBKeyRange.only(materialId)));
  for (const k of keys) store.delete(k);
}

/** 批量删除：单个事务，完整成功或完整失败 */
export async function deleteMaterials(ids) {
  const db = await openDb();
  const tx = db.transaction(['materials', 'chunks', 'raw'], 'readwrite');
  const ms = tx.objectStore('materials');
  const cs = tx.objectStore('chunks');
  const rs = tx.objectStore('raw');
  for (const id of ids) {
    ms.delete(id);
    await deleteByIndex(cs, id);
    rs.delete(IDBKeyRange.bound([id, ''], [id, '￿']));
  }
  await done(tx);
  notify({ ids, deleted: true });
}

/** 删除某材料的音频分块并标记已清理（文字保留） */
export async function purgeAudio(id) {
  const db = await openDb();
  const tx = db.transaction(['materials', 'chunks'], 'readwrite');
  const ms = tx.objectStore('materials');
  const m = await reqP(ms.get(id));
  if (!m || !m.audio) {
    tx.abort();
    await done(tx).catch(() => {});
    return false;
  }
  await deleteByIndex(tx.objectStore('chunks'), id);
  m.audio.purged = true;
  m.audio.purgedAt = Date.now();
  m.audio.bytes = 0;
  m.updatedAt = Date.now();
  ms.put(m);
  await done(tx);
  notify({ ids: [id], purged: true });
  return true;
}

export function audioBytesOf(m) {
  return m && m.audio && !m.audio.purged ? m.audio.bytes || 0 : 0;
}

/**
 * 缓存清理：超过上限时从最旧的“已完成且有逐字稿”的材料开始清理音频，直到低于目标。
 * protectIds：当前任务/处理中的材料，绝不清理。只在任务开始/结束时调用，打开材料页不触发。
 */
export async function enforceAudioCache(protectIds = []) {
  const all = await listMaterials();
  let total = all.reduce((s, m) => s + audioBytesOf(m), 0);
  if (total <= AUDIO_CACHE_LIMIT * 0.9) return { total, purged: [] };
  const protect = new Set(protectIds);
  const candidates = all
    .filter((m) => !protect.has(m.id) && audioBytesOf(m) > 0 && m.transcript && m.transcript.effective && !m.processing && m.status !== 'recording')
    .sort((a, b) => a.createdAt - b.createdAt);
  const purged = [];
  for (const m of candidates) {
    if (total <= CLEAN_TARGET) break;
    const b = audioBytesOf(m);
    if (await purgeAudio(m.id)) {
      total -= b;
      purged.push(m.id);
    }
  }
  return { total, purged };
}

export async function totalAudioBytes() {
  const all = await listMaterials();
  return all.reduce((s, m) => s + audioBytesOf(m), 0);
}

export async function kvGet(key) {
  const db = await openDb();
  return reqP(db.transaction('kv').objectStore('kv').get(key));
}

export async function kvSet(key, value) {
  const db = await openDb();
  const tx = db.transaction('kv', 'readwrite');
  tx.objectStore('kv').put(value, key);
  await done(tx);
}

export async function kvDelete(key) {
  const db = await openDb();
  const tx = db.transaction('kv', 'readwrite');
  tx.objectStore('kv').delete(key);
  await done(tx);
}
