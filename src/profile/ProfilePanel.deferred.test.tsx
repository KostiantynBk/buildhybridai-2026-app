import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProfileRecord } from '../store';

const hooks = vi.hoisted(() => ({ slots: [] as unknown[], index: 0 }));
vi.mock('react', async importOriginal => {
  const original = await importOriginal<typeof import('react')>();
  return {
    ...original,
    useState: (initial: unknown) => {
      const index = hooks.index++;
      if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === 'function' ? initial() : initial;
      return [hooks.slots[index], (next: unknown) => {
        hooks.slots[index] = typeof next === 'function' ? next(hooks.slots[index]) : next;
      }];
    },
    useRef: (initial: unknown) => {
      const index = hooks.index++;
      if (!(index in hooks.slots)) hooks.slots[index] = { current: initial };
      return hooks.slots[index];
    },
    useEffect: () => {},
  };
});
import { ProfilePanel } from './ProfilePanel';

type Node = { type?: unknown; props?: { children?: unknown; [key: string]: unknown } };
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object') return [];
  const node = value as Node;
  return [node, ...nodes(node.props?.children)];
}
function element(tree: unknown, type: string, predicate: (node: Node) => boolean = () => true): Node {
  const found = nodes(tree).find(node => node.type === type && predicate(node));
  if (!found) throw new Error(`Missing ${type}`);
  return found;
}
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const existing: ProfileRecord = { id: 'record-1', type: 'project', text: 'Existing project',
  topics: [], tags: [], updatedAt: 1 };
function setup(save: (record: ProfileRecord) => Promise<void>) {
  const props = { records: [existing], save, remove: async () => {}, replace: async () => {},
    clearAll: async () => {} };
  const render = () => { hooks.index = 0; return ProfilePanel(props); };
  const typeText = (value: string) => {
    const input = element(render(), 'textarea');
    (input.props?.onChange as (event: unknown) => void)({ target: { value } });
  };
  const submit = () => {
    const form = element(render(), 'form');
    (form.props?.onSubmit as (event: unknown) => void)({ preventDefault() {} });
  };
  return { render, typeText, submit };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
beforeEach(() => { hooks.slots = []; hooks.index = 0; });

describe('deferred profile save', () => {
  it('retains newer typing and marks it unsaved; duplicate submits are ignored', async () => {
    const pending = deferred();
    const save = vi.fn((_record: ProfileRecord) => pending.promise);
    const ui = setup(save);
    ui.typeText('First saved draft');
    ui.submit();
    ui.typeText('New unsaved typing while save is pending');
    ui.submit();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0].text).toBe('First saved draft');
    pending.resolve();
    await flush();
    const tree = ui.render();
    expect(element(tree, 'textarea').props?.value).toBe('New unsaved typing while save is pending');
    expect(element(tree, 'p', node => node.props?.role === 'status').props?.children).toBe('Unsaved profile draft.');
  });
  it('preserves a newly selected editing context when an older save completes', async () => {
    const pending = deferred();
    const ui = setup(() => pending.promise);
    ui.typeText('First saved draft');
    ui.submit();
    const edit = element(ui.render(), 'button', node => node.props?.children === 'Edit');
    (edit.props?.onClick as () => void)();
    pending.resolve();
    await flush();
    const tree = ui.render();
    expect(element(tree, 'textarea').props?.value).toBe('Existing project');
    expect(element(tree, 'h3', node => node.props?.children === 'Edit record')).toBeDefined();
    expect(element(tree, 'p', node => node.props?.role === 'status')).toBeDefined();
  });
  it('keeps newer typing and reports failure if the earlier save rejects', async () => {
    const pending = deferred();
    const ui = setup(() => pending.promise);
    ui.typeText('First saved draft');
    ui.submit();
    ui.typeText('New unsaved typing');
    pending.reject(new Error('private detail'));
    await flush();
    const tree = ui.render();
    expect(element(tree, 'textarea').props?.value).toBe('New unsaved typing');
    expect(element(tree, 'p', node => node.props?.role === 'alert').props?.children)
      .toBe('The earlier save failed. Your current draft has not been saved.');
  });
});
