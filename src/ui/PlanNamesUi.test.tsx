import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { IdeaRecord, Snapshot } from '../store';
import type { ThoughtCard } from '../store/triageTypes';

const h = vi.hoisted(() => {
  let slots: unknown[] = []; let cursor = 0; let effects: Array<() => void> = [];
  return {
    reset() { slots = []; cursor = 0; effects = []; },
    begin() { cursor = 0; },
    flush() { for (const effect of effects.splice(0)) effect(); },
    useState<T>(initial: T | (() => T)) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? (initial as () => T)() : initial;
      return [slots[i], (value: T | ((old: T) => T)) => {
        slots[i] = typeof value === 'function' ? (value as (old: T) => T)(slots[i] as T) : value;
      }] as const;
    },
    useRef<T>(initial: T) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial };
      return slots[i] as { current: T }; },
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
const checkControl = vi.hoisted(() => ({ fail: false }));
vi.mock('./planNames', async original => {
  const actual = await original<typeof import('./planNames')>();
  return { ...actual, findPlanNames: (...args: Parameters<typeof actual.findPlanNames>) => {
    if (checkControl.fail) throw new Error('forced check failure');
    return actual.findPlanNames(...args);
  } };
});
import { IdeaPanel } from './IdeaPanel';
import { DraftControls } from './DraftControls';

function nodes(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  return [element, ...nodes(element.props.children)];
}
function setText(tree: ReactElement, value: string) {
  const textarea = nodes(tree).find(node => node.type === 'textarea')!;
  (textarea.props as { onChange(event: unknown): void }).onChange({ target: { value } });
}
function sendButton(tree: ReactElement) {
  return nodes(tree).find(node => node.type === 'button' &&
    ['Send anyway', 'Send this description', 'Send this question'].includes(
      (node.props as { children?: string }).children ?? ''))!;
}
const idea: IdeaRecord = { id: 'idea', status: 'ready', draft: 'A neutral draft for this idea.', keptOut: [
  'Stripe', 'stripe', 'Stripe account', 'Project name'], statements: [], basis: [], mode: 'on_device',
  describePromptVersion: 'describe.v1', researchPromptVersion: 'research.idea.v1', describeJobKey: 'job',
  createdAt: 1, updatedAt: 1 };
const snapshot: Snapshot = { paragraphs: [], items: [], profile: [], jobs: [{ key: 'job', paragraphId: 'p',
  paragraphVersion: 1, step: 'describe', promptVersion: 'describe.v1', status: 'done', attempts: 1, createdAt: 1,
  nextRunAt: 1 }] };
const card = { id: 'card', questionStatus: 'ready', draftQuestion: 'A neutral question?' } as ThoughtCard;
const plan = ['Osteria Lunetta and Paolo run the restaurant.'];
afterEach(() => { checkControl.fail = false; });
it('updates idea warnings as edited and sends exactly the checked description', async () => {
  h.reset();
  const send = vi.fn().mockResolvedValue(undefined);
  const render = () => { h.begin(); return IdeaPanel({ snapshot, idea, planTexts: plan,
    start: async () => {}, send, retry: async () => {}, decline: async () => {} }); };
  render(); h.flush();
  let tree = render();
  expect(renderToStaticMarkup(tree)).not.toContain('This looks like a name from your plan');
  expect(renderToStaticMarkup(tree)).toContain('Left out of the description: Stripe account, Project name');
  expect(idea.keptOut).toEqual(['Stripe', 'stripe', 'Stripe account', 'Project name']);
  setText(tree, 'What does Osteria Lunetta offer?');
  tree = render();
  expect(renderToStaticMarkup(tree)).toContain('This looks like a name from your plan: Osteria Lunetta.');
  expect((sendButton(tree).props as { children: string }).children).toBe('Send anyway');
  (sendButton(tree).props as { onClick(): void }).onClick();
  expect(send).toHaveBeenCalledWith('idea', 'What does Osteria Lunetta offer?');
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
  setText(render(), 'What do restaurants offer?');
  tree = render();
  expect(renderToStaticMarkup(tree)).not.toContain('This looks like a name from your plan');
  expect((sendButton(tree).props as { children: string }).children).toBe('Send this description');
});
it.each(['idea', 'question'] as const)('handles a long text and a genuine matching run on %s', surface => {
  h.reset();
  const long = Array(8192).fill('Rosa').join(' ');
  let currentPlan = [long];
  const render = () => { h.begin(); return surface === 'idea' ? IdeaPanel({ snapshot, idea, planTexts: currentPlan,
    start: async () => {}, send: async () => {}, retry: async () => {}, decline: async () => {} }) :
    DraftControls({ card, planTexts: currentPlan, send: async () => {} })!; };
  render(); h.flush();
  setText(render(), `Please consider ${long} today.`);
  const tree = render();
  expect((sendButton(tree).props as { children: string }).children).toBe('Send anyway');
  expect(renderToStaticMarkup(tree)).toContain('This looks like a name from your plan:');
  currentPlan = ['Paolo appears in this short plan.'];
  setText(tree, `Please consider ${long}. Then ask Paolo today.`);
  const shortPlanTree = render();
  expect(renderToStaticMarkup(shortPlanTree)).toContain('This looks like a name from your plan: Paolo.');
  expect((sendButton(shortPlanTree).props as { children: string }).children).toBe('Send anyway');
});
it.each(['idea', 'question'] as const)('fails closed if the name check throws on %s', surface => {
  h.reset();
  const render = () => { h.begin(); return surface === 'idea' ? IdeaPanel({ snapshot, idea, planTexts: plan,
    start: async () => {}, send: async () => {}, retry: async () => {}, decline: async () => {} }) :
    DraftControls({ card, planTexts: plan, send: async () => {} })!; };
  render(); h.flush();
  checkControl.fail = true;
  const tree = render();
  expect(renderToStaticMarkup(tree)).toContain(
    'Couldn&#x27;t check this text for names from your plan. Review it before sending.');
  expect((sendButton(tree).props as { children: string }).children).toBe('Send anyway');
});
it('updates warnings when the current plan text changes', () => {
  h.reset();
  let currentPlan = [...plan];
  const render = () => { h.begin(); return IdeaPanel({ snapshot, idea, planTexts: currentPlan,
    start: async () => {}, send: async () => {}, retry: async () => {}, decline: async () => {} }); };
  render(); h.flush();
  setText(render(), 'What does Osteria Lunetta offer?');
  expect(renderToStaticMarkup(render())).toContain('This looks like a name from your plan: Osteria Lunetta.');
  currentPlan = ['Restaurants need a booking page.'];
  expect(renderToStaticMarkup(render())).not.toContain('This looks like a name from your plan');
});
it('updates question warnings as edited and sends exactly the checked question', async () => {
  h.reset();
  const send = vi.fn().mockResolvedValue(undefined);
  const render = () => { h.begin(); return DraftControls({ card, planTexts: plan, send })!; };
  render(); h.flush();
  setText(render(), 'Can guests ask Paolo for help?');
  let tree = render();
  expect(renderToStaticMarkup(tree)).toContain('This looks like a name from your plan: Paolo.');
  expect((sendButton(tree).props as { children: string }).children).toBe('Send anyway');
  (sendButton(tree).props as { onClick(): void }).onClick();
  expect(send).toHaveBeenCalledWith('card', 'Can guests ask Paolo for help?');
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
  setText(render(), 'Can restaurants benefit?');
  tree = render();
  expect(renderToStaticMarkup(tree)).not.toContain('This looks like a name from your plan');
  expect((sendButton(tree).props as { children: string }).children).toBe('Send this question');
});
