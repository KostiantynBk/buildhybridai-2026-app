import { afterEach, expect, it, vi } from 'vitest';
import type { Snapshot } from '../store';

const h = vi.hoisted(() => {
  let slots: unknown[] = []; let cursor = 0; let effects: Array<() => void> = [];
  return {
    reset() { slots = []; cursor = 0; effects = []; },
    begin() { cursor = 0; },
    flush() { for (const effect of effects.splice(0)) effect(); },
    useState<T>(initial: T | (() => T)) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? (initial as () => T)() : initial;
      return [slots[i], (value: T) => { slots[i] = value; }] as const;
    },
    useRef<T>(initial: T) {
      const i = cursor++; if (!(i in slots)) slots[i] = { current: initial };
      return slots[i] as { current: T };
    },
    useEffect(effect: () => void, dependencies: unknown[]) {
      const i = cursor++; const previous = slots[i] as unknown[] | undefined;
      if (!previous || dependencies.some((value, index) => value !== previous[index])) {
        slots[i] = dependencies; effects.push(effect);
      }
    },
  };
});
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: h.useState,
  useRef: h.useRef, useEffect: h.useEffect }));
import { NotebookPanel } from './NotebookPanel';

afterEach(() => { vi.unstubAllGlobals(); h.reset(); });
it.each([false, true])('retries after saving but does not steal focus if moved elsewhere: %s', moved => {
  const snapshot: Snapshot = { paragraphs: [], items: [], profile: [], jobs: [], cards: [] };
  const body = {} as HTMLElement, trigger = {} as Element, elsewhere = {} as Element;
  let blocked = true;
  const target = { closest: () => blocked ? {} : null, scrollIntoView: vi.fn(), focus: vi.fn() };
  const doc = { body, activeElement: body as Element, getElementById: () => target };
  vi.stubGlobal('document', doc);
  const focusRequest = { cardId: 'card', trigger };
  const render = (storageStatus: 'saved' | 'saving') => {
    h.begin(); NotebookPanel({ text: 'fake', save() {}, snapshot, storageStatus, configured: true, ready: true,
      focusRequest });
    h.flush();
  };
  render('saving');
  expect(target.scrollIntoView).not.toHaveBeenCalled(); expect(target.focus).not.toHaveBeenCalled();
  blocked = false;
  if (moved) doc.activeElement = elsewhere;
  render('saved');
  expect(target.scrollIntoView).toHaveBeenCalledTimes(moved ? 0 : 1);
  expect(target.focus).toHaveBeenCalledTimes(moved ? 0 : 1);
  render('saved');
  expect(target.focus).toHaveBeenCalledTimes(moved ? 0 : 1);
});
