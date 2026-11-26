import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LocalStore, openLocalStore, STORE_VERSION } from '../store';
import { openDB } from 'idb';
import { stubSafeSuggestionParser } from '../ai/testSuggestionParser';

const h = vi.hoisted(() => {
  type Instance = { slots: unknown[]; index: number; effects: Array<() => void>; cleanups: Array<() => void> };
  let current: Instance;
  let autoConsent = true;
  const consentMessages: string[] = [];
  return {
    consentMessages,
    setAutoConsent(value: boolean) { autoConsent = value; },
    newInstance: (): Instance => ({ slots: [], index: 0, effects: [], cleanups: [] }),
    enter(instance: Instance) { current = instance; instance.index = 0; },
    useState<T>(initial: T | (() => T)) {
      const instance = current; const i = instance.index++;
      if (!(i in instance.slots)) instance.slots[i] = typeof initial === 'function' ? (initial as () => T)() : initial;
      return [instance.slots[i], (value: T | ((old: T) => T)) => {
        instance.slots[i] = typeof value === 'function' ? (value as (old: T) => T)(instance.slots[i] as T) : value;
        const request = instance.slots[i] as { message?: string; finish?: (accepted: boolean) => void } | null;
        if (autoConsent && request && typeof request.message === 'string' && typeof request.finish === 'function') {
          consentMessages.push(request.message);
          queueMicrotask(() => request.finish?.(true));
        }
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
const localFixture = vi.hoisted(() => ({ ready: false, generating: true, run: vi.fn() }));
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
    subscribe: () => () => {}, isGeneratingFor: () => localFixture.generating, runLocal: localFixture.run }),
  startReadiness: () => () => {}, useForeground: () => true }));
vi.mock('../settings/remoteSettings', async () => {
  const { builtInSettings } = await import('../settings/defaults');
  return { loadSettings: async () => builtInSettings() };
});
import App from './App';
import { DraftControls } from './DraftControls';
import { OutboxPage } from './OutboxPage';
import { IdeaPanel } from './IdeaPanel';
import { ProfilePanel } from '../profile/ProfilePanel';
import { NotebookPanel } from './NotebookPanel';

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
function ideaWrapper(instance: Instance): ReactElement<{ hidden?: boolean; children?: ReactNode }> {
  const wrapper = nodes(render(instance)).find(value => value.type === 'div' &&
    (value.props as { children?: ReactElement }).children?.type === IdeaPanel);
  if (!wrapper) throw new Error('Missing idea wrapper');
  return wrapper as ReactElement<{ hidden?: boolean; children?: ReactNode }>;
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
  localFixture.ready = false; localFixture.generating = true; localFixture.run.mockReset();
  h.setAutoConsent(true); h.consentMessages.length = 0;
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
    expect(component(app, 'NotebookPanel').trySample).toBeUndefined();
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
    await vi.waitFor(() => expect(component(app, 'NotebookPanel').storageStatus).toBe('saved'));
    const notebook = component(app, 'NotebookPanel');
    expect(typeof notebook.trySample).toBe('function');
    notebook.trySample();
    await vi.waitFor(async () => expect((await seed.snapshot()).paragraphs).toHaveLength(5));
    await vi.waitFor(() => expect(component(app, 'NotebookPanel').sampleActive).toBe(true));
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

it('hides explicitly removed sample statements but not statements removed by ordinary edits', async () => {
  vi.stubGlobal('BroadcastChannel', Channel);
  vi.stubGlobal('window', { confirm: () => true, addEventListener: add, removeEventListener: remove });
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: add, removeEventListener: remove });
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  const seed = await openLocalStore();
  await seed.clearAll({ getItem: () => null, removeItem: () => {} });
  const app = h.newInstance();
  try {
    mount(app);
    await vi.waitFor(() => expect(component(app, 'Welcome').sampleAvailable).toBe(true));
    component(app, 'Welcome').trySample();
    await vi.waitFor(() => expect(component(app, 'NotebookPanel').sampleActive).toBe(true));
    await vi.waitFor(() => expect(component(app, 'NotebookPanel').storageStatus).toBe('saved'));
    await seed.enqueueSettled(Date.now() + 5000, 'extract.v2');
    const first = (await seed.claim(Date.now() + 5000))!;
    const quote = first.paragraph.text.split('.')[0];
    await seed.complete(first.job, [{ kind: 'assumption', text: 'FAKE sample statement', quote, topics: [] }]);
    await seed.finalizeReady();
    for (const focus of listeners.get('focus') ?? []) focus();
    await vi.waitFor(() => expect(component(app, 'NotebookPanel').snapshot.items).toHaveLength(1));
    component(app, 'NotebookPanel').removeSample();
    await vi.waitFor(async () => expect((await seed.snapshot()).paragraphs).toHaveLength(0));
    await vi.waitFor(() => expect(component(app, 'NotebookPanel').storageStatus).toBe('saved'));
    const panel = component(app, 'NotebookPanel');
    const { NotebookPanel } = await import('./NotebookPanel');
    h.enter(h.newInstance());
    expect(renderToStaticMarkup(NotebookPanel(panel as Parameters<typeof NotebookPanel>[0])))
      .not.toContain('FAKE sample statement');
    expect(values.get('tp.removedSampleIds')).toBeTruthy();
    const reopened = h.newInstance();
    try {
      mount(reopened);
      await vi.waitFor(() => expect(component(reopened, 'NotebookPanel').storageStatus).toBe('saved'));
      const reopenedPanel = component(reopened, 'NotebookPanel');
      h.enter(h.newInstance());
      expect(renderToStaticMarkup(NotebookPanel(reopenedPanel as Parameters<typeof NotebookPanel>[0])))
        .not.toContain('FAKE sample statement');
    } finally { for (const cleanup of reopened.cleanups) cleanup(); }
    const personal = 'My independent plan contains enough words to describe a personal product assumption clearly.';
    component(app, 'NotebookPanel').save(personal);
    await vi.waitFor(() => expect(component(app, 'NotebookPanel').storageStatus).toBe('saved'));
    await seed.enqueueSettled(Date.now() + 5000, 'extract.v2');
    const next = (await seed.claim(Date.now() + 5000))!;
    await seed.complete(next.job, [{ kind: 'assumption', text: 'FAKE personal statement',
      quote: 'My independent plan', topics: [] }]);
    await seed.finalizeReady();
    for (const focus of listeners.get('focus') ?? []) focus();
    await vi.waitFor(() => expect(component(app, 'NotebookPanel').snapshot.items)
      .toEqual(expect.arrayContaining([expect.objectContaining({ text: 'FAKE personal statement' })])));
    component(app, 'NotebookPanel').save('');
    await vi.waitFor(() => expect(component(app, 'NotebookPanel').storageStatus).toBe('saved'));
    const after = component(app, 'NotebookPanel');
    h.enter(h.newInstance());
    const html = renderToStaticMarkup(NotebookPanel(after as Parameters<typeof NotebookPanel>[0]));
    expect(html).toContain('FAKE personal statement');
    expect(html).toContain('no longer in your plan');
    expect(html).not.toContain('FAKE sample statement');
  } finally { for (const cleanup of app.cleanups) cleanup(); seed.close(); }
}, 15000);

it('does not resurrect old sample markers after another App deletes all local data', async () => {
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
    component(a, 'NotebookPanel').removeSample();
    await vi.waitFor(() => expect(values.get('tp.removedSampleIds')).toBeTruthy());
    for (const storage of listeners.get('storage') ?? []) storage();
    await vi.waitFor(() => expect(component(b, 'NotebookPanel').removedSampleIds).toHaveLength(5));
    const oldIds = [...component(b, 'NotebookPanel').removedSampleIds] as string[];
    clickNav(a, 'Profile');
    await component(a, 'ProfilePanel').clearAll();
    expect(values.has('tp.removedSampleIds')).toBe(false);
    expect(component(b, 'NotebookPanel').removedSampleIds).toEqual(oldIds);
    component(b, 'NotebookPanel').save('');
    await vi.waitFor(() => expect(component(b, 'NotebookPanel').storageStatus).toBe('saved'));
    component(b, 'NotebookPanel').trySample();
    await vi.waitFor(() => expect(component(b, 'NotebookPanel').sampleActive).toBe(true));
    await vi.waitFor(() => expect(component(b, 'NotebookPanel').storageStatus).toBe('saved'));
    component(b, 'NotebookPanel').removeSample();
    await vi.waitFor(() => expect(values.has('tp.removedSampleIds')).toBe(true));
    const marker = JSON.parse(values.get('tp.removedSampleIds')!) as { epoch: string; ids: string[] };
    expect(marker.ids).toHaveLength(5);
    expect(marker.ids.some(id => oldIds.includes(id))).toBe(false);
    for (const storage of listeners.get('storage') ?? []) storage();
    for (const focus of listeners.get('focus') ?? []) focus();
    await vi.waitFor(() => expect(component(b, 'NotebookPanel').removedSampleIds).toEqual(marker.ids));
  } finally { for (const instance of [a, b]) for (const cleanup of instance.cleanups) cleanup(); seed.close(); }
}, 15000);

it.each(['epoch', 'marker'] as const)(
  'evicts the deleted editor before the %s storage fault and only saves new text', async fault => {
    vi.stubGlobal('BroadcastChannel', Channel);
    vi.stubGlobal('window', { confirm: () => true, addEventListener: add, removeEventListener: remove });
    vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: add, removeEventListener: remove });
    const values = new Map<string, string>([['tp.welcomeSeen', 'true'], ['tp.removedSampleIds', '["old-id"]']]);
    let fail = false;
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (fail && fault === 'epoch' && key === 'tp.sampleRemovalEpoch') throw new Error('epoch fault');
        values.set(key, value);
      }, removeItem: (key: string) => {
        if (fail && fault === 'marker' && key === 'tp.removedSampleIds') throw new Error('marker fault');
        values.delete(key);
      } });
    const seed = await openLocalStore();
    await seed.clearAll({ getItem: () => null, removeItem: () => {} });
    const erased = 'This old notebook text must never return after the local data was erased.';
    await seed.saveNotebook(erased, 0);
    const app = h.newInstance(); const profile = h.newInstance(); const notebook = h.newInstance();
    const renderProfile = () => {
      const props = component(app, 'ProfilePanel') as Parameters<typeof ProfilePanel>[0];
      h.enter(profile); return ProfilePanel(props);
    };
    const renderNotebook = () => {
      const props = component(app, 'NotebookPanel') as Parameters<typeof NotebookPanel>[0];
      h.enter(notebook); return NotebookPanel(props);
    };
    try {
      mount(app);
      await vi.waitFor(() => expect(component(app, 'NotebookPanel').text).toBe(erased));
      clickNav(app, 'Profile'); fail = true;
      const button = nodes(renderProfile()).find(node => node.type === 'button' &&
        (node.props as { children?: string }).children === 'Delete all local data');
      expect(button).toBeDefined();
      (button!.props as { onClick(): void }).onClick();
      await vi.waitFor(() => expect(nodes(renderProfile()).some(node =>
        (node.props as { children?: ReactNode }).children === 'Could not delete all local data.')).toBe(true));
      expect((await seed.snapshot()).paragraphs).toEqual([]);
      expect(component(app, 'ProfilePanel').records).toEqual([]);
      clickNav(app, 'Notebook');
      const editor = nodes(renderNotebook()).find(node => node.type === 'textarea');
      expect(editor).toBeDefined();
      expect((editor!.props as { value: string }).value).toBe('');
      expect(component(app, 'NotebookPanel').storageStatus).toBe('error');
      const fresh = 'New text only.';
      (editor!.props as { onChange(event: { target: { value: string } }): void })
        .onChange({ target: { value: fresh } });
      await vi.waitFor(async () => expect((await seed.snapshot()).paragraphs.map(p => p.text)).toEqual([fresh]));
      expect((await seed.snapshot()).paragraphs.some(p => p.text.includes(erased))).toBe(false);
    } finally { for (const cleanup of app.cleanups) cleanup(); seed.close(); }
  }, 15000);

it.each(['epoch', 'marker', 'success'] as const)(
  'reconciles a newer cloud opt-in after a committed clear with %s cleanup', async fault => {
    vi.stubGlobal('BroadcastChannel', Channel);
    vi.stubGlobal('window', { confirm: () => true, addEventListener: add, removeEventListener: remove });
    vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: add, removeEventListener: remove });
    const values = new Map<string, string>([['tp.welcomeSeen', 'true'], ['tp.removedSampleIds', '["old-id"]']]);
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (fault === 'epoch' && key === 'tp.sampleRemovalEpoch') throw new Error('epoch fault');
        values.set(key, value);
      }, removeItem: (key: string) => {
        if (fault === 'marker' && key === 'tp.removedSampleIds') throw new Error('marker fault');
        values.delete(key);
      } });
    const seed = await openLocalStore();
    await seed.clearAll({ getItem: () => null, removeItem: () => {} });
    await seed.saveNotebook('This old notebook text must be removed before the other App chooses cloud mode.', 0);
    let release!: () => void; let committed!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const hasCommitted = new Promise<void>(resolve => { committed = resolve; });
    const original = LocalStore.prototype.clearAll;
    const spy = vi.spyOn(LocalStore.prototype, 'clearAll').mockImplementation(async function (this: LocalStore,
      storage) {
      await original.call(this, storage); committed(); await gate;
    });
    const a = h.newInstance(); const b = h.newInstance(); const profile = h.newInstance();
    const renderProfile = () => {
      const props = component(a, 'ProfilePanel') as Parameters<typeof ProfilePanel>[0];
      h.enter(profile); return ProfilePanel(props);
    };
    try {
      mount(a); mount(b);
      await vi.waitFor(() => {
        expect(component(a, 'NotebookPanel').storageStatus).toBe('saved');
        expect(component(b, 'NotebookPanel').storageStatus).toBe('saved');
      });
      clickNav(a, 'Profile');
      const button = nodes(renderProfile()).find(node => node.type === 'button' &&
        (node.props as { children?: string }).children === 'Delete all local data');
      (button!.props as { onClick(): void }).onClick();
      await hasCommitted;
      component(b, 'Notices').chooseCloud();
      await vi.waitFor(() => {
        expect(component(a, 'StatusBar').cloudMode).toBe(true);
        expect(component(b, 'StatusBar').cloudMode).toBe(true);
      });
      expect(await seed.cloudModeConsent()).toBe(true);
      release();
      await vi.waitFor(() => expect(component(a, 'StatusBar').cloudMode).toBe(true));
      if (fault !== 'success') {
        await vi.waitFor(() => expect(nodes(renderProfile()).some(node =>
          (node.props as { children?: ReactNode }).children === 'Could not delete all local data.')).toBe(true));
      }
      clickNav(a, 'Notebook');
      await vi.waitFor(() => expect(component(a, 'NotebookPanel').storageStatus)
        .toBe(fault === 'success' ? 'saved' : 'error'));
      expect(component(a, 'StatusBar').cloudMode).toBe(true);
      expect(component(a, 'NotebookPanel').text).toBe('');
      expect((await seed.snapshot()).paragraphs).toEqual([]);
      expect(adapter).not.toHaveBeenCalled();
      expect((await seed.snapshot()).cloudProcessingSends).toEqual([]);
    } finally {
      release(); spy.mockRestore(); for (const cleanup of [...a.cleanups, ...b.cleanups]) cleanup(); seed.close();
    }
  }, 15000);

it('keeps session-only sample suppression when writing its marker fails', async () => {
  vi.stubGlobal('BroadcastChannel', Channel);
  vi.stubGlobal('window', { confirm: () => true, addEventListener: add, removeEventListener: remove });
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: add, removeEventListener: remove });
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (key === 'tp.removedSampleIds') throw new Error('Storage full');
      values.set(key, value);
    }, removeItem: (key: string) => values.delete(key) });
  const seed = await openLocalStore();
  await seed.clearAll({ getItem: () => null, removeItem: () => {} });
  const app = h.newInstance();
  try {
    mount(app);
    await vi.waitFor(() => expect(component(app, 'Welcome').sampleAvailable).toBe(true));
    component(app, 'Welcome').trySample();
    await vi.waitFor(() => expect(component(app, 'NotebookPanel').sampleActive).toBe(true));
    await vi.waitFor(() => expect(component(app, 'NotebookPanel').storageStatus).toBe('saved'));
    component(app, 'NotebookPanel').removeSample();
    await vi.waitFor(() => expect(component(app, 'NotebookPanel').removedSampleIds).toHaveLength(5));
    expect(values.has('tp.removedSampleIds')).toBe(false);
    for (const focus of listeners.get('focus') ?? []) focus();
    await vi.waitFor(() => expect(component(app, 'NotebookPanel').removedSampleIds).toHaveLength(5));
    clickNav(app, 'Profile'); await component(app, 'ProfilePanel').clearAll();
    clickNav(app, 'Notebook');
    await vi.waitFor(() => expect(component(app, 'NotebookPanel').removedSampleIds).toEqual([]));
  } finally { for (const cleanup of app.cleanups) cleanup(); seed.close(); }
}, 15000);

it('does not write a marker after Delete all overtakes a committed sample removal', async () => {
  vi.stubGlobal('BroadcastChannel', Channel);
  vi.stubGlobal('window', { confirm: () => true, addEventListener: add, removeEventListener: remove });
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: add, removeEventListener: remove });
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  const seed = await openLocalStore();
  await seed.clearAll({ getItem: () => null, removeItem: () => {} });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = LocalStore.prototype.saveNotebook;
  const spy = vi.spyOn(LocalStore.prototype, 'saveNotebook').mockImplementation(async function (this: LocalStore,
    text, now, expected) {
    const result = await original.call(this, text, now, expected);
    if (!text && expected) await gate;
    return result;
  });
  const app = h.newInstance();
  try {
    mount(app);
    await vi.waitFor(() => expect(component(app, 'Welcome').sampleAvailable).toBe(true));
    component(app, 'Welcome').trySample();
    await vi.waitFor(() => expect(component(app, 'NotebookPanel').sampleActive).toBe(true));
    await vi.waitFor(() => expect(component(app, 'NotebookPanel').storageStatus).toBe('saved'));
    component(app, 'NotebookPanel').removeSample();
    await vi.waitFor(async () => expect((await seed.snapshot()).paragraphs).toHaveLength(0));
    clickNav(app, 'Profile');
    await component(app, 'ProfilePanel').clearAll();
    release();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(values.has('tp.removedSampleIds')).toBe(false);
    expect((await seed.snapshot()).paragraphs).toEqual([]);
  } finally { release(); spy.mockRestore(); for (const cleanup of app.cleanups) cleanup(); seed.close(); }
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

it.each(['fresh', 'stale', 'grounded'] as const)(
  'hides the %s stored idea while the notebook is empty and restores it without deleting history', async variant => {
    vi.stubGlobal('BroadcastChannel', Channel);
    vi.stubGlobal('window', { confirm: () => true, addEventListener: add, removeEventListener: remove });
    vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: add, removeEventListener: remove });
    vi.stubGlobal('localStorage', { getItem: () => null, removeItem: () => {}, setItem: () => {} });
    if (variant === 'grounded') {
      stubSafeSuggestionParser();
      researchAdapter.mockResolvedValueOnce({ source: 'in_cloud', result: { text: 'FAKE_GROUNDED_RESULT',
        parts: ['FAKE_GROUNDED_RESULT'], sources: [], supports: [],
        suggestions: '<a href="https://google.com/search?q=test">Search</a>', grounded: true } });
    }
    const seed = await openLocalStore();
    await seed.clearAll({ getItem: () => null, removeItem: () => {} });
    const paragraph = 'The hosting plan supports visitors while a payment service handles purchases for people.';
    await seed.saveNotebook(paragraph, 0); await seed.enqueueSettled(4000, 'extract.v2');
    const extract = await seed.claim(4000);
    await seed.complete(extract!.job, [
      { kind: 'assumption', text: 'Hosting supports visitors',
        quote: 'The hosting plan supports visitors', topics: [] },
      { kind: 'decision', text: 'Payment handles purchases', quote: 'a payment service handles purchases', topics: [] },
      { kind: 'constraint', text: 'Purchases are for people', quote: 'purchases for people', topics: [] },
    ], 4000); await seed.finalizeReady();
    const idea = (await seed.startIdea(5000)).idea!;
    const description = 'A notebook helps builders understand the decisions behind their product plans.';
    await seed.finishIdeaDraft((await seed.claim(5000))!.job, description, []);
    await seed.approveIdea(idea.id, description); await seed.setCloudConsent(true);
    if (variant === 'stale') await seed.saveNotebook(`${paragraph} A change.`, 6000);
    const app = h.newInstance();
    try {
      mount(app);
      await vi.waitFor(() => expect(component(app, 'NotebookPanel').storageStatus).toBe('saved'));
      if (variant === 'grounded') await component(app, 'IdeaPanel').retry(idea.id);
      const before = await seed.snapshot();
      const initialPanel = component(app, 'IdeaPanel');
      const previousView = initialPanel.view;
      if (variant === 'grounded') expect(previousView.result.text).toBe('FAKE_GROUNDED_RESULT');
      h.enter(h.newInstance());
      const initialHtml = renderToStaticMarkup(IdeaPanel(initialPanel as Parameters<typeof IdeaPanel>[0]));
      if (variant === 'stale') expect(initialHtml).toContain('Your plan changed since this was checked.');
      else expect(initialHtml).not.toContain('Your plan changed since this was checked.');
      component(app, 'NotebookPanel').save('');
      await vi.waitFor(() => expect(component(app, 'NotebookPanel').storageStatus).toBe('saved'));
      await vi.waitFor(() => expect(ideaWrapper(app).props.hidden).toBe(true));
      const empty = await seed.snapshot();
      expect(empty.ideas).toEqual(before.ideas);
      expect(empty.outbox).toEqual(before.outbox);
      expect(empty.researchReceipts).toEqual(before.researchReceipts);
      component(app, 'NotebookPanel').save(paragraph);
      await vi.waitFor(() => expect(component(app, 'NotebookPanel').storageStatus).toBe('saved'));
      await vi.waitFor(() => expect(component(app, 'IdeaPanel').idea.id).toBe(idea.id));
      expect(ideaWrapper(app).props.hidden).toBe(false);
      const restored = component(app, 'IdeaPanel');
      if (variant === 'grounded') expect(restored.view).toEqual(previousView);
      h.enter(h.newInstance());
      const html = renderToStaticMarkup(IdeaPanel(restored as Parameters<typeof IdeaPanel>[0]));
      expect(html).toContain('Your plan changed since this was checked.');
    } finally { for (const cleanup of app.cleanups) cleanup(); seed.close(); }
  }, 15000);

it('preserves the edited idea draft when a blank save fails and the same plan returns', async () => {
  vi.stubGlobal('BroadcastChannel', Channel);
  vi.stubGlobal('window', { confirm: () => true, addEventListener: add, removeEventListener: remove });
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: add, removeEventListener: remove });
  vi.stubGlobal('localStorage', { getItem: () => null, removeItem: () => {}, setItem: () => {} });
  const seed = await openLocalStore();
  await seed.clearAll({ getItem: () => null, removeItem: () => {} });
  const first = 'Restaurants lose money when guests do not show.';
  const second = 'The booking page accepts deposits and sends a reminder to each guest before their reservation.';
  const plan = `${first}\n\n${second}`;
  await seed.saveNotebook(plan, 0); await seed.enqueueSettled(4000, 'extract.v2');
  const extraction = (await seed.claim(4000))!.job;
  await seed.complete(extraction, [
    { kind: 'assumption', text: 'Guests may not attend', quote: 'each guest', topics: [] },
    { kind: 'decision', text: 'Send a reminder', quote: 'sends a reminder', topics: [] },
    { kind: 'constraint', text: 'Accept deposits', quote: 'accepts deposits', topics: [] },
  ], 4000); await seed.finalizeReady();
  const idea = (await seed.startIdea(5000)).idea!;
  const draft = 'A booking page helps restaurants reduce missed reservations by collecting deposits.';
  await seed.finishIdeaDraft((await seed.claim(5000))!.job, draft, [], 5000);
  const before = await seed.snapshot();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = LocalStore.prototype.saveNotebook;
  const spy = vi.spyOn(LocalStore.prototype, 'saveNotebook').mockImplementation(async function (this: LocalStore,
    text, now, expected) {
    if (!text) { await gate; throw new Error('forced blank save failure'); }
    return original.call(this, text, now, expected);
  });
  const app = h.newInstance(); const child = h.newInstance();
  const renderIdea = () => {
    const props = component(app, 'IdeaPanel');
    h.enter(child);
    const tree = IdeaPanel(props as Parameters<typeof IdeaPanel>[0]);
    for (const effect of child.effects.splice(0)) effect();
    return tree;
  };
  try {
    mount(app);
    await vi.waitFor(() => expect(component(app, 'NotebookPanel').storageStatus).toBe('saved'));
    renderIdea();
    const textarea = nodes(renderIdea()).find(node => node.type === 'textarea')!;
    (textarea.props as { onChange(event: unknown): void }).onChange({
      target: { value: 'My corrected public wording' } });
    expect((nodes(renderIdea()).find(node => node.type === 'textarea')!.props as { value: string }).value)
      .toBe('My corrected public wording');
    component(app, 'NotebookPanel').save('');
    expect(component(app, 'CheckShortlist').showMarks).toBe(true);
    expect(component(app, 'CheckShortlist').saving).toBe(true);
    const requestCheck = vi.spyOn(LocalStore.prototype, 'requestCheck');
    try {
      await expect(component(app, 'NotebookPanel').checkThis('not-a-real-item'))
        .rejects.toThrow('Checking your latest change');
      await expect(component(app, 'NotebookPanel').sendDraft('not-a-real-card', 'A fake question?'))
        .rejects.toThrow('Checking your latest change');
      expect(requestCheck).not.toHaveBeenCalled();
    } finally { requestCheck.mockRestore(); }
    expect(ideaWrapper(app).props.hidden).toBe(true);
    const hiddenWrapper = ideaWrapper(app);
    h.enter(child);
    expect(renderToStaticMarkup(hiddenWrapper)).toMatch(/^<div hidden="">/);
    release();
    await vi.waitFor(() => expect(component(app, 'NotebookPanel').storageStatus).toBe('error'));
    expect(component(app, 'CheckShortlist').showMarks).toBe(false);
    expect(ideaWrapper(app).props.hidden).toBe(true);
    component(app, 'NotebookPanel').save(plan);
    await vi.waitFor(() => expect(component(app, 'NotebookPanel').storageStatus).toBe('saved'));
    expect(ideaWrapper(app).props.hidden).toBe(false);
    expect(component(app, 'CheckShortlist').showMarks).toBe(true);
    expect((nodes(renderIdea()).find(node => node.type === 'textarea')!.props as { value: string }).value)
      .toBe('My corrected public wording');
    const after = await seed.snapshot();
    expect(after.paragraphs).toEqual(before.paragraphs);
    expect(after.lineages).toEqual(before.lineages);
    expect(after.ideas).toEqual(before.ideas);
    expect(after.outbox).toEqual(before.outbox);
    expect(after.researchReceipts).toEqual(before.researchReceipts);
    expect(researchAdapter).not.toHaveBeenCalled();
  } finally {
    release(); spy.mockRestore();
    for (const cleanup of app.cleanups) cleanup();
    seed.close();
  }
}, 15000);

it('shows same-tab finishing status while the completed model result is being saved', async () => {
  vi.stubGlobal('BroadcastChannel', Channel);
  vi.stubGlobal('window', { confirm: () => true, addEventListener: add, removeEventListener: remove });
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: add, removeEventListener: remove });
  vi.stubGlobal('localStorage', { getItem: () => 'true', removeItem: () => {}, setItem: () => {} });
  const seed = await openLocalStore();
  await seed.clearAll({ getItem: () => null, removeItem: () => {} });
  const plan = 'A fictional startup plan contains enough words for local model extraction and review.';
  await seed.saveNotebook(plan, 0);
  localFixture.ready = true;
  localFixture.run.mockImplementation(async () => {
    localFixture.generating = false;
    return { data: { items: [] }, source: 'on_device', latencyMs: 1, raw: '' };
  });
  let release!: () => void; let held = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = LocalStore.prototype.complete;
  const spy = vi.spyOn(LocalStore.prototype, 'complete').mockImplementation(async function (this: LocalStore,
    job, items, now, source) {
    held = true; await gate; return original.call(this, job, items, now, source);
  });
  const app = h.newInstance(); const notebook = h.newInstance();
  try {
    mount(app);
    await vi.waitFor(() => expect(held).toBe(true));
    await vi.waitFor(() => expect(component(app, 'NotebookPanel').snapshot.jobs
      .some((job: { status: string }) => job.status === 'running')).toBe(true));
    const props = component(app, 'NotebookPanel') as Parameters<typeof NotebookPanel>[0];
    expect(props.ownedClaim?.status).toBe('running');
    expect(props.activeClaim).toBeUndefined();
    h.enter(notebook);
    const html = renderToStaticMarkup(NotebookPanel(props));
    expect(html).toContain('Finishing work in this tab');
    expect(html).not.toContain('interrupted or may be running in another tab');
    expect(html).not.toContain('Reading your paragraph on this device');
  } finally { release(); spy.mockRestore(); for (const cleanup of app.cleanups) cleanup(); seed.close(); }
}, 15000);

it('recovers a startup resume quota after the next successful notebook save', async () => {
  vi.stubGlobal('BroadcastChannel', Channel);
  vi.stubGlobal('window', { confirm: () => true, addEventListener: add, removeEventListener: remove });
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: add, removeEventListener: remove });
  vi.stubGlobal('localStorage', { getItem: () => 'true', removeItem: () => {}, setItem: () => {} });
  const seed = await openLocalStore();
  await seed.clearAll({ getItem: () => null, removeItem: () => {} });
  const plan = 'A fictional startup plan contains enough words for local model extraction and review.';
  await seed.saveNotebook(plan, 0); await seed.enqueueSettled(4000, 'extract.v2');
  expect((await seed.claim(4000))?.job.status).toBe('running');
  localFixture.ready = true;
  localFixture.run.mockResolvedValue({ data: { items: [] }, source: 'on_device', latencyMs: 1, raw: '' });
  const original = IDBObjectStore.prototype.put;
  let inject = true;
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
    if (inject && this.name === 'jobs' && (value as { status?: string }).status === 'pending') {
      inject = false; throw new DOMException('fixture', 'QuotaExceededError');
    }
    return original.call(this, value, key);
  });
  const app = h.newInstance();
  try {
    mount(app);
    await vi.waitFor(() => expect(component(app, 'StorageNotice').notice).toBe('Browser storage is full.'));
    expect(component(app, 'NotebookPanel').storageStatus).toBe('saved');
    expect(component(app, 'NotebookPanel').storagePaused).toBe(true);
    expect(localFixture.run).not.toHaveBeenCalled();
    component(app, 'NotebookPanel').save(plan);
    await vi.waitFor(() => expect(component(app, 'StorageNotice').notice).toBe(''));
    await vi.waitFor(() => expect(localFixture.run).toHaveBeenCalled(), { timeout: 8000 });
    await vi.waitFor(async () => expect((await seed.snapshot()).jobs[0].status).toBe('done'));
  } finally { spy.mockRestore(); for (const cleanup of app.cleanups) cleanup(); seed.close(); }
}, 15000);

it('keeps a saved editor and pauses automatic work after an items-store quota error', async () => {
  vi.stubGlobal('BroadcastChannel', Channel);
  vi.stubGlobal('window', { confirm: () => true, addEventListener: add, removeEventListener: remove });
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: add, removeEventListener: remove });
  vi.stubGlobal('localStorage', { getItem: () => 'true', removeItem: () => {}, setItem: () => {} });
  const seed = await openLocalStore();
  await seed.clearAll({ getItem: () => null, removeItem: () => {} });
  const plan = 'A fictional project tracks the local ledger with enough words to run model extraction.\n\n' +
    'A second fictional paragraph holds another plan with enough words for the local model.';
  await seed.saveNotebook(plan, 0);
  localFixture.ready = true;
  localFixture.run.mockResolvedValue({ data: { items: [{ kind: 'assumption', text: 'Ledger',
    quote: 'fictional project tracks', topics: [] }] }, source: 'on_device', latencyMs: 1, raw: '' });
  const original = IDBObjectStore.prototype.put;
  let inject = true;
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
    if (inject && this.name === 'items') { inject = false; throw new DOMException('fixture', 'QuotaExceededError'); }
    return original.call(this, value, key);
  });
  const app = h.newInstance();
  try {
    mount(app);
    await vi.waitFor(() => expect(component(app, 'StorageNotice').notice).toBe('Browser storage is full.'));
    expect(component(app, 'NotebookPanel').storageStatus).toBe('saved');
    expect(component(app, 'NotebookPanel').storagePaused).toBe(true);
    expect(component(app, 'NotebookPanel').text).toBe(plan);
    const calls = localFixture.run.mock.calls.length;
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(localFixture.run).toHaveBeenCalledTimes(calls);
    component(app, 'NotebookPanel').save(plan);
    await vi.waitFor(() => expect(component(app, 'StorageNotice').notice).toBe(''));
    await vi.waitFor(() => expect(component(app, 'NotebookPanel').storagePaused).toBe(false));
  } finally { spy.mockRestore(); for (const cleanup of app.cleanups) cleanup(); seed.close(); }
}, 15000);

it('pauses automatic cloud work after reservation-store quota without dispatch', async () => {
  vi.stubGlobal('BroadcastChannel', Channel);
  vi.stubGlobal('window', { confirm: () => true, addEventListener: add, removeEventListener: remove });
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: add, removeEventListener: remove });
  vi.stubGlobal('localStorage', { getItem: () => 'true', removeItem: () => {}, setItem: () => {} });
  const seed = await openLocalStore();
  await seed.clearAll({ getItem: () => null, removeItem: () => {} });
  const plan = 'A fictional project tracks the local ledger with enough words to run model extraction.';
  await seed.saveNotebook(plan, 0);
  const original = IDBObjectStore.prototype.add;
  let inject = true;
  const spy = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, value, key) {
    if (inject && this.name === 'cloudProcessing') {
      inject = false; throw new DOMException('fixture', 'QuotaExceededError');
    }
    return original.call(this, value, key);
  });
  const app = h.newInstance();
  try {
    mount(app);
    await vi.waitFor(() => expect(component(app, 'NotebookPanel').storageStatus).toBe('saved'));
    component(app, 'Notices').chooseCloud();
    await vi.waitFor(() => expect(component(app, 'StorageNotice').notice).toBe('Browser storage is full.'),
      { timeout: 8000 });
    expect(component(app, 'NotebookPanel').storageStatus).toBe('saved');
    expect(component(app, 'NotebookPanel').storagePaused).toBe(true);
    expect(adapter).not.toHaveBeenCalled();
    expect((await seed.snapshot()).cloudProcessingSends).toEqual([]);
  } finally { spy.mockRestore(); for (const cleanup of app.cleanups) cleanup(); seed.close(); }
}, 15000);

it('reports browser storage quota on save and clears it after a successful retry', async () => {
  vi.stubGlobal('BroadcastChannel', Channel);
  vi.stubGlobal('window', { confirm: () => true, addEventListener: add, removeEventListener: remove });
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: add, removeEventListener: remove });
  vi.stubGlobal('localStorage', { getItem: () => null, removeItem: () => {}, setItem: () => {} });
  const seed = await openLocalStore();
  await seed.clearAll({ getItem: () => null, removeItem: () => {} });
  const original = LocalStore.prototype.saveNotebook;
  let fail = true;
  const spy = vi.spyOn(LocalStore.prototype, 'saveNotebook').mockImplementation(async function (this: LocalStore,
    text, now, expected) {
    if (fail) { fail = false; throw Object.assign(new Error('fixture'), { name: 'QuotaExceededError' }); }
    return original.call(this, text, now, expected);
  });
  const app = h.newInstance();
  try {
    mount(app);
    await vi.waitFor(() => expect(component(app, 'NotebookPanel').storageStatus).toBe('saved'));
    component(app, 'NotebookPanel').save('A new local plan.');
    await vi.waitFor(() => expect(component(app, 'StorageNotice').notice).toBe('Browser storage is full.'));
    expect(component(app, 'NotebookPanel').storageStatus).toBe('error');
    component(app, 'NotebookPanel').save('A new local plan.');
    await vi.waitFor(() => expect(component(app, 'NotebookPanel').storageStatus).toBe('saved'));
    expect(component(app, 'StorageNotice').notice).toBe('');
  } finally { spy.mockRestore(); for (const cleanup of app.cleanups) cleanup(); seed.close(); }
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
    expect(confirm).not.toHaveBeenCalled();
    expect(h.consentMessages).toHaveLength(1);
    expect(h.consentMessages[0]).toContain('statements and concerns');
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
    await vi.waitFor(() => expect(adapter).toHaveBeenCalled(), { timeout: 5000 });
    await vi.waitFor(async () => expect((await seed.snapshot()).jobs[0])
      .toMatchObject({ runMode: 'in_cloud', measuredSource: 'in_cloud' }), { timeout: 8000 });
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

it('shows a completed ungrounded receipt when the secondary idea-phase write fails', async () => {
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
  const description = 'A notebook helps builders understand the decisions behind their product plans.';
  await seed.finishIdeaDraft((await seed.claim(5000))!.job, description, []);
  const phase = vi.spyOn(LocalStore.prototype, 'finishIdeaResearch').mockRejectedValue(new Error('forced'));
  const app = h.newInstance();
  try {
    mount(app);
    await vi.waitFor(() => expect(component(app, 'IdeaPanel').snapshot.ideas).toHaveLength(1));
    await component(app, 'IdeaPanel').send(idea.id, description);
    const panel = component(app, 'IdeaPanel');
    expect(panel.snapshot.researchReceipts).toMatchObject([{ status: 'completed', failureCode: 'ungrounded' }]);
    h.enter(h.newInstance());
    const html = renderToStaticMarkup(IdeaPanel(panel as Parameters<typeof IdeaPanel>[0]));
    expect(html).toContain('No web sources were attached');
    expect(html).not.toContain('awaiting completion');
    expect(html).not.toContain('Try again');
    expect(component(app, 'StorageNotice').notice).toContain('local status could not be updated');
    expect(researchAdapter).toHaveBeenCalledOnce();
  } finally { phase.mockRestore(); for (const cleanup of app.cleanups) cleanup(); seed.close(); }
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
  const spy = vi.spyOn(LocalStore.prototype, 'preSendCheck').mockImplementation(async function (this: LocalStore,
    id, grantText) {
    await gate; return original.call(this, id, grantText);
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

it.each(['cancel', 'escape', 'send', 'stored'] as const)(
  'handles question consent via %s without duplicate send', async action => {
  h.setAutoConsent(false);
  vi.stubGlobal('BroadcastChannel', Channel);
  vi.stubGlobal('window', { confirm: () => true, addEventListener: add, removeEventListener: remove });
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: add, removeEventListener: remove });
  vi.stubGlobal('localStorage', { getItem: () => null, removeItem: () => {} });
  const seed = await openLocalStore();
  await seed.clearAll({ getItem: () => null, removeItem: () => {} });
  const paragraph = 'The hosting service supports fifty visitors while serving a public catalogue for users.';
  await seed.saveNotebook(paragraph, 0); await seed.enqueueSettled(4000, 'extract.v2');
  const extract = await seed.claim(4000);
  await seed.complete(extract!.job, [{ kind: 'assumption', text: 'Fifty visitors',
    quote: 'The hosting service supports fifty visitors', topics: [] }], 4000);
  await seed.finalizeReady();
  const check = await seed.requestCheck((await seed.snapshot()).items[0].id, 5000);
  const angles = await seed.claim(5000);
  await seed.completeAngles(angles!.job, (await seed.anglesInput(angles!.job))!, [], 's', 5000, 'on_device');
  if (action === 'stored') await seed.setCloudConsent(true);
  const app = h.newInstance();
  try {
    mount(app);
    await vi.waitFor(() => expect(component(app, 'NotebookPanel').storageStatus).toBe('saved'));
    const promise = component(app, 'NotebookPanel').sendDraft(check.cardId, 'What are hosting limits?');
    const outcome = promise.then(() => 'sent', (error: Error) => error.message);
    if (action === 'stored') {
      expect(await outcome).toBe('sent');
      expect(researchAdapter).toHaveBeenCalledOnce();
      expect(() => component(app, 'ConsentDialog')).toThrow('Missing ConsentDialog');
      return;
    }
    await vi.waitFor(() => expect(component(app, 'ConsentDialog').request.message)
      .toContain('What are hosting limits?'));
    const request = component(app, 'ConsentDialog').request;
    expect(researchAdapter).not.toHaveBeenCalled();
    const { ConsentDialog } = await import('./ConsentDialog');
    h.enter(h.newInstance());
    const dialog = ConsentDialog({ request });
    if (action === 'escape') {
      const preventDefault = vi.fn();
      (dialog.props as any).onCancel({ preventDefault });
      expect(preventDefault).toHaveBeenCalledOnce();
    } else {
      const button = nodes(dialog).find(node => node.type === 'button' &&
        (node.props as any).children === (action === 'send' ? 'Send' : 'Cancel'))!;
      (button.props as any).onClick();
      if (action === 'send') (button.props as any).onClick();
    }
    if (action === 'send') {
      expect(await outcome).toBe('sent');
      expect(researchAdapter).toHaveBeenCalledOnce();
      expect(researchAdapter.mock.calls[0][0]).toBe('What are hosting limits?');
      expect(await seed.cloudConsent()).toBe(true);
    } else {
      expect(await outcome).toContain('Research consent was not granted');
      expect(researchAdapter).not.toHaveBeenCalled();
      expect(await seed.cloudConsent()).toBe(false);
    }
  } finally { for (const cleanup of app.cleanups) cleanup(); seed.close(); }
}, 15000);

it.each(['cancel', 'escape', 'send'] as const)('handles description consent via %s', async action => {
  h.setAutoConsent(false);
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
  const description = 'A notebook helps builders understand the decisions behind their product plans.';
  await seed.finishIdeaDraft((await seed.claim(5000))!.job, description, []);
  const app = h.newInstance();
  try {
    mount(app);
    await vi.waitFor(() => expect(component(app, 'IdeaPanel').snapshot.ideas).toHaveLength(1));
    const promise = component(app, 'IdeaPanel').send(idea.id, description);
    const outcome = promise.then(() => 'sent', (error: Error) => error.message);
    await vi.waitFor(() => expect(component(app, 'ConsentDialog').request.message).toContain(description));
    const request = component(app, 'ConsentDialog').request;
    const { ConsentDialog } = await import('./ConsentDialog');
    h.enter(h.newInstance());
    const dialog = ConsentDialog({ request });
    if (action === 'escape') (dialog.props as any).onCancel({ preventDefault() {} });
    else {
      const button = nodes(dialog).find(node => node.type === 'button' &&
        (node.props as any).children === (action === 'send' ? 'Send' : 'Cancel'))!;
      (button.props as any).onClick();
      if (action === 'send') (button.props as any).onClick();
    }
    if (action === 'send') {
      expect(await outcome).toBe('sent');
      expect(researchAdapter).toHaveBeenCalledOnce();
      expect(researchAdapter.mock.calls[0][0]).toBe(description);
      expect(await seed.cloudConsent()).toBe(true);
    } else {
      expect(await outcome).toContain('Research consent was not granted');
      expect(researchAdapter).not.toHaveBeenCalled();
      expect(await seed.cloudConsent()).toBe(false);
    }
  } finally { for (const cleanup of app.cleanups) cleanup(); seed.close(); }
}, 15000);

it.each(['cancel', 'escape', 'send'] as const)('handles cloud mode consent via %s', async action => {
  h.setAutoConsent(false);
  vi.stubGlobal('BroadcastChannel', Channel);
  vi.stubGlobal('window', { confirm: () => true, addEventListener: add, removeEventListener: remove });
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: add, removeEventListener: remove });
  vi.stubGlobal('localStorage', { getItem: () => null, removeItem: () => {} });
  const seed = await openLocalStore();
  await seed.clearAll({ getItem: () => null, removeItem: () => {} });
  const app = h.newInstance();
  try {
    mount(app);
    await vi.waitFor(() => expect(component(app, 'NotebookPanel').storageStatus).toBe('saved'));
    component(app, 'Notices').chooseCloud();
    component(app, 'Notices').chooseCloud();
    const request = component(app, 'ConsentDialog').request;
    expect(request.message).toContain('statements and concerns');
    expect(request.cloudMode).toBe(true);
    const { ConsentDialog } = await import('./ConsentDialog');
    h.enter(h.newInstance());
    const dialog = ConsentDialog({ request });
    if (action === 'escape') (dialog.props as any).onCancel({ preventDefault() {} });
    else {
      const button = nodes(dialog).find(node => node.type === 'button' &&
        (node.props as any).children === (action === 'send' ? 'OK' : 'Cancel'))!;
      (button.props as any).onClick();
      (button.props as any).onClick();
    }
    if (action === 'send') await vi.waitFor(async () => expect(await seed.cloudModeConsent()).toBe(true));
    else { await new Promise(resolve => setTimeout(resolve, 10)); expect(await seed.cloudModeConsent()).toBe(false); }
  } finally { for (const cleanup of app.cleanups) cleanup(); seed.close(); }
}, 15000);

it.each(['clear', 'never-send', 'clear-before-send', 'never-send-before-send'] as const)(
  'cancels an invalidated question dialog after peer %s', async change => {
  h.setAutoConsent(false);
  vi.stubGlobal('BroadcastChannel', Channel);
  vi.stubGlobal('window', { confirm: () => true, addEventListener: add, removeEventListener: remove });
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: add, removeEventListener: remove });
  vi.stubGlobal('localStorage', { getItem: () => null, removeItem: () => {} });
  const seed = await openLocalStore();
  await seed.clearAll({ getItem: () => null, removeItem: () => {} });
  const paragraph = 'The hosting service supports fifty visitors while serving a public catalogue for users.';
  await seed.saveNotebook(paragraph, 0); await seed.enqueueSettled(4000, 'extract.v2');
  const extract = await seed.claim(4000);
  await seed.complete(extract!.job, [{ kind: 'assumption', text: 'Fifty visitors',
    quote: 'The hosting service supports fifty visitors', topics: [] }], 4000);
  await seed.finalizeReady();
  const check = await seed.requestCheck((await seed.snapshot()).items[0].id, 5000);
  const angles = await seed.claim(5000);
  await seed.completeAngles(angles!.job, (await seed.anglesInput(angles!.job))!, [], 's', 5000, 'on_device');
  const app = h.newInstance();
  try {
    mount(app);
    await vi.waitFor(() => expect(component(app, 'NotebookPanel').storageStatus).toBe('saved'));
    const outcome = component(app, 'NotebookPanel').sendDraft(check.cardId, 'What are hosting limits?')
      .then(() => 'sent', (error: Error) => error.message);
    await vi.waitFor(() => expect(component(app, 'ConsentDialog').request.message).toContain('hosting'));
    const obsolete = component(app, 'ConsentDialog').request;
    if (change.startsWith('clear')) await seed.clearAll({ getItem: () => null, removeItem: () => {} });
    else await seed.putNeverSend(['hosting']);
    if (!change.endsWith('before-send')) {
      for (const focus of listeners.get('focus') ?? []) focus();
      await vi.waitFor(() => expect(() => component(app, 'ConsentDialog')).toThrow('Missing ConsentDialog'));
    }
    obsolete.finish(true);
    expect(await outcome).toContain(change.endsWith('before-send') ? 'privacy settings changed' :
      'Research consent was not granted');
    expect(await seed.cloudConsent()).toBe(false);
    expect(researchAdapter).not.toHaveBeenCalled();
  } finally { for (const cleanup of app.cleanups) cleanup(); seed.close(); }
}, 15000);

it.each(['clear', 'never-send', 'clear-before-send', 'never-send-before-send'] as const)(
  'cancels an invalidated description dialog after peer %s', async change => {
  h.setAutoConsent(false);
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
  const description = 'A notebook helps builders understand the decisions behind their product plans.';
  await seed.finishIdeaDraft((await seed.claim(5000))!.job, description, []);
  const app = h.newInstance();
  try {
    mount(app);
    await vi.waitFor(() => expect(component(app, 'IdeaPanel').snapshot.ideas).toHaveLength(1));
    const outcome = component(app, 'IdeaPanel').send(idea.id, description)
      .then(() => 'sent', (error: Error) => error.message);
    await vi.waitFor(() => expect(component(app, 'ConsentDialog').request.message).toContain(description));
    const obsolete = component(app, 'ConsentDialog').request;
    if (change.startsWith('clear')) await seed.clearAll({ getItem: () => null, removeItem: () => {} });
    else await seed.putNeverSend(['notebook']);
    if (!change.endsWith('before-send')) {
      for (const focus of listeners.get('focus') ?? []) focus();
      await vi.waitFor(() => expect(() => component(app, 'ConsentDialog')).toThrow('Missing ConsentDialog'));
    }
    obsolete.finish(true);
    expect(await outcome).toContain(change.endsWith('before-send') ? 'privacy settings changed' :
      'Research consent was not granted');
    expect(await seed.cloudConsent()).toBe(false);
    expect(researchAdapter).not.toHaveBeenCalled();
  } finally { for (const cleanup of app.cleanups) cleanup(); seed.close(); }
}, 15000);
