import { afterEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const refs: { current: any }[] = [];
  const effects: Array<() => (() => void) | void> = [];
  return { refs, effects, reset() { refs.length = 0; effects.length = 0; },
    useRef(value: any) { const ref = { current: value }; refs.push(ref); return ref; },
    useEffect(effect: () => (() => void) | void) { effects.push(effect); } };
});
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useEffect: h.useEffect, useRef: h.useRef }));
import { ConsentDialog, consentFocus } from './ConsentDialog';

afterEach(() => { h.reset(); vi.unstubAllGlobals(); });
it('opens a modal, traps Tab in both directions, and returns focus after close', () => {
  const doc = { activeElement: null as unknown };
  class ElementStub {
    isConnected = true;
    focus() { doc.activeElement = this; }
    closest() { return fallback; }
  }
  vi.stubGlobal('document', doc); vi.stubGlobal('HTMLElement', ElementStub);
  const trigger = new ElementStub(), fallback = new ElementStub();
  const first = new ElementStub(), last = new ElementStub();
  const modal = { open: false, showModal() { this.open = true; }, close() { this.open = false; },
    querySelectorAll() { return [first, last]; } };
  const finish = vi.fn();
  const tree = ConsentDialog({ request: { ...consentFocus(trigger as unknown as Element), message: 'Fake', finish } });
  h.refs[0].current = modal; h.refs[1].current = last;
  const cleanup = h.effects[0]()!;
  expect(modal.open).toBe(true); expect(doc.activeElement).toBe(last);
  const keydown = (tree.props as any).onKeyDown;
  const preventDefault = vi.fn();
  keydown({ key: 'Tab', shiftKey: false, preventDefault });
  expect(doc.activeElement).toBe(first); expect(preventDefault).toHaveBeenCalledOnce();
  keydown({ key: 'Tab', shiftKey: true, preventDefault });
  expect(doc.activeElement).toBe(last); expect(preventDefault).toHaveBeenCalledTimes(2);
  cleanup(); expect(modal.open).toBe(false); expect(doc.activeElement).toBe(trigger);
});
it('returns focus to the card when approval removed the trigger', () => {
  const doc = { activeElement: null as unknown };
  class ElementStub { isConnected = true; focus() { doc.activeElement = this; } }
  vi.stubGlobal('document', doc); vi.stubGlobal('HTMLElement', ElementStub);
  const trigger = new ElementStub(), fallback = new ElementStub();
  trigger.isConnected = false;
  ConsentDialog({ request: { trigger: trigger as unknown as Element, fallback: fallback as unknown as Element,
    message: 'Fake', finish() {} } });
  h.refs[0].current = { open: false, showModal() { this.open = true; }, close() { this.open = false; } };
  h.refs[1].current = { focus() {} };
  const cleanup = h.effects[0]()!; cleanup();
  expect(doc.activeElement).toBe(fallback);
});
it.each(['outbox', 'cloud'] as const)('uses stable main focus for a disabled or disappearing %s trigger', kind => {
  const doc = { activeElement: null as unknown, querySelector: () => main };
  class ElementStub {
    isConnected = true;
    disabled = false;
    focus() { if (!this.disabled) doc.activeElement = this; }
    closest() { return null; }
  }
  vi.stubGlobal('document', doc); vi.stubGlobal('HTMLElement', ElementStub);
  const main = new ElementStub(), trigger = new ElementStub();
  trigger.disabled = kind === 'outbox';
  const request = { ...consentFocus(trigger as unknown as Element), message: 'Fake', cloudMode: kind === 'cloud',
    finish() {} };
  const tree = ConsentDialog({ request });
  h.refs[0].current = { open: false, showModal() { this.open = true; }, close() { this.open = false; } };
  h.refs[1].current = { focus() {} };
  const cleanup = h.effects[0]()!;
  if (kind === 'cloud') {
    const children = (tree.props as { children: any[] }).children;
    (children[2].props as { onClick(): void }).onClick();
  }
  cleanup();
  expect(doc.activeElement).toBe(main);
});
