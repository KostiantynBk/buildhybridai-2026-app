import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';
import { openLocalStore, type LocalStore } from '../store';
import { Scheduler, type LocalService } from '../store/scheduler';
import type { Job } from '../ai/localModel';
import { pickV1 } from '../pipeline/prompts/pick.v1';
import { PickShortlist } from './pickShortlist';

async function prepareMarks(store: LocalStore) {
  const text = Array.from({ length: 4 }, (_, i) =>
    `Plan paragraph ${i} assumes a fictional public service supports enough visitors for a useful launch.`)
    .join('\n\n');
  await store.saveNotebook(text, 0); await store.enqueueSettled(4000, 'extract.v2');
  for (let i = 0; i < 4; i++) {
    const extract = (await store.claim(4000 + i))!;
    await store.complete(extract.job, [{ kind: 'assumption', text: `Finding ${i}`,
      quote: `Plan paragraph ${i}`, topics: [] }], 4000 + i, 'on_device');
    await store.finalizeReady(); await store.enqueueAngles(4000 + i);
    const angles = (await store.claim(4000 + i))!;
    await store.completeAngles(angles.job, (await store.anglesInput(angles.job))!, [{ item: 1, angle: 'end-user',
      concern: 'Could real visitors use this fictional public service?', checkable: true }],
    's', 4000 + i, 'on_device');
  }
}

it('finishes a held pick before an explicit check, discards it, then runs the check promptly', async () => {
  const store = await openLocalStore(`pick-scheduler-${crypto.randomUUID()}`);
  await prepareMarks(store);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const runLocal = vi.fn(async (job: Job<unknown>) => {
    job.onDispatch?.();
    if (job.instructions === pickV1) {
      calls.push('pick'); await gate;
      return { data: { picks: [4] }, source: 'on_device', latencyMs: 1, raw: '' };
    }
    calls.push('check');
    return { data: { question: 'What are the public limits?', keptOut: [] },
      source: 'on_device', latencyMs: 1, raw: '' };
  }) as unknown as LocalService['runLocal'];
  const service: LocalService = { state: { kind: 'ready' }, subscribe: () => () => {}, runLocal };
  const picker = new PickShortlist(() => {});
  const scheduler = new Scheduler(store, service, () => 'extract.v2', () => {}, () => 5000, () => {},
    (s, local, signal) => picker.run(s, local, signal));
  try {
    const start = scheduler.start();
    await vi.waitFor(() => expect(calls).toEqual(['pick']));
    const beforeCheck = await store.snapshot();
    const item = beforeCheck.items[0];
    scheduler.interruptIdle();
    const request = await store.requestCheck(item.id, 5000);
    expect(request.cardId).toBeTruthy();
    expect(calls).toEqual(['pick']);
    release(); await start;
    await vi.waitFor(() => expect(calls).toEqual(['pick', 'check']));
    expect(picker.view(beforeCheck, false).chosen).toBe(false);
    expect(picker.view(await store.snapshot(), false).chosen).toBe(false);
  } finally { release?.(); scheduler.stop(); store.close(); }
}, 15000);

it('does not write pick inputs, outputs or jobs to IndexedDB', async () => {
  const store = await openLocalStore(`pick-readonly-${crypto.randomUUID()}`);
  try {
    await prepareMarks(store);
    const picker = new PickShortlist(() => {});
    const before = await store.snapshot();
    const put = vi.spyOn(IDBObjectStore.prototype, 'put');
    const add = vi.spyOn(IDBObjectStore.prototype, 'add');
    const remove = vi.spyOn(IDBObjectStore.prototype, 'delete');
    const runLocal = vi.fn(async (job: Job<unknown>) => {
      job.onDispatch?.(); return { data: { picks: [4, 2] }, source: 'on_device', latencyMs: 1, raw: '' };
    });
    try {
      await picker.run(store, { state: { kind: 'ready' }, subscribe: () => () => {},
        runLocal: runLocal as unknown as LocalService['runLocal'] }, new AbortController().signal);
      expect(runLocal).toHaveBeenCalledOnce();
      expect(picker.view(await store.snapshot(), false).chosen).toBe(true);
      expect(await store.snapshot()).toEqual(before);
      expect(put).not.toHaveBeenCalled(); expect(add).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
    } finally { put.mockRestore(); add.mockRestore(); remove.mockRestore(); }
  } finally { store.close(); }
});
it('does not run the picker in cloud mode even when four marks are present', async () => {
  const store = await openLocalStore(`pick-cloud-${crypto.randomUUID()}`);
  await prepareMarks(store);
  await store.setCloudModeConsent(true);
  const runLocal = vi.fn();
  const service = { state: { kind: 'ready' }, subscribe: () => () => {}, runLocal } as unknown as LocalService;
  const picker = new PickShortlist(() => {});
  const scheduler = new Scheduler(store, service, () => 'extract.v2', () => {}, () => 5000, () => {},
    (s, local, signal) => picker.run(s, local, signal));
  try {
    await scheduler.start();
    expect(runLocal).not.toHaveBeenCalled();
    expect(picker.view(await store.snapshot(), true).chosen).toBe(false);
  } finally { scheduler.stop(); store.close(); }
});
