import { expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { ThoughtCard } from '../store/triageTypes';

const hooks = vi.hoisted(() => {
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
      const i = cursor++;
      if (!(i in slots)) slots[i] = { current: initial };
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
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: hooks.useState,
  useRef: hooks.useRef, useEffect: hooks.useEffect }));
import { DraftControls } from './DraftControls';
function nodes(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  return [element, ...nodes(element.props.children)];
}
it('loads a question arriving after waiting without replacing a later user edit', () => {
  hooks.reset();
  const card = { id: 'c', questionStatus: 'waiting' } as ThoughtCard;
  hooks.begin(); DraftControls({ card }); hooks.flush();
  card.questionStatus = 'ready'; card.draftQuestion = 'Generated question?';
  hooks.begin(); DraftControls({ card }); hooks.flush();
  hooks.begin();
  let tree = DraftControls({ card });
  let field = nodes(tree).find(element => element.type === 'textarea')!;
  expect((field.props as { value: string }).value).toBe('Generated question?');
  (field.props as { onChange(event: unknown): void }).onChange({ target: { value: 'My edited question?' } });
  card.draftQuestion = 'New server draft?';
  hooks.begin(); DraftControls({ card }); hooks.flush();
  hooks.begin(); tree = DraftControls({ card });
  field = nodes(tree).find(element => element.type === 'textarea')!;
  expect((field.props as { value: string }).value).toBe('My edited question?');
});
it('does not start Send while retained controls are disabled and works after re-enabling', () => {
  hooks.reset();
  const card = { id: 'c', questionStatus: 'ready', draftQuestion: 'A fictional question?' } as ThoughtCard;
  const send = vi.fn().mockResolvedValue(undefined);
  const render = (controlsDisabled: boolean) => {
    hooks.begin(); return DraftControls({ card, send, controlsDisabled })!;
  };
  const button = (disabled: boolean) => nodes(render(disabled)).find(element => element.type === 'button' &&
    (element.props as { children?: string }).children === 'Send this question')!;
  expect((button(true).props as { disabled?: boolean }).disabled).toBe(true);
  (button(true).props as { onClick(): void }).onClick();
  expect(send).not.toHaveBeenCalled();
  (button(false).props as { onClick(): void }).onClick();
  expect(send).toHaveBeenCalledWith('c', 'A fictional question?');
});
