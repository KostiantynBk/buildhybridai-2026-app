import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalStore, openLocalStore } from './index';
import { Scheduler, type LocalService } from './scheduler';
import { LocalError } from '../ai/localModel';

const long = 'one two three four five six seven eight nine ten eleven twelve thirteen';
const result = { data: { items: [{ kind: 'assumption', text: 'test', quote: 'one two three', topics: ['other'] }] },
  latencyMs: 1, source: 'on_device', raw: '{}' };
let store: LocalStore;
let scheduler: Scheduler | undefined;
const flush = async () => { for (let i = 0; i < 120; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
function fakeService(run = vi.fn(async () => result)) {
  const service = { state: { kind: 'ready' }, subscribe: () => () => {}, runLocal: run };
  return { service: service as unknown as LocalService, run, state: service.state };
}
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(10000);
  store = await openLocalStore(`scheduler-${crypto.randomUUID()}`);
});
afterEach(() => { scheduler?.stop(); scheduler = undefined; store.close(); vi.useRealTimers(); });

describe('durable scheduler', () => {
  it('waits for 4 seconds and 12 words, then dispatches once', async () => {
    const { service, run } = fakeService();
    scheduler = new Scheduler(store, service, () => 'extract.v2', () => {});
    await scheduler.start();
    await store.saveNotebook(`${long}\n\ntoo short`, Date.now());
    vi.setSystemTime(13999);
    await scheduler.tick();
    expect(run).not.toHaveBeenCalled();
    vi.setSystemTime(14000);
    await scheduler.tick();
    expect(run).toHaveBeenCalledTimes(1);
    const snapshot = await store.snapshot();
    expect(snapshot.jobs.filter(job => job.step === 'extract')).toHaveLength(1);
    expect(snapshot.jobs.find(job => job.step === 'extract')?.status).toBe('done');
    expect(snapshot.items[0]).toMatchObject({ promptVersion: 'extract.v2', quote: 'one two three' });
  });
  it('automatically wakes on the timer after the settle interval', async () => {
    const { service, run } = fakeService();
    scheduler = new Scheduler(store, service, () => 'extract.v2', () => {});
    await scheduler.start();
    await store.saveNotebook(long, Date.now());
    await vi.advanceTimersByTimeAsync(3000);
    await flush();
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('drops a pending changed version before dispatch', async () => {
    const { service, run, state } = fakeService();
    state.kind = 'unavailable';
    scheduler = new Scheduler(store, service, () => 'extract.v2', () => {});
    await scheduler.start();
    await store.saveNotebook(long, 0);
    await scheduler.tick();
    await store.saveNotebook(`${long} fourteen`, 10000);
    state.kind = 'ready';
    await scheduler.tick();
    expect(run).not.toHaveBeenCalled();
    expect((await store.snapshot()).jobs[0].status).toBe('superseded');
  });
  it('discards a result when its paragraph changes before storage', async () => {
    let complete!: (value: typeof result) => void;
    const run = vi.fn(() => new Promise<typeof result>(resolve => { complete = resolve; }));
    const { service } = fakeService(run);
    scheduler = new Scheduler(store, service, () => 'extract.v2', () => {});
    await scheduler.start();
    await store.saveNotebook(long, 0);
    const pending = scheduler.tick();
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    scheduler.edited();
    await store.saveNotebook(`${long} fourteen`, Date.now());
    scheduler.saved();
    complete(result);
    await pending;
    const snapshot = await store.snapshot();
    expect(snapshot.items).toHaveLength(0);
    expect(snapshot.jobs[0].status).toBe('superseded');
  });
  it('recovers an interrupted running job after reload when the model is ready', async () => {
    await store.saveNotebook(long, 0);
    await store.enqueueSettled(4000, 'extract.v2');
    expect((await store.claim(4000))?.job.status).toBe('running');
    const { service, run, state } = fakeService();
    state.kind = 'downloadable';
    scheduler = new Scheduler(store, service, () => 'extract.v2', () => {});
    await scheduler.start();
    expect((await store.snapshot()).jobs[0].status).toBe('pending');
    expect(run).not.toHaveBeenCalled();
    state.kind = 'ready';
    await scheduler.tick();
    expect(run).toHaveBeenCalledTimes(1);
    expect((await store.snapshot()).jobs[0].status).toBe('done');
  });
  it('halts further dispatches on an unverified source', async () => {
    const run = vi.fn(async () => { throw new LocalError('privacy-fault', 'unsafe source'); });
    const { service } = fakeService(run as never);
    scheduler = new Scheduler(store, service, () => 'extract.v2', () => {});
    await scheduler.start();
    await store.saveNotebook(`${long}\n\n${long} different`, 0);
    await scheduler.tick();
    await scheduler.tick();
    expect(run).toHaveBeenCalledTimes(1);
    expect((await store.snapshot()).jobs.map(job => job.status).sort()).toEqual(['failed', 'pending']);
  });
  it('retries with backoff, stops after three failures and stores only safe error names', async () => {
    const run = vi.fn(async () => { throw new Error('private sentinel'); });
    const { service } = fakeService(run as never);
    scheduler = new Scheduler(store, service, () => 'extract.v2', () => {});
    await scheduler.start();
    await store.saveNotebook(long, 0);
    await scheduler.tick();
    await scheduler.tick();
    expect(run).toHaveBeenCalledTimes(1);
    vi.setSystemTime(15000);
    await scheduler.tick();
    vi.setSystemTime(25000);
    await scheduler.tick();
    const job = (await store.snapshot()).jobs[0];
    expect(run).toHaveBeenCalledTimes(3);
    expect(job).toMatchObject({ status: 'failed', attempts: 3, errorName: 'Error' });
    expect(JSON.stringify(job)).not.toContain('private sentinel');
  });
});
