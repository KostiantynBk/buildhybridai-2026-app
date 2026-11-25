import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { LocalModelService, LOCAL_GENERATION_TIMEOUT_MS, type Model } from '../ai/localModel';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NotebookPanel } from './NotebookPanel';
import { CheckShortlist } from './CheckShortlist';
import { openDB } from 'idb';
import { STORE_VERSION } from '../store';
import { openLocalStore, type LocalStore } from '../store';
import { Scheduler, type LocalService } from '../store/scheduler';
import { pickV1 } from '../pipeline/prompts/pick.v1';
import type { Job } from '../ai/localModel';
import { PickShortlist } from './pickShortlist';

afterEach(() => vi.unstubAllGlobals());
async function fourMarks(store: LocalStore) {
  const plan = Array.from({ length: 4 }, (_, i) =>
    `Plan paragraph ${i} assumes a public service supports enough visitors for a useful launch.`).join('\n\n');
  await store.saveNotebook(plan, 0); await store.enqueueSettled(4000, 'extract.v2');
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
  return plan;
}
const newParagraph = 'A fifth fictional paragraph contains enough words to require extraction after its settle window.';

it('does not pick a saved settling paragraph even before its extraction job exists', async () => {
  const store = await openLocalStore(`pick-settling-${crypto.randomUUID()}`);
  const plan = await fourMarks(store);
  await store.saveNotebook(`${plan}\n\n${newParagraph}`, 5000);
  const pick = vi.fn();
  const picker = new PickShortlist(() => {});
  const service = { state: { kind: 'ready' }, subscribe: () => () => {}, runLocal: pick } as unknown as LocalService;
  const scheduler = new Scheduler(store, service, () => 'extract.v2', () => {}, () => 5001, () => {},
    (s, local, signal, version, now) => picker.run(s, local, signal, version, now));
  try {
    await scheduler.start();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(pick).not.toHaveBeenCalled();
    expect((await store.snapshot()).jobs.filter(job => job.step === 'extract')).toHaveLength(4);
  } finally { scheduler.stop(); store.close(); }
});

it('enqueues newly settled peer work during a held pick and never adopts the old result', async () => {
  const store = await openLocalStore(`pick-peer-append-${crypto.randomUUID()}`);
  const plan = await fourMarks(store);
  let clock = 5000;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const local = { state: { kind: 'ready' }, subscribe: () => () => {},
    runLocal: async (job: Job<unknown>) => {
      if (job.instructions === pickV1) {
        if (job.beforeDispatch && !await job.beforeDispatch()) throw new Error('cancelled');
        job.onDispatch?.(); calls.push('pick'); await gate;
        return { data: { picks: [4] }, source: 'on_device', latencyMs: 1, raw: '' };
      }
      await gate; calls.push('extract');
      return { data: { items: [] }, source: 'on_device', latencyMs: 1, raw: '' };
    } } as unknown as LocalService;
  const picker = new PickShortlist(() => {});
  const scheduler = new Scheduler(store, local, () => 'extract.v2', () => {}, () => clock, () => {},
    (s, service, signal, version, now) => picker.run(s, service, signal, version, now));
  try {
    await scheduler.start();
    await vi.waitFor(() => expect(calls).toEqual(['pick']));
    const before = await store.snapshot();
    await store.saveNotebook(`${plan}\n\n${newParagraph}`, 5000);
    clock = 9001;
    void scheduler.tick();
    await vi.waitFor(async () => expect((await store.snapshot()).jobs.filter(job => job.step === 'extract'))
      .toHaveLength(5));
    const held = await store.snapshot();
    expect(held.jobs.find(job => job.paragraphId === held.paragraphs[4].id && job.step === 'extract'))
      .toMatchObject({ status: 'pending', attempts: 0 });
    const html = renderToStaticMarkup(createElement(NotebookPanel, { text: `${plan}\n\n${newParagraph}`,
      save() {}, storageStatus: 'saved', snapshot: held, configured: true, ready: true,
      activeClaim: scheduler.activeClaim() }));
    expect(html).not.toContain('Reading your paragraph on this device');
    expect(html).not.toContain('Looking for things worth checking');
    expect(calls).toEqual(['pick']);
    release();
    await vi.waitFor(() => expect(calls).toEqual(['pick', 'extract']));
    expect(picker.view(before, false).chosen).toBe(false);
  } finally { release?.(); scheduler.stop(); store.close(); }
});

it.each(['check', 'cloud'] as const)(
  'rechecks peer %s after foreground waiting, before native dispatch', async peer => {
  const store = await openLocalStore(`pick-hidden-${crypto.randomUUID()}`);
  await fourMarks(store);
  const doc = { visibilityState: 'visible' };
  vi.stubGlobal('document', doc);
  let visible = true;
  let notify = () => {};
  const generate = vi.fn(async () => ({ source: 'on_device', text: () => '{"ready":true}' }));
  const model: Model = { prepare: async () => {}, generate };
  const service = new LocalModelService({ configured: true, hasApi: () => true, availability: async () => 'available',
    createModel: () => model, isForeground: () => visible, onForeground: callback => {
      notify = callback; return () => { notify = () => {}; };
    }, now: () => 100 });
  await service.probe(); await service.prepare(); generate.mockClear();
  const delayed = { state: service.state, subscribe: service.subscribe, runLocal: async (job: Job<unknown>) => {
    visible = false; doc.visibilityState = 'hidden';
    return service.runLocal(job);
  } } as unknown as LocalService;
  const picker = new PickShortlist(() => {});
  try {
    const pending = picker.run(store, delayed, new AbortController().signal, () => 'extract.v2', () => 5000);
    await vi.waitFor(() => expect(visible).toBe(false));
    if (peer === 'cloud') await store.setCloudModeConsent(true);
    else await store.requestCheck((await store.snapshot()).items[0].id, 5000);
    visible = true; doc.visibilityState = 'visible'; notify();
    await pending;
    expect(generate).not.toHaveBeenCalled();
    expect(picker.view(await store.snapshot(), peer === 'cloud').chosen).toBe(false);
  } finally { store.close(); }
});it('drops a held pick when a peer appends an unsettled paragraph even before a job exists', async () => {
  const store = await openLocalStore(`pick-peer-unsettled-${crypto.randomUUID()}`);
  const plan = await fourMarks(store);
  let release!: (value: { data: unknown; source: string; latencyMs: number; raw: string }) => void;
  const service = { state: { kind: 'ready' }, subscribe: () => () => {}, runLocal: async (job: Job<unknown>) => {
    if (job.beforeDispatch && !await job.beforeDispatch()) throw new Error('cancelled');
    job.onDispatch?.(); return new Promise(resolve => { release = resolve; });
  } } as unknown as LocalService;
  const picker = new PickShortlist(() => {});
  try {
    const before = await store.snapshot();
    const pending = picker.run(store, service, new AbortController().signal, () => 'extract.v2', () => 5000);
    await vi.waitFor(() => expect(picker.view(before, false).choosing).toBe(true));
    await store.saveNotebook(`${plan}\n\n${newParagraph}`, 5000);
    expect((await store.snapshot()).jobs.filter(job => job.step === 'extract')).toHaveLength(4);
    release({ data: { picks: [4] }, source: 'on_device', latencyMs: 1, raw: '' });
    await pending;
    expect(picker.view(before, false).chosen).toBe(false);
    expect(picker.view(await store.snapshot(), false).chosen).toBe(false);
  } finally { store.close(); }
});
it('does not enqueue a pick into a foreground wait while the tab is hidden', async () => {
  const store = await openLocalStore(`pick-hidden-admission-${crypto.randomUUID()}`);
  await fourMarks(store);
  vi.stubGlobal('document', { visibilityState: 'hidden' });
  const runLocal = vi.fn();
  const service = { state: { kind: 'ready' }, subscribe: () => () => {}, runLocal } as unknown as LocalService;
  const picker = new PickShortlist(() => {});
  const scheduler = new Scheduler(store, service, () => 'extract.v2', () => {}, () => 5000, () => {},
    (s, local, signal, version, now) => picker.run(s, local, signal, version, now));
  try { await scheduler.start(); await new Promise(resolve => setTimeout(resolve, 30));
    expect(runLocal).not.toHaveBeenCalled();
  } finally { scheduler.stop(); store.close(); }
});
it('ignores headings and genuinely ineligible short paragraphs during admission', async () => {
  const store = await openLocalStore(`pick-ineligible-${crypto.randomUUID()}`);
  try {
    const plan = await fourMarks(store);
    await store.saveNotebook(`${plan}\n\n# Heading\n\nShort note`, 5000);
    expect((await store.pickSnapshot('extract.v2', 5001)).ready).toBe(true);
  } finally { store.close(); }
});
it('withholds a pick after extraction until eligible automatic angles have finished', async () => {
  const store = await openLocalStore(`pick-angles-unstarted-${crypto.randomUUID()}`);
  try {
    const plan = await fourMarks(store);
    await store.saveNotebook(`${plan}\n\n${newParagraph}`, 5000);
    await store.enqueueSettled(9001, 'extract.v2');
    const extract = (await store.claim(9001))!;
    await store.complete(extract.job, [{ kind: 'assumption', text: 'New item',
      quote: 'A fifth fictional paragraph', topics: [] }], 9001, 'on_device');
    // The completed peer extraction leaves an unfinalized batch and unlinked item with no pending job.
    const inGap = await store.snapshot();
    expect(inGap.jobs.some(job => job.status === 'pending' || job.status === 'running')).toBe(false);
    expect(inGap.items.some(item => item.text === 'New item' && !item.lineageId)).toBe(true);
    expect((await store.pickSnapshot('extract.v2', 9001)).ready).toBe(false);
    const runLocal = vi.fn();
    const picker = new PickShortlist(() => {});
    await picker.run(store, { state: { kind: 'ready' }, subscribe: () => () => {}, runLocal } as LocalService,
      new AbortController().signal, () => 'extract.v2', () => 9001);
    expect(runLocal).not.toHaveBeenCalled();
    await store.finalizeReady();
    expect((await store.pickSnapshot('extract.v2', 9001)).ready).toBe(false);
    await store.enqueueAngles(9001);
    const angles = (await store.claim(9001))!;
    await store.completeAngles(angles.job, (await store.anglesInput(angles.job))!, [], 's', 9001, 'on_device');
    expect((await store.pickSnapshot('extract.v2', 9001)).ready).toBe(true);
  } finally { store.close(); }
});
it('keeps the actual native lane serialized when a check arrives during a held pick', async () => {
  const store = await openLocalStore(`pick-native-serial-${crypto.randomUUID()}`);
  await fourMarks(store);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  let active = 0;
  let maximum = 0;
  const model: Model = {
    prepare: async () => {},
    generate: async (_prompt, _schema, instructions) => {
      if (!instructions) return { source: 'on_device', text: () => '{"ready":true}' };
      active++; maximum = Math.max(maximum, active);
      if (instructions === pickV1) { calls.push('pick'); await gate; }
      else calls.push('check');
      active--;
      return { source: 'on_device', text: () => instructions === pickV1 ? '{"picks":[4]}' :
        '{"question":"What are the public limits?","keptOut":[]}' };
    },
  };
  const service = new LocalModelService({ configured: true, hasApi: () => true, availability: async () => 'available',
    createModel: () => model, isForeground: () => true, onForeground: () => () => {}, now: () => 5000 });
  await service.probe(); await service.prepare();
  const picker = new PickShortlist(() => {});
  const scheduler = new Scheduler(store, service, () => 'extract.v2', () => {}, () => 5000, () => {},
    (s, local, signal, version, now) => picker.run(s, local, signal, version, now));
  try {
    await scheduler.start();
    await vi.waitFor(() => expect(calls).toEqual(['pick']));
    const before = await store.snapshot();
    scheduler.interruptIdle();
    await store.requestCheck(before.items[0].id, 5000);
    void scheduler.tick();
    await vi.waitFor(async () => expect((await store.snapshot()).jobs.some(job =>
      job.step === 'question' && job.status === 'pending' && job.attempts === 0)).toBe(true));
    expect(calls).toEqual(['pick']); expect(maximum).toBe(1);
    release();
    await vi.waitFor(() => expect(calls).toEqual(['pick', 'check']));
    expect(maximum).toBe(1);
    expect(picker.view(before, false).chosen).toBe(false);
  } finally { release?.(); scheduler.stop(); store.close(); }
});
it('opens only readonly transactions when checking pick admission', async () => {
  const store = await openLocalStore(`pick-readonly-tx-${crypto.randomUUID()}`);
  try {
    await fourMarks(store);
    const transaction = vi.spyOn(IDBDatabase.prototype, 'transaction');
    try {
      expect((await store.pickSnapshot('extract.v2', 5000)).ready).toBe(true);
      expect(transaction).toHaveBeenCalledOnce();
      expect(transaction.mock.calls[0][1]).toBe('readonly');
    } finally { transaction.mockRestore(); }
  } finally { store.close(); }
});
it.each(['timeout', 'device-error'] as const)(
  'does not claim or charge a queued question when the held pick has a %s', async failure => {
    const store = await openLocalStore(`pick-failure-${crypto.randomUUID()}`);
    await fourMarks(store);
    let fireDeadline: (() => void) | undefined;
    let rejectPick!: (error: Error) => void;
    const calls: string[] = [];
    const model: Model = { prepare: async () => {}, generate: async (_prompt, _schema, instructions) => {
      if (!instructions) return { source: 'on_device', text: () => '{"ready":true}' };
      calls.push(instructions === pickV1 ? 'pick' : 'question');
      if (instructions === pickV1) return new Promise((_resolve, reject) => { rejectPick = reject; });
      return { source: 'on_device', text: () => '{"question":"Public limits?","keptOut":[]}' };
    } };
    const service = new LocalModelService({ configured: true, hasApi: () => true,
      availability: async () => 'available', createModel: () => model, isForeground: () => true,
      onForeground: () => () => {}, now: () => 5000 });
    await service.probe(); await service.prepare();
    const originalSetTimeout = globalThis.setTimeout;
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: TimerHandler,
      timeout?: number, ...args: unknown[]) => {
      if (timeout === LOCAL_GENERATION_TIMEOUT_MS && typeof handler === 'function') {
        fireDeadline = () => handler(...args);
      }
      return originalSetTimeout(handler, timeout, ...args);
    }) as typeof setTimeout);
    const picker = new PickShortlist(() => {});
    const scheduler = new Scheduler(store, service, () => 'extract.v2', () => {}, () => 5000, () => {},
      (s, local, signal, version, now) => picker.run(s, local, signal, version, now));
    try {
      await scheduler.start();
      await vi.waitFor(() => expect(calls).toEqual(['pick']));
      const item = (await store.snapshot()).items[0];
      scheduler.interruptIdle();
      await store.requestCheck(item.id, 5000);
      await scheduler.tick();
      let job = (await store.snapshot()).jobs.find(value => value.step === 'question')!;
      expect(job).toMatchObject({ status: 'pending', attempts: 0, nextRunAt: 5000 });
      if (failure === 'timeout') { expect(fireDeadline).toBeTypeOf('function'); fireDeadline!(); }
      else rejectPick(new Error('fictional device failure'));
      await vi.waitFor(() => expect(service.state.kind).toBe(failure === 'timeout' ? 'stalled' : 'error'));
      await new Promise(resolve => originalSetTimeout(resolve, 30));
      job = (await store.snapshot()).jobs.find(value => value.step === 'question')!;
      expect(job).toMatchObject({ status: 'pending', attempts: 0, nextRunAt: 5000 });
      expect(calls).toEqual(['pick']);
      if (failure === 'device-error') expect(service.retryRequired).toBe(true);
    } finally { rejectPick?.(new Error('settle fake')); scheduler.stop(); timer.mockRestore(); store.close(); }
  }, 15000);
it('keeps peer-created angles pending with no active Looking status until the held pick ends', async () => {
  const store = await openLocalStore(`pick-angles-held-${crypto.randomUUID()}`);
  const plan = await fourMarks(store);
  let clock = 5000;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const service = { state: { kind: 'ready' }, subscribe: () => () => {}, runLocal: async (job: Job<unknown>) => {
    if (job.instructions === pickV1) {
      if (job.beforeDispatch && !await job.beforeDispatch()) throw new Error('cancelled');
      job.onDispatch?.(); calls.push('pick'); await gate;
      return { data: { picks: [4] }, source: 'on_device', latencyMs: 1, raw: '' };
    }
    calls.push('angles'); return { data: { concerns: [] }, source: 'on_device', latencyMs: 1, raw: '' };
  } } as unknown as LocalService;
  const picker = new PickShortlist(() => {});
  const scheduler = new Scheduler(store, service, () => 'extract.v2', () => {}, () => clock, () => {},
    (s, local, signal, version, now) => picker.run(s, local, signal, version, now));
  try {
    await scheduler.start(); await vi.waitFor(() => expect(calls).toEqual(['pick']));
    await store.saveNotebook(`${plan}\n\n${newParagraph}`, 5000);
    clock = 9001;
    await store.enqueueSettled(clock, 'extract.v2');
    const peerExtract = (await store.claim(clock))!;
    await store.complete(peerExtract.job, [{ kind: 'assumption', text: 'New item',
      quote: 'A fifth fictional paragraph', topics: [] }], clock, 'on_device');
    await store.finalizeReady(); await store.enqueueAngles(clock);
    await scheduler.tick();
    const state = await store.snapshot();
    const newId = state.paragraphs.find(value => value.text === newParagraph)!.id;
    expect(state.jobs.find(job => job.step === 'angles' && job.paragraphId === newId))
      .toMatchObject({ status: 'pending', attempts: 0 });
    const panel = renderToStaticMarkup(createElement(NotebookPanel, { text: `${plan}\n\n${newParagraph}`,
      save() {}, storageStatus: 'saved', snapshot: state, configured: true, ready: true,
      activeClaim: scheduler.activeClaim() }));
    const shortlist = renderToStaticMarkup(createElement(CheckShortlist, { snapshot: state, view: 'all',
      setView() {}, check() {}, ready: true, activeClaim: scheduler.activeClaim() }));
    expect(panel).not.toContain('Looking for things worth checking');
    expect(shortlist).not.toContain('Still looking for things worth checking');
    expect(calls).toEqual(['pick']);
    release(); await vi.waitFor(() => expect(calls).toEqual(['pick', 'angles']));
  } finally { release?.(); scheduler.stop(); store.close(); }
});
it('does not infer considered status from unlinked current items, even if a batch row is missing', async () => {
  const name = `pick-unlinked-${crypto.randomUUID()}`;
  const store = await openLocalStore(name);
  try {
    const plan = await fourMarks(store);
    await store.saveNotebook(`${plan}\n\n${newParagraph}`, 5000);
    await store.enqueueSettled(9001, 'extract.v2');
    const extract = (await store.claim(9001))!;
    await store.complete(extract.job, [{ kind: 'assumption', text: 'New unlinked item',
      quote: 'A fifth fictional paragraph', topics: [] }], 9001, 'on_device');
    const db = await openDB(name, STORE_VERSION);
    for (const key of await db.getAllKeys('comparisonBatches')) await db.delete('comparisonBatches', key);
    db.close();
    expect((await store.pickSnapshot('extract.v2', 9001)).ready).toBe(false);
  } finally { store.close(); }
});
it.each(['migrated-card', 'migrated-current'] as const)(
  'accepts established %s consideration records as already processed', async source => {
    const name = `pick-migrated-${crypto.randomUUID()}`;
    const store = await openLocalStore(name);
    try {
      await fourMarks(store);
      const db = await openDB(name, STORE_VERSION);
      for (const record of await db.getAll('anglesConsidered')) await db.put('anglesConsidered', { ...record, source });
      db.close();
      expect((await store.pickSnapshot('extract.v2', 5000)).ready).toBe(true);
    } finally { store.close(); }
  });
