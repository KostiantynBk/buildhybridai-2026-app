import 'fake-indexeddb/auto';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { openLocalStore } from '../store';

const h = vi.hoisted(() => {
  let slots: unknown[] = []; let index = 0; let effects: Array<() => void> = [];
  return {
    reset() { slots = []; index = 0; effects = []; },
    begin() { index = 0; },
    flush() { for (const effect of effects.splice(0)) effect(); },
    useState<T>(initial: T | (() => T)) {
      const i = index++;
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? (initial as () => T)() : initial;
      return [slots[i], (value: T | ((old: T) => T)) => {
        slots[i] = typeof value === 'function' ? (value as (old: T) => T)(slots[i] as T) : value;
      }] as const;
    },
    useRef<T>(initial: T) { const i = index++; if (!(i in slots)) slots[i] = { current: initial };
      return slots[i] as { current: T }; },
    useEffect(effect: () => void) { const i = index++; if (!(i in slots)) { slots[i] = true; effects.push(effect); } },
  };
});
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: h.useState,
  useRef: h.useRef, useEffect: h.useEffect }));
const adapter = vi.hoisted(() => vi.fn().mockResolvedValue({ source: 'in_cloud', result: {
  text: 'DEV_UNGROUNDED_SENTINEL', parts: ['DEV_UNGROUNDED_SENTINEL'], sources: [], supports: [],
  suggestions: '', grounded: false,
} }));
vi.mock('../ai/cloudResearch', async original => ({ ...await original<typeof import('../ai/cloudResearch')>(),
  createCloudAdapter: () => adapter }));
vi.mock('../ui/service', () => ({ config: { projectId: 'fake' } }));
vi.mock('../settings/remoteSettings', async () => {
  const { builtInSettings } = await import('../settings/defaults');
  return { loadSettings: async () => builtInSettings() };
});
import { Run4Runner } from './Run4Runner';
import { run4Export } from './Run4Panel';
function nodes(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  return [element, ...nodes(element.props.children)];
}
function render() { h.begin(); return Run4Runner(); }
afterEach(() => { vi.unstubAllGlobals(); adapter.mockClear(); });
it('withholds a DEV idea response through the actual click, view and metric export path', async () => {
  h.reset();
  vi.stubGlobal('window', { confirm: () => true });
  const seed = await openLocalStore();
  await seed.clearAll({ getItem: () => null, removeItem: () => {} });
  try {
    render(); h.flush();
    await vi.waitFor(() => {
      const buttons = nodes(render()).filter(node => node.type === 'button');
      expect(buttons.some(node => (node.props as { children?: string }).children === 'Research idea' &&
        !(node.props as { disabled?: boolean }).disabled)).toBe(true);
    });
    const button = nodes(render()).find(node => node.type === 'button' &&
      (node.props as { children?: string }).children === 'Research idea')!;
    (button.props as { onClick(): void }).onClick();
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledOnce());
    await vi.waitFor(async () => expect((await seed.snapshot()).researchReceipts)
      .toMatchObject([{ status: 'completed', failureCode: 'ungrounded' }]));
    await vi.waitFor(() => expect(JSON.stringify(render())).toContain('No web sources were attached'));
    const tree = render();
    expect(JSON.stringify(tree)).not.toContain('DEV_UNGROUNDED_SENTINEL');
    const panel = nodes(tree).find(node => typeof node.type === 'function' && node.type.name === 'Run4Panel')!;
    const props = panel.props as Parameters<typeof import('./Run4Panel').Run4Panel>[0];
    expect(props.research).toEqual({});
    expect(props.metrics).toHaveLength(1);
    expect(props.metrics[0]).toMatchObject({ grounded: false, displayed: false });
    const exported = run4Export(props.metrics, {});
    expect(exported.rows[0].ratings).toBeNull();
    expect(JSON.stringify(exported)).not.toContain('DEV_UNGROUNDED_SENTINEL');
    const html = renderToStaticMarkup(tree);
    expect(html).not.toContain('DEV_UNGROUNDED_SENTINEL');
    expect(html).not.toContain('Similar work useful');
    expect(html).not.toContain('Difference useful');
  } finally { seed.close(); }
}, 15000);
