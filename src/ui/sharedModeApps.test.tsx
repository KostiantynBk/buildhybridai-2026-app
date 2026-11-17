import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { openLocalStore, STORE_VERSION } from '../store';
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
afterEach(() => { vi.unstubAllGlobals(); listeners.clear(); Channel.channels.clear(); adapter.mockClear(); });

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
