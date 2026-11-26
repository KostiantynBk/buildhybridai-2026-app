import { expect, it, vi } from 'vitest';
import { focusCheck } from './checkFocus';

it('focuses an explicitly requested card without stealing later notebook focus', () => {
  const trigger = {} as Element;
  const notebook = {} as Element;
  const body = {} as HTMLElement;
  const target = { scrollIntoView: vi.fn(), focus: vi.fn() };
  const doc = { activeElement: trigger, body, getElementById: vi.fn(() => target) } as unknown as Document;
  expect(focusCheck({ cardId: 'one', trigger }, doc, 'panel')).toBe(true);
  expect(doc.getElementById).toHaveBeenCalledWith('check-card-panel-one');
  expect(target.focus).toHaveBeenCalledOnce();
  Object.defineProperty(doc, 'activeElement', { value: notebook });
  expect(focusCheck({ cardId: 'two', trigger }, doc, 'panel')).toBe(true);
  expect(target.focus).toHaveBeenCalledOnce();
});
it('waits for a requested card to appear', () => {
  const doc = { getElementById: () => null } as unknown as Document;
  expect(focusCheck({ cardId: 'one', trigger: null }, doc, 'panel')).toBe(false);
});
it.each(['inert', 'hidden'] as const)('does not consume a %s target and retries when interactive', blocked => {
  const trigger = {} as Element;
  const body = {} as HTMLElement;
  let ancestor: object | null = {};
  const target = { closest: vi.fn(() => ancestor), scrollIntoView: vi.fn(), focus: vi.fn() };
  const doc = { activeElement: body, body, getElementById: () => target } as unknown as Document;
  const request = { cardId: 'one', trigger };
  expect(focusCheck(request, doc, 'panel')).toBe(false);
  expect(target.closest).toHaveBeenCalledWith('[inert], [hidden]');
  expect(target.scrollIntoView).not.toHaveBeenCalled();
  expect(target.focus).not.toHaveBeenCalled();
  ancestor = null;
  expect(focusCheck(request, doc, 'panel')).toBe(true);
  expect(target.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  expect(target.focus).toHaveBeenCalledOnce();
});
it('does not replay a blocked focus request after the user moves focus elsewhere', () => {
  const trigger = {} as Element;
  const body = {} as HTMLElement;
  const elsewhere = {} as Element;
  const target = { closest: vi.fn(() => ({})), scrollIntoView: vi.fn(), focus: vi.fn() };
  const doc = { activeElement: elsewhere, body, getElementById: () => target } as unknown as Document;
  expect(focusCheck({ cardId: 'one', trigger }, doc, 'panel')).toBe(true);
  expect(target.scrollIntoView).not.toHaveBeenCalled(); expect(target.focus).not.toHaveBeenCalled();
});
