import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { openLocalStore, STORE_VERSION } from './index';
import { openDB } from 'idb';
import { Scheduler, type LocalService } from './scheduler';
import { CloudProcessingService, type CloudProcessingAdapter } from '../ai/cloudProcessing';
import { modeRouter } from '../ui/modeRouter';
import { NotebookPanel } from '../ui/NotebookPanel';

const list = '- First item describes a substantive assumption about users.\n' +
  '- Second item describes another decision about a workflow.\n' +
  '- Third item describes an operational constraint for the service.';
afterEach(() => vi.unstubAllGlobals());
function result(quote: string, source = 'on_device') {
  return { data: { items: [{ kind: 'assumption', text: 'A statement', quote, topics: [] }] },
    source, raw: '', latencyMs: 1 };
}
it('uses one paragraph job and one atomic completion for local rows', async () => {
  const store = await openLocalStore(`rows-${crypto.randomUUID()}`);
  let now = 4000;
  const runLocal = vi.fn().mockImplementation(async () => result('item describes a'));
  const scheduler = new Scheduler(store, { state: { kind: 'ready' }, subscribe: () => () => {}, runLocal },
    () => 'extract.v2', () => {}, () => now);
  try {
    await store.saveNotebook(list, 0); await scheduler.start();
    const state = await store.snapshot();
    expect(runLocal).toHaveBeenCalledTimes(3);
    expect(state.jobs.filter(job => job.step === 'extract')).toMatchObject([{ status: 'done' }]);
    expect(state.items).toHaveLength(1);
    expect(state.items[0].quote).toBe('item describes a');
    now++;
  } finally { scheduler.stop(); store.close(); }
});
it('does not persist partial rows on a row error and follows normal retries and terminal UI', async () => {
  const store = await openLocalStore(`row-failure-${crypto.randomUUID()}`);
  let now = 4000;
  const runLocal = vi.fn().mockImplementation(async () => {
    if (runLocal.mock.calls.length % 2 === 0) throw new Error('fake row failure');
    return result('item describes a');
  });
  const scheduler = new Scheduler(store, { state: { kind: 'ready' }, subscribe: () => () => {}, runLocal },
    () => 'extract.v2', () => {}, () => now);
  try {
    await store.saveNotebook(list, 0); await scheduler.start();
    for (const advance of [5000, 10000]) {
      expect((await store.snapshot()).items).toEqual([]);
      now += advance; await scheduler.tick();
    }
    const state = await store.snapshot();
    expect(state.items).toEqual([]);
    expect(state.jobs.find(job => job.step === 'extract')).toMatchObject({ status: 'failed', attempts: 3 });
    const html = renderToStaticMarkup(<NotebookPanel text={list} save={() => {}} snapshot={state}
      storageStatus="saved" configured ready />);
    expect(html).toContain('We could not finish reading this paragraph.');
  } finally { scheduler.stop(); store.close(); }
});
it('processes a three-item short list locally without changing the cloud word-count rule', async () => {
  for (const cloud of [false, true]) {
    const store = await openLocalStore(`short-list-${crypto.randomUUID()}`);
    const runLocal = vi.fn().mockResolvedValue(result('one', cloud ? 'in_cloud' : 'on_device'));
    const scheduler = new Scheduler(store, { state: { kind: 'ready' }, subscribe: () => () => {}, runLocal,
      isReadyFor: async () => true }, () => 'extract.v2', () => {}, () => 4000);
    try {
      await store.saveNotebook('- one\n- two\n- three', 0);
      if (cloud) await store.setCloudModeConsent(true);
      await scheduler.start();
      expect(runLocal).toHaveBeenCalledTimes(cloud ? 0 : 3);
    } finally { scheduler.stop(); store.close(); }
  }
});
it('does not promote a short local-only job on a cloud switch and restores local work', async () => {
  const store = await openLocalStore(`short-switch-${crypto.randomUUID()}`);
  let ready = false;
  const runLocal = vi.fn().mockResolvedValue(result('one'));
  const scheduler = new Scheduler(store, { state: { kind: 'ready' }, subscribe: () => () => {}, runLocal,
    isReadyFor: async () => ready }, () => 'extract.v2', () => {}, () => 4000);
  try {
    await store.saveNotebook('- one\n- two\n- three', 0); await scheduler.start();
    expect((await store.snapshot()).jobs[0]).toMatchObject({ status: 'pending', cloudEligible: false });
    await store.setCloudModeConsent(true); ready = true; await scheduler.tick();
    expect(runLocal).not.toHaveBeenCalled();
    expect((await store.snapshot()).cloudProcessingSends).toEqual([]);
    await store.setCloudModeConsent(false); await scheduler.tick();
    expect(runLocal).toHaveBeenCalledTimes(3);
    expect((await store.snapshot()).jobs[0]).toMatchObject({ status: 'done', runMode: 'on_device' });
  } finally { scheduler.stop(); store.close(); }
});
it('makes zero cloud adapter or reservation calls for local-only short work after opt-in', async () => {
  const store = await openLocalStore(`short-cloud-path-${crypto.randomUUID()}`);
  const adapter = vi.fn<CloudProcessingAdapter>().mockResolvedValue({ source: 'in_cloud', text: '{"items":[]}' });
  const cloud = new CloudProcessingService(store, adapter, () => true, () => 'model', () => {});
  const local = { state: { kind: 'unsupported' }, subscribe: () => () => {}, runLocal: vi.fn() } as LocalService;
  const router = modeRouter(local, cloud, () => store.cloudModeConsent(), () => true, () => true);
  const scheduler = new Scheduler(store, router, () => 'extract.v2', () => {}, () => 4000);
  try {
    await store.saveNotebook('- one\n- two\n- three', 0); await scheduler.start();
    expect((await store.snapshot()).jobs[0]).toMatchObject({ status: 'pending', cloudEligible: false });
    await store.setCloudModeConsent(true); await scheduler.tick();
    expect(adapter).not.toHaveBeenCalled();
    expect((await store.snapshot()).cloudProcessingSends).toEqual([]);
  } finally { scheduler.stop(); store.close(); }
});
it('repairs an already-promoted legacy short job at cloud claim', async () => {
  const name = `legacy-short-${crypto.randomUUID()}`;
  const store = await openLocalStore(name);
  try {
    await store.saveNotebook('- one\n- two\n- three', 0);
    await store.enqueueSettled(4000, 'extract.v2');
    await store.setCloudModeConsent(true);
    const raw = await openDB(name, STORE_VERSION);
    const job = (await raw.getAll('jobs'))[0];
    await raw.put('jobs', { ...job, runMode: 'in_cloud', cloudEligible: true }); raw.close();
    expect(await store.claim(4000, 'in_cloud')).toBeNull();
    expect((await store.snapshot()).jobs[0]).toMatchObject({ status: 'pending', runMode: 'on_device',
      cloudEligible: false });
    await store.setCloudModeConsent(false);
    expect(await store.claim(4000, 'on_device')).not.toBeNull();
  } finally { store.close(); }
});
it('uses one cloud call for a structured paragraph', async () => {
  const store = await openLocalStore(`cloud-row-${crypto.randomUUID()}`);
  const runLocal = vi.fn().mockResolvedValue(result('item', 'in_cloud'));
  const scheduler = new Scheduler(store, { state: { kind: 'ready' }, subscribe: () => () => {}, runLocal,
    isReadyFor: async () => true }, () => 'extract.v2', () => {}, () => 4000);
  try {
    await store.saveNotebook(list, 0); await store.setCloudModeConsent(true); await scheduler.start();
    expect(runLocal).toHaveBeenCalledOnce();
    expect(runLocal.mock.calls[0][0].prompt).toContain(list);
    expect((await store.snapshot()).jobs.find(job => job.step === 'extract')).toMatchObject({ status: 'done' });
  } finally { scheduler.stop(); store.close(); }
});
it('discards a partial batch when processing mode changes', async () => {
  const store = await openLocalStore(`mode-row-${crypto.randomUUID()}`);
  let scheduler: Scheduler;
  const runLocal = vi.fn().mockImplementation(async () => {
    scheduler.modeChanged(); await store.setCloudModeConsent(true);
    return result('item describes a');
  });
  scheduler = new Scheduler(store, { state: { kind: 'ready' }, subscribe: () => () => {}, runLocal },
    () => 'extract.v2', () => {}, () => 4000);
  try {
    await store.saveNotebook(list, 0); await scheduler.start();
    const state = await store.snapshot();
    expect(runLocal).toHaveBeenCalledOnce();
    expect(state.items).toEqual([]);
    expect(state.jobs.find(job => job.step === 'extract')).toMatchObject({ status: 'pending' });
  } finally { scheduler.stop(); store.close(); }
});
it('returns a hidden mid-sequence job to pending without partial items', async () => {
  const store = await openLocalStore(`hidden-row-${crypto.randomUUID()}`);
  const listeners = new Set<() => void>();
  const doc = { visibilityState: 'visible', addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn) };
  vi.stubGlobal('document', doc);
  const runLocal = vi.fn().mockImplementation(async () => {
    doc.visibilityState = 'hidden'; for (const listener of listeners) listener();
    return result('item describes a');
  });
  const scheduler = new Scheduler(store, { state: { kind: 'ready' }, subscribe: () => () => {}, runLocal },
    () => 'extract.v2', () => {}, () => 4000);
  try {
    await store.saveNotebook(list, 0); await scheduler.start();
    const state = await store.snapshot();
    expect(runLocal).toHaveBeenCalledOnce();
    expect(state.items).toEqual([]);
    expect(state.jobs.find(job => job.step === 'extract')).toMatchObject({ status: 'pending', attempts: 0 });
  } finally { scheduler.stop(); store.close(); }
});
