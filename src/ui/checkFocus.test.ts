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
