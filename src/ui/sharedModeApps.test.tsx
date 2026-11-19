import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LocalStore, openLocalStore, STORE_VERSION } from '../store';
import { openDB } from 'idb';

const h = vi.hoisted(() => {
  type Instance = { slots: unknown[]; index: number; effects: Array<() => void>; cleanups: Array<() => void> };
  let current: Instance;
  return {
    newInstance: (): Instance => ({ slots: [], index: 0, effects: [], cleanups: [] }),
    enter(instance: Instance) { current = instance; instance.index = 0; },
    useState<T>(initial: T | (() => T)) {
      const instance = current; const i = instance.index++;
      if (!(i in instance.slots)) instance.slots[i] = typeof initial === 'function' ? (initial as () => T)() : initial;
      return [instance.slots[i], (value: T | ((old: T) => T)) => {
        instance.slots[i] = typeof value === 'function' ? (value as (old: T) => T)(instance.slots[i] as T) : value;
      }] as [T, (value: T | ((old: T) => T)) => void];
    },
    useRef<T>(value: T) {
      const instance = current; const i = instance.index++;
      if (!(i in instance.slots)) instance.slots[i] = { current: value };
      return instance.slots[i] as { current: T };
    },
    useMemo<T>(factory: () => T) {
      const instance = current; const i = instance.index++;
      if (!(i in instance.slots)) instance.slots[i] = factory();
      return instance.slots[i] as T;
    },
    useEffect(effect: () => void | (() => void)) {
      const instance = current; const i = instance.index++;
      if (i in instance.slots) return;
      instance.slots[i] = true;
      instance.effects.push(() => { const cleanup = effect(); if (cleanup) instance.cleanups.push(cleanup); });
    },
  };
});
vi.mock('react', async importOriginal => ({ ...await importOriginal<typeof import('react')>(),
  useState: h.useState, useRef: h.useRef, useMemo: h.useMemo, useEffect: h.useEffect }));
const adapter = vi.hoisted(() => vi.fn().mockResolvedValue({ source: 'in_cloud', text: '{"items":[]}' }));
const researchAdapter = vi.hoisted(() => vi.fn().mockResolvedValue({ source: 'in_cloud', result: {
  text: 'Grounded answer fixture', parts: ['Grounded answer fixture'], sources: [], supports: [],
  suggestions: '', grounded: false,
} }));
vi.mock('../ai/cloudResearch', async importOriginal => ({
  ...await importOriginal<typeof import('../ai/cloudResearch')>(), createCloudAdapter: () => researchAdapter,
}));
vi.mock('../ai/cloudProcessing', async importOriginal => ({
  ...await importOriginal<typeof import('../ai/cloudProcessing')>(), createProcessingAdapter: () => adapter,
}));
vi.mock('./service', () => ({ config: { apiKey: 'example', authDomain: 'example', projectId: 'example',
  appId: 'example', siteKey: 'example', dev: true, debug: false },
  createService: () => ({ state: { kind: 'unsupported' }, browserAvailability: 'unsupported',
    warmLatencyMs: null, privacyFaults: 0, preparing: false, retryRequired: false,
    subscribe: () => () => {}, runLocal: vi.fn() }), startReadiness: () => () => {}, useForeground: () => true }));
vi.mock('../settings/remoteSettings', async () => {
  const { builtInSettings } = await import('../settings/defaults');
  return { loadSettings: async () => builtInSettings() };
});
import App from './App';
import { DraftControls } from './DraftControls';
import { OutboxPage } from './OutboxPage';

type Instance = ReturnType<typeof h.newInstance>;
function render(instance: Instance): ReactElement {
  h.enter(instance);
  return App({});
}
function mount(instance: Instance) {
  render(instance);
  for (const effect of instance.effects.splice(0)) effect();
}
function nodes(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  return [element, ...nodes(element.props.children)];
}
function component(instance: Instance, name: string): Record<string, any> {
  const element = nodes(render(instance)).find(value => typeof value.type === 'function' && value.type.name === name);
  if (!element) throw new Error(`Missing ${name}`);
  return element.props as Record<string, any>;
}
function clickNav(instance: Instance, name: string) {
  const button = nodes(render(instance)).find(element => element.type === 'button' &&
    (element.props as { children?: string }).children === name);
  if (!button) throw new Error(`Missing ${name} navigation`);
  (button.props as { onClick(): void }).onClick();
}
class Channel {
  static channels = new Set<Channel>();
  onmessage: (() => void) | null = null;
  constructor(_name: string) { Channel.channels.add(this); }
  postMessage() {
    for (const channel of Channel.channels) if (channel !== this) queueMicrotask(() => channel.onmessage?.());
  }
  close() { Channel.channels.delete(this); }
}
const listeners = new Map<string, Set<() => void>>();
function add(type: string, callback: () => void) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type)!.add(callback);
}
function remove(type: string, callback: () => void) { listeners.get(type)?.delete(callback); }
afterEach(() => {
  vi.unstubAllGlobals(); listeners.clear(); Channel.channels.clear(); adapter.mockClear(); researchAdapter.mockClear();
});

it('reconciles two mounted App instances on opt-in, opt-out and a missed broadcast', async () => {
  vi.stubGlobal('BroadcastChannel', Channel);
  vi.stubGlobal('window', { confirm: () => true, addEventListener: add, removeEventListener: remove });
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: add, removeEventListener: remove });
  vi.stubGlobal('localStorage', { getItem: () => null, removeItem: () => {} });
  const seed = await openLocalStore();
  await seed.clearAll({ getItem: () => null, removeItem: () => {} });
  await seed.saveNotebook('This initial paragraph has enough words to create a waiting extraction for the test.', 0);
  const a = h.newInstance(); const b = h.newInstance();
  try {
    mount(a); mount(b);
    await vi.waitFor(() => {
      expect(component(a, 'NotebookPanel').storageStatus).toBe('saved');
      expect(component(b, 'NotebookPanel').storageStatus).toBe('saved');
    });
    await seed.enqueueSettled(Date.now(), 'extract.v2');
    expect((await seed.snapshot()).jobs[0].runMode).toBe('on_device');
    component(b, 'Notices').chooseCloud();
    await vi.waitFor(() => {
      expect(component(a, 'StatusBar').cloudMode).toBe(true);
      expect(component(a, 'NotebookPanel').cloudMode).toBe(true);
      expect(component(b, 'StatusBar').cloudMode).toBe(true);
    });
    await vi.waitFor(() => expect(adapter).toHaveBeenCalled());
    expect((await seed.snapshot()).jobs[0]).toMatchObject({ runMode: 'in_cloud', measuredSource: 'in_cloud' });
    component(a, 'NotebookPanel').save(
      'This initial paragraph has enough words to create a waiting extraction for the cloud test.');
    await vi.waitFor(() => expect(component(a, 'NotebookPanel').storageStatus).toBe('saved'));
    await seed.enqueueSettled(Date.now() + 5000, 'extract.v2', 'on_device');
    const cloudJob = (await seed.snapshot()).jobs.find(job => job.paragraphVersion === 2);
    expect(cloudJob?.runMode).toBe('in_cloud');
    const raw = await openDB('thoughtpartner', STORE_VERSION);
    try {
      await raw.put('jobs', { ...cloudJob, key: 'other-tab-running', step: 'angles', promptVersion: 'angles.v2.1',
        status: 'running', runMode: 'in_cloud' });
    } finally { raw.close(); }
    clickNav(a, 'Profile');
    await component(a, 'ProfilePanel').revokeCloudMode();
    await vi.waitFor(() => expect(component(b, 'StatusBar').cloudMode).toBe(false));
    const cancelled = await seed.snapshot();
    expect(cancelled.jobs.find(job => job.key === cloudJob?.key)?.status).toBe('failed');
    expect(cancelled.jobs.find(job => job.key === 'other-tab-running')?.status).toBe('failed');
    component(b, 'NotebookPanel').save(
      'This initial paragraph has enough words to create a waiting extraction for the local test.');
    await vi.waitFor(() => expect(component(b, 'NotebookPanel').storageStatus).toBe('saved'));
    await seed.enqueueSettled(Date.now() + 5000, 'extract.v2', 'in_cloud');
    expect((await seed.snapshot()).jobs.find(job => job.paragraphVersion === 3)?.runMode).toBe('on_device');
    await seed.setCloudModeConsent(true); // Deliberately omit broadcast; a routine save refresh must reconcile.
    component(b, 'NotebookPanel').save(
      'This initial paragraph has enough words to create a waiting extraction for the later test.');
    await vi.waitFor(() => expect(component(b, 'StatusBar').cloudMode).toBe(true));
    await seed.setCloudModeConsent(false); // Deliberately omit broadcast again; focus must also reconcile.
    for (const callback of listeners.get('focus') ?? []) callback();
    await vi.waitFor(() => expect(component(b, 'StatusBar').cloudMode).toBe(false));
    await seed.setCloudModeConsent(true);
    for (const callback of listeners.get('visibilitychange') ?? []) callback();
    await vi.waitFor(() => expect(component(b, 'StatusBar').cloudMode).toBe(true));
  } finally {
    for (const cleanup of [...a.cleanups, ...b.cleanups]) cleanup();
    seed.close();
  }
}, 15000);

it('queues exactly one question when two App trees check the same mark', async () => {
  vi.stubGlobal('BroadcastChannel', Channel);
  vi.stubGlobal('window', { confirm: () => true, addEventListener: add, removeEventListener: remove });
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: add, removeEventListener: remove });
  vi.stubGlobal('localStorage', { getItem: () => null, removeItem: () => {} });
  const seed = await openLocalStore();
  await seed.clearAll({ getItem: () => null, removeItem: () => {} });
  const paragraph = 'The hosting service supports fifty visitors while serving a public catalogue for users.';
  const quote = 'The hosting service supports fifty visitors';
  await seed.saveNotebook(paragraph, 0); await seed.enqueueSettled(4000, 'extract.v2');
  const extract = await seed.claim(4000);
  await seed.complete(extract!.job, [{ kind: 'assumption', text: 'Fifty visitors', quote, topics: ['hosting'] }], 4000);
  await seed.finalizeReady(); await seed.enqueueAngles(5000);
  const angles = await seed.claim(5000);
  const input = await seed.anglesInput(angles!.job);
  await seed.completeAngles(angles!.job, input!, [{ item: 1, angle: 'end-user',
    concern: 'What are the public hosting limits?', checkable: true }], 's', 5000, 'on_device');
  const state = await seed.snapshot();
  const item = state.items.find(value => value.lineageId === state.cards![0].itemLineageId)!;
  const a = h.newInstance(); const b = h.newInstance();
  try {
    mount(a); mount(b);
    await vi.waitFor(() => {
      expect(component(a, 'NotebookPanel').storageStatus).toBe('saved');
      expect(component(b, 'NotebookPanel').storageStatus).toBe('saved');
    });
    await Promise.all([component(a, 'NotebookPanel').checkThis(item.id),
      component(b, 'NotebookPanel').checkThis(item.id)]);
    expect((await seed.snapshot()).jobs.filter(job => job.step === 'question')).toHaveLength(1);
    expect((await seed.snapshot()).outbox).toHaveLength(0);
    expect(researchAdapter).not.toHaveBeenCalled();
  } finally {
    for (const cleanup of [...a.cleanups, ...b.cleanups]) cleanup();
    seed.close();
  }
}, 15000);

it('shows the persisted withdrawal after a never-send edit immediately after reservation', async () => {
  vi.stubGlobal('BroadcastChannel', Channel);
  vi.stubGlobal('window', { confirm: () => true, addEventListener: add, removeEventListener: remove });
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: add, removeEventListener: remove });
  vi.stubGlobal('localStorage', { getItem: () => null, removeItem: () => {} });
  const seed = await openLocalStore();
  await seed.clearAll({ getItem: () => null, removeItem: () => {} });
  const text = 'The hosting service supports fifty visitors while serving a public catalogue for users.';
  const quote = 'The hosting service supports fifty visitors';
  await seed.saveNotebook(text, 0); await seed.enqueueSettled(4000, 'extract.v2');
  const extract = await seed.claim(4000);
  await seed.complete(extract!.job, [{ kind: 'assumption', text: 'Fifty visitors', quote, topics: ['hosting'] }], 4000);
  await seed.finalizeReady();
  const request = await seed.requestCheck((await seed.snapshot()).items[0].id, 5000);
  const angles = await seed.claim(5000);
  await seed.completeAngles(angles!.job, (await seed.anglesInput(angles!.job))!, [], 's', 5000, 'on_device');
  const reserve = LocalStore.prototype.reserveResearch;
  const spy = vi.spyOn(LocalStore.prototype, 'reserveResearch').mockImplementation(async function (
    this: LocalStore, entry, limit, now) {
    const key = await reserve.call(this, entry, limit, now);
    await this.putNeverSend(['PRIVATE_NAME']);
    return key;
  });
  const app = h.newInstance();
  try {
    mount(app);
    await vi.waitFor(() => expect(component(app, 'NotebookPanel').storageStatus).toBe('saved'));
    await expect(component(app, 'NotebookPanel').sendDraft(request.cardId, 'What about PRIVATE_NAME?'))
      .rejects.toThrow('Approved, not sent');
    const panel = component(app, 'NotebookPanel');
    const snapshot = panel.snapshot;
    const card = snapshot.cards.find((value: { id: string }) => value.id === request.cardId);
    const entry = snapshot.outbox[0];
    expect(entry).toMatchObject({ status: 'withdrawn', withdrawReason: 'listed-term' });
    h.enter(h.newInstance());
    const cardTree = DraftControls({ card, outbox: entry, researchError: panel.researchErrors[entry.id] });
    h.enter(h.newInstance());
    const outboxTree = OutboxPage({ entries: [entry], snapshot, researchErrors: panel.researchErrors,
      decide: async () => false, remove: async () => {} });
    for (const tree of [cardTree, outboxTree]) {
      expect(JSON.stringify(tree)).toContain('Withdrawn: contains a term on your never-send list.');
      expect(JSON.stringify(tree)).not.toContain('Approved, not sent');
    }
    expect(researchAdapter).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
    for (const cleanup of app.cleanups) cleanup();
    seed.close();
  }
}, 15000);

it('shows a failed dispatched search immediately in the actual card and Outbox', async () => {
  vi.stubGlobal('BroadcastChannel', Channel);
  vi.stubGlobal('window', { confirm: () => true, addEventListener: add, removeEventListener: remove });
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: add, removeEventListener: remove });
  vi.stubGlobal('localStorage', { getItem: () => null, removeItem: () => {} });
  researchAdapter.mockRejectedValueOnce(new Error('Research could not be displayed SECRET_PROVIDER_SENTINEL'));
  const seed = await openLocalStore();
  await seed.clearAll({ getItem: () => null, removeItem: () => {} });
  const paragraph = 'The hosting service supports fifty visitors while serving a public catalogue for users.';
  const quote = 'The hosting service supports fifty visitors';
  await seed.saveNotebook(paragraph, 0); await seed.enqueueSettled(4000, 'extract.v2');
  const extract = await seed.claim(4000);
  await seed.complete(extract!.job, [{ kind: 'assumption', text: 'Fifty visitors', quote, topics: ['hosting'] }], 4000);
  await seed.finalizeReady();
  const item = (await seed.snapshot()).items[0];
  const request = await seed.requestCheck(item.id, 5000);
  const angles = await seed.claim(5000);
  await seed.completeAngles(angles!.job, (await seed.anglesInput(angles!.job))!, [], 's', 5000, 'on_device');
  const app = h.newInstance();
  try {
    mount(app);
    await vi.waitFor(() => expect(component(app, 'NotebookPanel').storageStatus).toBe('saved'));
    await expect(component(app, 'NotebookPanel').sendDraft(request.cardId, 'What are hosting limits?'))
      .rejects.toThrow('Sent, but the search failed');
    const snapshot = component(app, 'NotebookPanel').snapshot;
    expect(snapshot.researchReceipts).toMatchObject([{ status: 'failed', failureCode: 'display-invalid' }]);
    expect(JSON.stringify(await seed.snapshot())).not.toContain('SECRET_PROVIDER_SENTINEL');
    const card = snapshot.cards.find((value: { id: string }) => value.id === request.cardId);
    const entry = snapshot.outbox[0];
    h.enter(h.newInstance());
    const cardTree = DraftControls({ card, outbox: entry, receiptStatus: snapshot.researchReceipts[0].status,
      failureCode: snapshot.researchReceipts[0].failureCode });
    expect(JSON.stringify(cardTree)).toContain('Sent, but the search failed');
    h.enter(h.newInstance());
    const outboxTree = OutboxPage({ entries: [entry], snapshot, decide: async () => false, remove: async () => {} });
    expect(JSON.stringify(outboxTree)).toContain('Sent, but the search failed');
    expect(renderToStaticMarkup(cardTree)).not.toContain('SECRET_PROVIDER_SENTINEL');
    expect(renderToStaticMarkup(outboxTree)).not.toContain('SECRET_PROVIDER_SENTINEL');
    expect(researchAdapter).toHaveBeenCalledOnce();
  } finally {
    for (const cleanup of app.cleanups) cleanup();
    seed.close();
  }
}, 15000);

it('approves and starts research once from two card actions; private edits never reach the adapter', async () => {
  vi.stubGlobal('BroadcastChannel', Channel);
  vi.stubGlobal('window', { confirm: () => true, addEventListener: add, removeEventListener: remove });
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: add, removeEventListener: remove });
  vi.stubGlobal('localStorage', { getItem: () => null, removeItem: () => {} });
  const seed = await openLocalStore();
  await seed.clearAll({ getItem: () => null, removeItem: () => {} });
  const paragraph = 'The hosting service supports fifty visitors while serving a public catalogue for users.';
  const quote = 'The hosting service supports fifty visitors';
  await seed.saveNotebook(paragraph, 0); await seed.enqueueSettled(4000, 'extract.v2');
  const extract = await seed.claim(4000);
  if (!extract) throw new Error('Missing extraction');
  await seed.complete(extract.job, [{ kind: 'assumption', text: 'Fifty visitors', quote, topics: ['hosting'] }], 4000);
  await seed.finalizeReady(); await seed.enqueueAngles(5000);
  const angles = await seed.claim(5000);
  if (!angles) throw new Error('Missing angles');
  const input = await seed.anglesInput(angles.job);
  await seed.completeAngles(angles.job, input!, [{ item: 1, angle: 'end-user',
    concern: 'What are the public hosting limits?', checkable: true }], 's', 5000, 'on_device');
  const state = await seed.snapshot();
  const mark = state.cards![0];
  const item = state.items.find(value => value.lineageId === mark.itemLineageId)!;
  await seed.requestCheck(item.id, 6000);
  const question = await seed.claim(6000);
  if (!question) throw new Error('Missing question');
  await seed.completeQuestion(question.job, 'What are hosting limits?', [], true, 7000, 'on_device');
  await seed.putNeverSend(['SECRET_NAME']);
  const a = h.newInstance(); const b = h.newInstance();
  try {
    mount(a); mount(b);
    await vi.waitFor(() => {
      expect(component(a, 'NotebookPanel').storageStatus).toBe('saved');
      expect(component(b, 'NotebookPanel').storageStatus).toBe('saved');
    });
    await expect(component(a, 'NotebookPanel').sendDraft(mark.id, 'What about SECRET_NAME?'))
      .rejects.toThrow('never-send');
    expect(researchAdapter).not.toHaveBeenCalled();
    const results = await Promise.allSettled([
      component(a, 'NotebookPanel').sendDraft(mark.id, 'What are hosting limits today?'),
      component(b, 'NotebookPanel').sendDraft(mark.id, 'What are hosting limits today?'),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(researchAdapter).toHaveBeenCalledOnce();
    expect(researchAdapter).toHaveBeenCalledWith('What are hosting limits today?', 'gemini-3.5-flash-lite');
    expect((await seed.snapshot()).outbox).toMatchObject([{ status: 'approved', edited: true }]);
  } finally {
    for (const cleanup of [...a.cleanups, ...b.cleanups]) cleanup();
    seed.close();
  }
}, 15000);
