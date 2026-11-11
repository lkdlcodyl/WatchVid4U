import { test, describe, assert } from './harness.js';
import { putMaterial, getMaterial, updateMaterial, addChunk, getChunks, deleteMaterials, purgeAudio, enforceAudioCache, listMaterials, AUDIO_CACHE_LIMIT, kvSet, kvGet, kvDelete, putRaw, getRaw } from '../../extension/src/shared/db.js';

const mk = (id, extra = {}) => ({ id, createdAt: Date.now(), title: id, platform: 'generic', audio: { bytes: 10, samples: 5 }, notes: {}, ...extra });

describe('db', () => {
  test('写入、事务内更新、读取', async () => {
    await putMaterial(mk('t_a'));
    await updateMaterial('t_a', (m) => ((m.title = '改'), m));
    assert.equal((await getMaterial('t_a')).title, '改');
    assert.equal(await updateMaterial('nope', (m) => m), null);
  });
  test('批量删除：材料、分块、原始数据一起删除', async () => {
    await putMaterial(mk('t_b'));
    await addChunk({ materialId: 't_b', seq: 0, startSample: 0, sampleCount: 2, blob: new Blob([new Uint8Array(4)]), rms: [0], bytes: 4 });
    await putRaw('t_b', 'subtitle', { x: 1 });
    await putMaterial(mk('t_c'));
    await deleteMaterials(['t_a', 't_b']);
    assert.equal(await getMaterial('t_b'), undefined);
    assert.equal((await getChunks('t_b')).length, 0);
    assert.equal(await getRaw('t_b', 'subtitle'), null);
    assert.ok(await getMaterial('t_c'), '未选中的材料不受影响');
    await deleteMaterials(['t_c']);
  });
  test('清理音频保留文字', async () => {
    await putMaterial(mk('t_d', { transcript: { effective: 'x' } }));
    await addChunk({ materialId: 't_d', seq: 0, startSample: 0, sampleCount: 2, blob: new Blob([new Uint8Array(4)]), rms: [0], bytes: 4 });
    await purgeAudio('t_d');
    const m = await getMaterial('t_d');
    assert.ok(m.audio.purged);
    assert.equal(m.transcript.effective, 'x');
    assert.equal((await getChunks('t_d')).length, 0);
    await deleteMaterials(['t_d']);
  });
  test('缓存上限：从最旧的已转写音频开始清理，保护当前任务与无逐字稿材料', async () => {
    const big = AUDIO_CACHE_LIMIT * 0.35;
    const now = Date.now();
    await putMaterial(mk('t_old', { createdAt: now - 3000, audio: { bytes: big }, transcript: { effective: 'a' } }));
    await putMaterial(mk('t_mid', { createdAt: now - 2000, audio: { bytes: big }, transcript: { effective: 'b' } }));
    await putMaterial(mk('t_draft', { createdAt: now - 4000, audio: { bytes: big } }));
    await putMaterial(mk('t_cur', { createdAt: now - 5000, audio: { bytes: big }, transcript: { effective: 'c' } }));
    const r = await enforceAudioCache(['t_cur']);
    assert.ok(r.purged.includes('t_old'));
    assert.ok(!r.purged.includes('t_cur'), '保护当前任务');
    assert.ok(!r.purged.includes('t_draft'), '没有逐字稿的不清理');
    assert.ok(r.total <= AUDIO_CACHE_LIMIT * 0.8 + 1);
    assert.equal((await getMaterial('t_old')).transcript.effective, 'a');
    await deleteMaterials(['t_old', 't_mid', 't_draft', 't_cur']);
  });
  test('kv 区读写', async () => {
    await kvSet('secret.test', { key: 'k' });
    assert.equal((await kvGet('secret.test')).key, 'k');
    await kvDelete('secret.test');
    assert.equal(await kvGet('secret.test'), undefined);
    assert.ok(Array.isArray(await listMaterials()));
  });
});
