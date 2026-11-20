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
const localFixture = vi.hoisted(() => ({ ready: false, run: vi.fn() }));
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
  createService: () => ({ state: { kind: localFixture.ready ? 'ready' : 'unsupported' },
    browserAvailability: localFixture.ready ? 'available' : 'unsupported',
    warmLatencyMs: null, privacyFaults: 0, preparing: false, retryRequired: false,
    subscribe: () => () => {}, runLocal: localFixture.run }),
  startReadiness: () => () => {}, useForeground: () => true }));
vi.mock('../settings/remoteSettings', async () => {
  const { builtInSettings } = await import('../settings/defaults');
  return { loadSettings: async () => builtInSettings() };
});
import App from './App';
import { DraftControls } from './DraftControls';
import { OutboxPage } from './OutboxPage';
import { IdeaPanel } from './IdeaPanel';

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
  localFixture.ready = false; localFixture.run.mockReset();
});

it('loads and removes a sample without changing profile or Never send, and persists welcome dismissal', async () => {
  vi.stubGlobal('BroadcastChannel', Channel);
  const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
  vi.stubGlobal('window', { confirm, addEventListener: add, removeEventListener: remove });
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: add, removeEventListener: remove });
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  const seed = await openLocalStore();
  await seed.clearAll({ getItem: () => null, removeItem: () => {} });
  await seed.putNeverSend(['Existing private term']);
  await seed.putProfile({ id: 'p', type: 'skill', text: 'Existing profile', topics: [], tags: [], updatedAt: 1 });
  const app = h.newInstance();
  try {
    mount(app);
    await vi.waitFor(() => expect(component(app, 'Welcome').sampleAvailable).toBe(true));
    component(app, 'Welcome').trySample();
    await vi.waitFor(async () => expect((await seed.snapshot()).paragraphs).toHaveLength(5));
    await vi.waitFor(() => expect(component(app, 'NotebookPanel').sampleActive).toBe(true));
    await vi.waitFor(() => expect(values.get('tp.welcomeSeen')).toBe('true'));
    expect((await seed.snapshot()).neverSend).toEqual(['Existing private term']);
    expect((await seed.snapshot()).profile[0].text).toBe('Existing profile');
    const editedSample = `${component(app, 'NotebookPanel').text} A small invented edit.`;
    component(app, 'NotebookPanel').save(editedSample);
    await vi.waitFor(() => expect(component(app, 'NotebookPanel').storageStatus).toBe('saved'));
    expect(component(app, 'NotebookPanel').sampleActive).toBe(true);
    component(app, 'NotebookPanel').removeSample();
    expect((await seed.snapshot()).paragraphs).toHaveLength(5);
    component(app, 'NotebookPanel').removeSample();
    await vi.waitFor(async () => expect((await seed.snapshot()).paragraphs).toHaveLength(0));
    expect((await seed.snapshot()).neverSend).toEqual(['Existing private term']);
    expect((await seed.snapshot()).profile[0].text).toBe('Existing profile');
    const reopened = h.newInstance();
    try { expect(() => component(reopened, 'Welcome')).toThrow('Missing Welcome'); }
    finally { for (const cleanup of reopened.cleanups) cleanup(); }
  } finally {
    for (const cleanup of app.cleanups) cleanup();
    seed.close();
  }
}, 15000);

it('refuses a stale sample removal after another tab replaces the notebook', async () => {
  vi.stubGlobal('BroadcastChannel', Channel);
  vi.stubGlobal('window', { confirm: () => true, addEventListener: add, removeEventListener: remove });
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: add, removeEventListener: remove });
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  const seed = await openLocalStore();
  await seed.clearAll({ getItem: () => null, removeItem: () => {} });
  const a = h.newInstance(); const b = h.newInstance();
  try {
    mount(a);
    await vi.waitFor(() => expect(component(a, 'Welcome').sampleAvailable).toBe(true));
    component(a, 'Welcome').trySample();
    await vi.waitFor(() => expect(component(a, 'NotebookPanel').sampleActive).toBe(true));
    await vi.waitFor(() => expect(values.get('tp.welcomeSeen')).toBe('true'));
    mount(b);
    await vi.waitFor(() => expect(component(b, 'NotebookPanel').sampleActive).toBe(true));
    const staleRemove = component(a, 'NotebookPanel').removeSample;
    component(b, 'NotebookPanel').save('');
    await vi.waitFor(async () => expect((await seed.snapshot()).paragraphs).toHaveLength(0));
    component(b, 'NotebookPanel').save('A completely unrelated private note written by another tab.');
    await vi.waitFor(async () => expect((await seed.snapshot()).paragraphs[0]?.text).toContain('unrelated'));
    for (const focus of listeners.get('focus') ?? []) focus();
    await vi.waitFor(() => expect(component(a, 'NotebookPanel').sampleActive).toBe(false));
    staleRemove();
    await vi.waitFor(() => expect(component(a, 'StorageNotice').notice)
      .toBe('Your notebook changed, so nothing was removed.'));
    expect((await seed.snapshot()).paragraphs[0].text).toContain('unrelated');
    expect(component(a, 'NotebookPanel').text).toContain('unrelated');
    expect(component(a, 'NotebookPanel').sampleActive).toBe(false);
  } finally { for (const instance of [a, b]) for (const cleanup of instance.cleanups) cleanup(); seed.close(); }
}, 15000);

it('uses the existing cloud opt-in when chosen from the welcome', async () => {
  vi.stubGlobal('BroadcastChannel', Channel);
  const confirm = vi.fn().mockReturnValue(true);
  vi.stubGlobal('window', { confirm, addEventListener: add, removeEventListener: remove });
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: add, removeEventListener: remove });
  vi.stubGlobal('localStorage', { getItem: () => null, removeItem: () => {}, setItem: () => {} });
  const seed = await openLocalStore();
  await seed.clearAll({ getItem: () => null, removeItem: () => {} });
  const app = h.newInstance();
  try {
    mount(app);
    await vi.waitFor(() => expect(component(app, 'Welcome').sampleAvailable).toBe(true));
    component(app, 'Welcome').chooseCloud();
    await vi.waitFor(async () => expect(await seed.cloudModeConsent()).toBe(true));
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0][0]).toContain('statements and concerns');
    expect(adapter).not.toHaveBeenCalled();
  } finally { for (const cleanup of app.cleanups) cleanup(); seed.close(); }
}, 15000);

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
    await vi.waitFor(async () => expect((await seed.snapshot()).jobs[0])
      .toMatchObject({ runMode: 'in_cloud', measuredSource: 'in_cloud' }));
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

it('shows a completed receipt on a fresh App even if the idea-phase write was missed', async () => {
  vi.stubGlobal('BroadcastChannel', Channel);
  vi.stubGlobal('window', { confirm: () => true, addEventListener: add, removeEventListener: remove });
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: add, removeEventListener: remove });
  vi.stubGlobal('localStorage', { getItem: () => null, removeItem: () => {} });
  const seed = await openLocalStore();
  await seed.clearAll({ getItem: () => null, removeItem: () => {} });
  const paragraph = 'The hosting plan supports visitors while a payment service handles purchases for people.';
  await seed.saveNotebook(paragraph, 0); await seed.enqueueSettled(4000, 'extract.v2');
  const extract = await seed.claim(4000);
  await seed.complete(extract!.job, [
    { kind: 'assumption', text: 'Hosting supports visitors', quote: 'The hosting plan supports visitors', topics: [] },
    { kind: 'decision', text: 'Payment handles purchases', quote: 'a payment service handles purchases', topics: [] },
    { kind: 'constraint', text: 'Purchases are for people', quote: 'purchases for people', topics: [] },
  ], 4000); await seed.finalizeReady();
  const idea = (await seed.startIdea(5000)).idea!;
  await seed.finishIdeaDraft((await seed.claim(5000))!.job,
    'A notebook helps builders understand the decisions behind their product plans.', []);
  const approval = await seed.approveIdea(idea.id, 'A notebook helps builders understand their product plans.');
  const receipt = await seed.reserveResearch(approval.entryId!, 20);
  await seed.finishResearch(receipt!, 'completed');
  expect((await seed.snapshot()).ideas![0].status).toBe('approved');
  const app = h.newInstance();
  try {
    mount(app);
    await vi.waitFor(() => expect(component(app, 'IdeaPanel').snapshot.researchReceipts)
      .toMatchObject([{ status: 'completed' }]));
    const panel = component(app, 'IdeaPanel');
    h.enter(h.newInstance());
    const html = renderToStaticMarkup(IdeaPanel(panel as Parameters<typeof IdeaPanel>[0]));
    expect(html).toContain('Research completed');
    expect(html).not.toContain('Approved, not sent');
    expect(html).not.toContain('Try again');
    await vi.waitFor(async () => expect((await seed.snapshot()).ideas![0].status).toBe('sent'));
    expect(researchAdapter).not.toHaveBeenCalled();
  } finally {
    for (const cleanup of app.cleanups) cleanup();
    seed.close();
  }
}, 15000);

it('approves and researches one idea from two App trees without sending the notebook', async () => {
  vi.stubGlobal('BroadcastChannel', Channel);
  vi.stubGlobal('window', { confirm: () => true, addEventListener: add, removeEventListener: remove });
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: add, removeEventListener: remove });
  vi.stubGlobal('localStorage', { getItem: () => null, removeItem: () => {} });
  const seed = await openLocalStore();
  await seed.clearAll({ getItem: () => null, removeItem: () => {} });
  const paragraph = 'The hosting plan supports visitors while a payment service handles purchases for people.';
  await seed.saveNotebook(paragraph, 0); await seed.enqueueSettled(4000, 'extract.v2');
  const extract = await seed.claim(4000);
  await seed.complete(extract!.job, [
    { kind: 'assumption', text: 'Hosting supports visitors', quote: 'The hosting plan supports visitors', topics: [] },
    { kind: 'decision', text: 'A payment service handles purchases', quote: 'a payment service handles purchases',
      topics: [] },
    { kind: 'constraint', text: 'Purchases are for people', quote: 'purchases for people', topics: [] },
  ], 4000); await seed.finalizeReady();
  const idea = (await seed.startIdea(5000)).idea!;
  const job = await seed.claim(5000);
  const description = 'A notebook helps builders understand the decisions behind their product plans.';
  await seed.finishIdeaDraft(job!.job, description, []);
  const a = h.newInstance(); const b = h.newInstance();
  try {
    mount(a); mount(b);
    await vi.waitFor(() => {
      expect(component(a, 'IdeaPanel').snapshot.ideas).toHaveLength(1);
      expect(component(b, 'IdeaPanel').snapshot.ideas).toHaveLength(1);
    });
    const results = await Promise.allSettled([component(a, 'IdeaPanel').send(idea.id, description),
      component(b, 'IdeaPanel').send(idea.id, description)]);
    expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    expect(researchAdapter).toHaveBeenCalledOnce();
    expect(researchAdapter.mock.calls[0][0]).toBe(description);
    expect((await seed.snapshot()).outbox).toMatchObject([{ kind: 'idea', question: description }]);
  } finally {
    for (const cleanup of [...a.cleanups, ...b.cleanups]) cleanup();
    seed.close();
  }
}, 15000);

it('publishes a claimed local extraction to a ready App without a focus event', async () => {
  vi.stubGlobal('BroadcastChannel', Channel);
  vi.stubGlobal('window', { confirm: () => true, addEventListener: add, removeEventListener: remove });
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: add, removeEventListener: remove });
  vi.stubGlobal('localStorage', { getItem: () => null, removeItem: () => {} });
  localFixture.ready = true;
  let release!: (value: { data: { items: never[] }; latencyMs: number; source: string; raw: string }) => void;
  localFixture.run.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const seed = await openLocalStore();
  await seed.clearAll({ getItem: () => null, removeItem: () => {} });
  const paragraph = 'This fictional paragraph contains enough words to trigger an on-device extraction in the test.';
  await seed.saveNotebook(paragraph, 0);
  const app = h.newInstance();
  try {
    mount(app);
    await vi.waitFor(() => expect(localFixture.run).toHaveBeenCalledOnce());
    await vi.waitFor(() => {
      const panel = component(app, 'NotebookPanel');
      expect(panel.snapshot.jobs.some((job: { status: string }) => job.status === 'running')).toBe(true);
      expect(panel.ready).toBe(true);
    });
    const panel = component(app, 'NotebookPanel');
    const { NotebookPanel } = await import('./NotebookPanel');
    h.enter(h.newInstance());
    const tree = NotebookPanel(panel as Parameters<typeof NotebookPanel>[0]);
    expect(JSON.stringify(tree)).toContain('Reading your paragraph on this device');
    release({ data: { items: [] }, latencyMs: 1, source: 'on_device', raw: '{}' });
  } finally { for (const cleanup of app.cleanups) cleanup(); seed.close(); }
}, 15000);

it('keeps pre-send checking and disabled Send across navigation before any request', async () => {
  vi.stubGlobal('BroadcastChannel', Channel);
  vi.stubGlobal('window', { confirm: () => true, addEventListener: add, removeEventListener: remove });
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: add, removeEventListener: remove });
  vi.stubGlobal('localStorage', { getItem: () => null, removeItem: () => {} });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = LocalStore.prototype.preSendCheck;
  const spy = vi.spyOn(LocalStore.prototype, 'preSendCheck').mockImplementation(async function (this: LocalStore, id) {
    await gate; return original.call(this, id);
  });
  const seed = await openLocalStore();
  await seed.clearAll({ getItem: () => null, removeItem: () => {} });
  const paragraph = 'The hosting service supports fifty visitors while serving a public catalogue for users.';
  await seed.saveNotebook(paragraph, 0); await seed.enqueueSettled(4000, 'extract.v2');
  const extract = await seed.claim(4000);
  await seed.complete(extract!.job, [{ kind: 'assumption', text: 'Fifty visitors',
    quote: 'The hosting service supports fifty visitors', topics: ['hosting'] }], 4000);
  await seed.finalizeReady();
  const request = await seed.requestCheck((await seed.snapshot()).items[0].id, 5000);
  const angles = await seed.claim(5000);
  await seed.completeAngles(angles!.job, (await seed.anglesInput(angles!.job))!, [], 's', 5000, 'on_device');
  const app = h.newInstance();
  try {
    mount(app);
    await vi.waitFor(() => expect(component(app, 'NotebookPanel').storageStatus).toBe('saved'));
    const pending = component(app, 'NotebookPanel').sendDraft(request.cardId, 'What are hosting limits?');
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    const entry = (await seed.snapshot()).outbox![0];
    let panel = component(app, 'NotebookPanel');
    expect(panel.checkingSend[entry.id]).toBe(true);
    expect(panel.searching[entry.id]).toBe(false);
    const { NotebookPanel } = await import('./NotebookPanel');
    h.enter(h.newInstance());
    const cardMarkup = renderToStaticMarkup(NotebookPanel(panel as Parameters<typeof NotebookPanel>[0]));
    expect(cardMarkup).toContain('Checking before sending');
    expect(cardMarkup).not.toContain('Searching the web');
    expect(cardMarkup).toMatch(/<button disabled="">Send now/);
    expect(researchAdapter).not.toHaveBeenCalled();
    clickNav(app, 'Outbox');
    const outbox = component(app, 'OutboxPage');
    expect(outbox.checkingSend[entry.id]).toBe(true);
    h.enter(h.newInstance());
    const markup = renderToStaticMarkup(OutboxPage({ ...outbox } as Parameters<typeof OutboxPage>[0]));
    expect(markup).toContain('Checking before sending');
    expect(markup).not.toContain('Searching the web');
    expect(markup).not.toContain('Research this question');
    clickNav(app, 'Notebook');
    panel = component(app, 'NotebookPanel');
    expect(panel.checkingSend[entry.id]).toBe(true);
    const card = panel.snapshot.cards.find((value: { id: string }) => value.id === request.cardId);
    h.enter(h.newInstance());
    const draft = renderToStaticMarkup(DraftControls({ card, outbox: entry, checkingSend: true,
      research: async () => {} }));
    expect(draft).toMatch(/<button disabled="">Send now/);
    release();
    await pending;
    expect(researchAdapter).toHaveBeenCalledOnce();
  } finally { release(); spy.mockRestore(); for (const cleanup of app.cleanups) cleanup(); seed.close(); }
}, 15000);

it('keeps the in-flight question status across navigation during a held dispatch', async () => {
  vi.stubGlobal('BroadcastChannel', Channel);
  vi.stubGlobal('window', { confirm: () => true, addEventListener: add, removeEventListener: remove });
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: add, removeEventListener: remove });
  vi.stubGlobal('localStorage', { getItem: () => null, removeItem: () => {} });
  let release!: (value: { source: 'in_cloud'; result: { text: string; parts: string[]; sources: never[];
    supports: never[]; suggestions: string; grounded: false } }) => void;
  researchAdapter.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const seed = await openLocalStore();
  await seed.clearAll({ getItem: () => null, removeItem: () => {} });
  const paragraph = 'The hosting service supports fifty visitors while serving a public catalogue for users.';
  await seed.saveNotebook(paragraph, 0); await seed.enqueueSettled(4000, 'extract.v2');
  const extract = await seed.claim(4000);
  await seed.complete(extract!.job, [{ kind: 'assumption', text: 'Fifty visitors',
    quote: 'The hosting service supports fifty visitors', topics: ['hosting'] }], 4000);
  await seed.finalizeReady();
  const request = await seed.requestCheck((await seed.snapshot()).items[0].id, 5000);
  const angles = await seed.claim(5000);
  await seed.completeAngles(angles!.job, (await seed.anglesInput(angles!.job))!, [], 's', 5000, 'on_device');
  const app = h.newInstance();
  try {
    mount(app);
    await vi.waitFor(() => expect(component(app, 'NotebookPanel').storageStatus).toBe('saved'));
    const pending = component(app, 'NotebookPanel').sendDraft(request.cardId, 'What are hosting limits?');
    await vi.waitFor(() => expect(researchAdapter).toHaveBeenCalledOnce());
    const entry = (await seed.snapshot()).outbox![0];
    expect(component(app, 'NotebookPanel').searching[entry.id]).toBe(true);
    clickNav(app, 'Outbox');
    expect(component(app, 'OutboxPage').searching[entry.id]).toBe(true);
    clickNav(app, 'Notebook');
    expect(component(app, 'NotebookPanel').searching[entry.id]).toBe(true);
    release({ source: 'in_cloud', result: { text: 'FAKE', parts: ['FAKE'], sources: [], supports: [],
      suggestions: '', grounded: false } });
    await pending;
    expect(component(app, 'NotebookPanel').searching[entry.id]).toBe(false);
  } finally { for (const cleanup of app.cleanups) cleanup(); seed.close(); }
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
    expect(snapshot.researchReceipts).toMatchObject([{ status: 'failed', failureCode: 'unknown' }]);
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
