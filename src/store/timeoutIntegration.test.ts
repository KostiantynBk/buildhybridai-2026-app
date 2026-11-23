import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { LocalModelService, LOCAL_GENERATION_TIMEOUT_MS, type Dependencies } from '../ai/localModel';
import { openLocalStore } from './index';
import { Scheduler } from './scheduler';

afterEach(() => vi.useRealTimers());
it.each(['resolve', 'reject'] as const)(
  'times out the native call and ignores a late %s', async outcome => {
  let release!: (value: { source: string; text: () => string }) => void;
  let reject!: (error: Error) => void;
  const generate = vi.fn().mockResolvedValueOnce({ source: 'on_device', text: () => '{"ready":true}' })
    .mockImplementationOnce(() => new Promise((resolve, fail) => { release = resolve; reject = fail; }));
  const deps: Dependencies = { configured: true, hasApi: () => true, availability: async () => 'available',
    createModel: () => ({ prepare: async () => {}, generate }), isForeground: () => true,
    onForeground: () => () => {}, now: Date.now };
  const service = new LocalModelService(deps);
  await service.probe(); await service.prepare();
  const store = await openLocalStore(`native-timeout-${crypto.randomUUID()}`);
  const scheduler = new Scheduler(store, service, () => 'extract.v2', () => {}, () => 4000);
  try {
    await store.saveNotebook('This plan contains enough words to run the first local extraction test safely.', 0);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const starting = scheduler.start();
    await vi.waitFor(() => expect(release).toBeDefined());
    await vi.advanceTimersByTimeAsync(LOCAL_GENERATION_TIMEOUT_MS);
    await starting;
    expect(service.state.kind).toBe('stalled');
    expect((await store.snapshot()).jobs[0]).toMatchObject({ status: 'pending', attempts: 1,
      errorName: 'TimeoutError' });
    await scheduler.tick();
    expect(generate).toHaveBeenCalledTimes(2);
    if (outcome === 'resolve') release({ source: 'on_device', text: () =>
      '{"items":[{"kind":"assumption","text":"old","quote":"plan","topics":[]}]}' });
    else reject(new Error('late failure'));
    await Promise.resolve();
    expect((await store.snapshot()).items).toEqual([]);
    expect((await store.snapshot()).jobs[0]).toMatchObject({ status: 'pending', attempts: 1 });
    scheduler.stop();
    const freshGenerate = vi.fn().mockResolvedValueOnce({ source: 'on_device', text: () => '{"ready":true}' })
      .mockResolvedValueOnce({ source: 'on_device', text: () => '{"items":[]}' });
    const freshService = new LocalModelService({ ...deps, createModel: () => ({ prepare: async () => {},
      generate: freshGenerate }) });
    await freshService.probe(); await freshService.prepare();
    const reloaded = new Scheduler(store, freshService, () => 'extract.v2', () => {}, () => 10000);
    try {
      await reloaded.start();
      expect((await store.snapshot()).jobs[0]).toMatchObject({ status: 'done', attempts: 2 });
    } finally { reloaded.stop(); }
  } finally { scheduler.stop(); store.close(); }
}, 15000);
