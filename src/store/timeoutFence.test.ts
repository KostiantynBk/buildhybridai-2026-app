import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';
import { Scheduler } from './scheduler';
import { LocalError } from '../ai/localModel';
import { CloudProcessingService, type CloudProcessingAdapter } from '../ai/cloudProcessing';
import { modeRouter } from '../ui/modeRouter';
import { openDB } from 'idb';
import { STORE_VERSION } from './index';
import { openLocalStore } from './index';

const text = 'This paragraph contains enough words for the extraction job to become available for processing.';
it('fences stale results and failures by key and claimed attempt after timeout/reload', async () => {
  const store = await openLocalStore(`attempt-${crypto.randomUUID()}`);
  try {
    await store.saveNotebook(text, 0); await store.enqueueSettled(4000, 'extract.v2');
    const first = (await store.claim(4000))!.job;
    await store.fail(first, 'TimeoutError', false, 4000);
    expect((await store.snapshot()).jobs[0]).toMatchObject({ status: 'pending', attempts: 1 });
    await store.resume();
    const second = (await store.claim(10000))!.job;
    expect(second.attempts).toBe(2);
    expect(await store.complete(first, [{ kind: 'assumption', text: 'old', quote: 'paragraph', topics: [] }],
      10000, 'on_device')).toBe(false);
    await store.fail(first, 'TimeoutError', false, 10000);
    expect((await store.snapshot()).jobs[0]).toMatchObject({ status: 'running', attempts: 2 });
    await store.fail(second, 'TimeoutError', false, 10000);
    const third = (await store.claim(25000))!.job;
    await store.fail(third, 'TimeoutError', false, 25000);
    expect((await store.snapshot()).jobs[0]).toMatchObject({ status: 'failed', attempts: 3 });
  } finally { store.close(); }
});
it('marks confirmed model quota terminal and proceeds to the next paragraph', async () => {
  const store = await openLocalStore(`quota-${crypto.randomUUID()}`);
  const runLocal = vi.fn().mockRejectedValueOnce(new LocalError('model-quota', 'long',
    { errorName: 'QuotaExceededError' })).mockResolvedValue({ data: { items: [] }, source: 'on_device',
    latencyMs: 1, raw: '' });
  const scheduler = new Scheduler(store, { state: { kind: 'ready' }, subscribe: () => () => {}, runLocal },
    () => 'extract.v2', () => {}, () => 4000);
  try {
    await store.saveNotebook(`${text}\n\n${text} Second.`, 0);
    await scheduler.start(); await scheduler.tick();
    const state = await store.snapshot();
    const jobs = state.jobs.filter(job => job.step === 'extract');
    expect(jobs.find(job => job.paragraphId === state.paragraphs[0].id)).toMatchObject({ status: 'failed',
      attempts: 1, failureReason: 'model-input-quota', errorName: 'QuotaExceededError' });
    expect(jobs.find(job => job.paragraphId === state.paragraphs[1].id)).toMatchObject({ status: 'done' });
    expect(runLocal).toHaveBeenCalledTimes(2);
  } finally { scheduler.stop(); store.close(); }
});
it('surfaces storage quota separately from model input quota', async () => {
  const store = await openLocalStore(`storage-quota-${crypto.randomUUID()}`);
  const quota = Object.assign(new Error('fixture'), { name: 'QuotaExceededError' });
  const complete = vi.spyOn(store, 'complete').mockRejectedValueOnce(quota);
  const failed = vi.fn();
  const runLocal = vi.fn().mockResolvedValue({ data: { items: [] }, source: 'on_device', latencyMs: 1, raw: '' });
  let now = 4000;
  const scheduler = new Scheduler(store, { state: { kind: 'ready' }, subscribe: () => () => {}, runLocal },
    () => 'extract.v2', () => {}, () => now, failed);
  try {
    const notebook = `${text}\n\n${text} Second.`;
    await store.saveNotebook(notebook, 0); await scheduler.start();
    expect(failed).toHaveBeenCalledWith(quota);
    expect(scheduler.storagePaused()).toBe(true);
    const state = await store.snapshot();
    const first = state.jobs.find(job => job.paragraphId === state.paragraphs[0].id)!;
    expect(first).toMatchObject({ status: 'pending', attempts: 1, errorName: 'QuotaExceededError' });
    expect(first.failureReason).toBeUndefined();
    now = 10000; await scheduler.tick();
    expect(runLocal).toHaveBeenCalledTimes(1);
    await store.saveNotebook(notebook, 10000); scheduler.saved();
    await vi.waitFor(() => expect(runLocal).toHaveBeenCalledTimes(2));
  } finally { scheduler.stop(); complete.mockRestore(); store.close(); }
});
it('pauses for cloud reservation storage quota without calling the cloud adapter', async () => {
  const store = await openLocalStore(`cloud-storage-quota-${crypto.randomUUID()}`);
  const quota = Object.assign(new Error('fixture'), { name: 'QuotaExceededError' });
  const reserve = vi.spyOn(store, 'reserveCloudProcessing').mockRejectedValueOnce(quota);
  const adapter = vi.fn<CloudProcessingAdapter>().mockResolvedValue({ source: 'in_cloud', text: '{"items":[]}' });
  const cloud = new CloudProcessingService(store, adapter, () => true, () => 'model', () => {});
  const local = { state: { kind: 'ready' }, subscribe: () => () => {}, runLocal: vi.fn() };
  const router = modeRouter(local, cloud, () => store.cloudModeConsent(), () => true, () => true);
  const failed = vi.fn();
  const scheduler = new Scheduler(store, router, () => 'extract.v2', () => {}, () => 4000, failed);
  try {
    await store.saveNotebook(`${text}\n\n${text} Second.`, 0); await store.setCloudModeConsent(true);
    await scheduler.start(); await scheduler.tick();
    expect(scheduler.storagePaused()).toBe(true);
    expect(failed).toHaveBeenCalledOnce();
    expect(adapter).not.toHaveBeenCalled();
    expect((await store.snapshot()).cloudProcessingSends).toEqual([]);
  } finally { scheduler.stop(); reserve.mockRestore(); store.close(); }
});
it('does not report a runner quota error as a storage quota', async () => {
  const store = await openLocalStore(`runner-quota-${crypto.randomUUID()}`);
  const quota = Object.assign(new Error('fixture'), { name: 'QuotaExceededError' });
  const failed = vi.fn();
  const runLocal = vi.fn().mockRejectedValueOnce(quota);
  const scheduler = new Scheduler(store, { state: { kind: 'ready' }, subscribe: () => () => {}, runLocal },
    () => 'extract.v2', () => {}, () => 4000, failed);
  try {
    await store.saveNotebook(text, 0); await scheduler.start();
    expect(failed).not.toHaveBeenCalled();
    expect((await store.snapshot()).jobs[0]).toMatchObject({ status: 'pending', errorName: 'QuotaExceededError' });
    expect((await store.snapshot()).jobs[0].failureReason).toBeUndefined();
  } finally { scheduler.stop(); store.close(); }
});
it('keeps an explicit request ahead of automatic extracts', async () => {
  const name = `priority-${crypto.randomUUID()}`;
  const store = await openLocalStore(name);
  try {
    await store.saveNotebook(`${text}\n\n${text} Second.`, 0);
    await store.enqueueSettled(4000, 'extract.v2');
    const state = await store.snapshot();
    const raw = await openDB(name, STORE_VERSION);
    await raw.put('jobs', { key: 'explicit', paragraphId: state.paragraphs[1].id, paragraphVersion: 1,
      step: 'angles', requested: true, promptVersion: 'angles.v2.1', status: 'pending', attempts: 0,
      createdAt: 5000, nextRunAt: 5000, runMode: 'on_device' });
    raw.close();
    expect((await store.claim(6000))?.job.key).toBe('explicit');
  } finally { store.close(); }
});
it('keeps cloud claims in the previous createdAt/key order', async () => {
  const name = `cloud-order-${crypto.randomUUID()}`;
  const store = await openLocalStore(name);
  try {
    await store.saveNotebook(`${text}\n\n${text} Second.\n\n${text} Third.`, 0);
    const raw = await openDB(name, STORE_VERSION);
    const paragraphs = (await raw.getAll('paragraphs')).sort((a, b) => b.id.localeCompare(a.id));
    for (const [order, paragraph] of paragraphs.entries()) await raw.put('paragraphs', { ...paragraph, order });
    raw.close();
    await store.setCloudModeConsent(true); await store.enqueueSettled(4000, 'extract.v2');
    const snapshot = await store.snapshot();
    const expected = snapshot.jobs.filter(job => job.step === 'extract').map(job => job.key).sort();
    expect(expected.map(key => snapshot.paragraphs.findIndex(p => key.startsWith(`${p.id}@`)))).toEqual([2, 1, 0]);
    const db = await openDB(name, STORE_VERSION);
    await db.put('jobs', { key: 'explicit', paragraphId: snapshot.paragraphs[0].id, paragraphVersion: 1,
      step: 'angles', requested: true, promptVersion: 'angles.v2.1', status: 'pending', attempts: 0,
      createdAt: 5000, nextRunAt: 5000, runMode: 'in_cloud' });
    db.close();
    for (const key of expected) {
      const claim = await store.claim(6000, 'in_cloud');
      expect(claim?.job.key).toBe(key);
      await store.complete(claim!.job, [], 6000, 'in_cloud');
    }
    expect((await store.claim(6000, 'in_cloud'))?.job.key).toBe('explicit');
  } finally { store.close(); }
});
it('claims a later-prepended due paragraph before an older queued paragraph', async () => {
  const store = await openLocalStore(`prepend-${crypto.randomUUID()}`);
  try {
    await store.saveNotebook(`${text} Original.`, 0); await store.enqueueSettled(4000, 'extract.v2');
    const before = (await store.snapshot()).paragraphs[0];
    const prepended = 'A different first paragraph with enough words to qualify for local model extraction.';
    await store.saveNotebook(`${prepended}\n\n${text} Original.`, 5000);
    await store.enqueueSettled(9000, 'extract.v2');
    const paragraphs = (await store.snapshot()).paragraphs;
    expect(paragraphs[1].id).toBe(before.id);
    const first = await store.claim(9000);
    expect(first?.paragraph.id).toBe(paragraphs[0].id);
    await store.complete(first!.job, [], 9000, 'on_device');
    expect((await store.claim(9000))?.paragraph.id).toBe(before.id);
  } finally { store.close(); }
});
it('claims equal-age paragraphs in document order', async () => {
  const store = await openLocalStore(`order-${crypto.randomUUID()}`);
  try {
    await store.saveNotebook(`${text}\n\n${text} Second.\n\n${text} Third.`, 0);
    await store.enqueueSettled(4000, 'extract.v2');
    const state = await store.snapshot();
    for (const paragraph of state.paragraphs) {
      const claimed = await store.claim(4000);
      expect(claimed?.paragraph.id).toBe(paragraph.id);
      await store.complete(claimed!.job, [], 4000, 'on_device');
    }
  } finally { store.close(); }
});
