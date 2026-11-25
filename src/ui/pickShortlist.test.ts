import { expect, it, vi } from 'vitest';
import type { LocalStore, Snapshot } from '../store';
import type { LocalService } from '../store/scheduler';
import type { Job } from '../ai/localModel';
import { pickV1 } from '../pipeline/prompts/pick.v1';
import { PickShortlist, pickInput } from './pickShortlist';
import { eligibleMarks } from './marks';

function fixture(count = 4): Snapshot {
  const state: Snapshot = { paragraphs: [], profile: [], items: [], jobs: [], lineages: [], cards: [] };
  for (let i = 0; i < count; i++) {
    const p = { id: `p${i}`, projectId: 'default', order: i, text: `A fictional statement number ${i} exists.`,
      version: 1, updatedAt: 0 };
    state.paragraphs.push(p);
    state.items.push({ id: `i${i}`, paragraphId: p.id, paragraphVersion: 1, kind: 'assumption',
      text: `Statement ${i}`, quote: p.text, topics: [], status: 'current', promptVersion: 'extract.v2',
      createdAt: 1, lineageId: `l${i}` });
    state.lineages!.push({ lineageId: `l${i}`, version: 1, itemId: `i${i}`, paragraphId: p.id,
      paragraphVersion: 1, status: 'current' });
    state.jobs.push({ key: `p${i}@1#extract`, paragraphId: p.id, paragraphVersion: 1, step: 'extract',
      promptVersion: 'extract.v2', status: 'done', attempts: 1, createdAt: 1, nextRunAt: 1 });
    state.cards!.push({ id: `c${i}`, paragraphId: p.id, paragraphVersion: 1, itemLineageId: `l${i}`,
      itemVersion: 1, itemText: `Statement ${i}`, itemQuote: p.text, topics: [], angle: 'end-user',
      sourceAngle: 'end-user', concern: 'A synthetic public concern.', score: 1, lessonId: null, brief: false,
      sessionId: 's', questionStatus: 'marked', createdAt: 1 });
  }
  return state;
}
function setup(state: Snapshot, data: unknown = { picks: [4, 2, 2] }, source = 'on_device') {
  const store = { pickSnapshot: vi.fn(async () => ({ snapshot: structuredClone(state),
    ready: !state.cloudModeEnabled && !state.jobs.some(job => job.status === 'pending' || job.status === 'running') }))
  } as unknown as LocalStore;
  const runLocal = vi.fn(async (job: Job<unknown>) => {
    if (job.beforeDispatch && !await job.beforeDispatch()) throw new Error('cancelled');
    job.onDispatch?.(); return { data, source, latencyMs: 1, raw: '' };
  });
  const service = { runLocal } as unknown as LocalService;
  const picker = new PickShortlist(() => {});
  return { store, service, runLocal, picker };
}
const run = (value: ReturnType<typeof setup>, signal = new AbortController().signal) =>
  value.picker.run(value.store, value.service, signal);
const ids = (value: ReturnType<typeof setup>, state: Snapshot, cloud = false) =>
  value.picker.view(state, cloud).marks.map(item => item.mark.id);

it('ships the exact instruction, schema and only the first 24 eligible mark lines', () => {
  const system = 'You help a solo builder decide what to verify first in their product plan. ' +
    'Each numbered item below is a statement from the plan that was marked as worth checking, with its exact quote. ' +
    'Choose up to three items that are most worth checking with a web search before building. ' +
    'Prefer specific external facts the plan relies on that could be wrong or out of date — for example service ' +
    'tiers, quotas, limits, prices, availability, terms of use, or what a platform, browser or device can do — ' +
    "and that would change the plan if they were wrong. Avoid items that are only the builder's own preferences, " +
    'internal design choices, schedules or wording. Return JSON only: {"picks": [numbers]}, most important first.';
  expect(pickV1.system).toBe(system);
  const input = pickInput(eligibleMarks(fixture(26)));
  expect(input.split('\n')).toHaveLength(24);
  expect(input.split('\n')[0]).toBe(
    '1. [For the user] assumption: Statement 0 — "A fictional statement number 0 exists."');
  expect(input).not.toContain('Statement 24');
});
it('does not call with three marks, pending work, or cloud mode', async () => {
  const three = fixture(3); const first = setup(three); await run(first); expect(first.runLocal).not.toHaveBeenCalled();
  const state = fixture(); state.jobs[0].status = 'pending';
  const value = setup(state); await run(value); expect(value.runLocal).not.toHaveBeenCalled();
  state.jobs[0].status = 'running'; await run(value); expect(value.runLocal).not.toHaveBeenCalled();
  state.jobs[0].status = 'done'; state.cloudModeEnabled = true;
  await run(value); expect(value.runLocal).not.toHaveBeenCalled();
  expect(ids(value, state, true)).toEqual(['c0', 'c1', 'c2']);
});
it('reorders valid picks, drops duplicates/out-of-range, fills and attempts only once per fingerprint', async () => {
  const state = fixture(); const value = setup(state, { picks: [4, 99, 4] });
  await run(value);
  expect(ids(value, state)).toEqual(['c3', 'c0', 'c1']);
  expect(value.picker.view(state, false).chosen).toBe(true);
  await run(value); expect(value.runLocal).toHaveBeenCalledOnce();
  state.cards![3].supersededMark = true;
  await run(value); expect(value.runLocal).toHaveBeenCalledOnce();
  state.cards![3].supersededMark = false;
  const fifth = fixture(5); state.paragraphs.push(fifth.paragraphs[4]); state.items.push(fifth.items[4]);
  state.jobs.push(fifth.jobs[4]); state.lineages!.push(fifth.lineages![4]); state.cards!.push(fifth.cards![4]);
  await run(value); expect(value.runLocal).toHaveBeenCalledTimes(2);
  expect(ids(value, state, true)).toEqual(['c0', 'c1', 'c2']);
  expect(value.picker.view(state, true).chosen).toBe(false);
});
it.each([
  { data: { picks: ['1'] }, source: 'on_device' }, { data: { picks: [99, 0] }, source: 'on_device' },
  { data: { picks: [1, 2, 3, 4] }, source: 'on_device' }, { data: { picks: [4] }, source: 'in_cloud' },
])('silently falls back for invalid or unverified output %#', async output => {
  const state = fixture(); const value = setup(state, output.data, output.source);
  await run(value); expect(ids(value, state)).toEqual(['c0', 'c1', 'c2']);
  expect(value.picker.view(state, false).chosen).toBe(false);
});
it('silently falls back for timeout, invalid JSON and errors', async () => {
  for (const message of ['timeout', 'invalid JSON', 'model failed']) {
    const state = fixture(); const value = setup(state);
    value.runLocal.mockImplementation(async job => { job.onDispatch?.(); throw new Error(message); });
    await run(value); expect(ids(value, state)).toEqual(['c0', 'c1', 'c2']);
    expect(value.picker.view(state, false)).toMatchObject({ chosen: false, choosing: false });
  }
});
it('only shows pending while dispatched and discards a result when work or fingerprint changes', async () => {
  const state = fixture(); const value = setup(state);
  let release!: (value: { data: unknown; source: string; latencyMs: number; raw: string }) => void;
  value.runLocal.mockImplementation(job => {
    job.onDispatch?.(); return new Promise(resolve => { release = resolve; });
  });
  const pending = run(value);
  await vi.waitFor(() => expect(value.picker.view(state, false).choosing).toBe(true));
  state.jobs[0].status = 'pending';
  release({ data: { picks: [4] }, source: 'on_device', latencyMs: 1, raw: '' });
  await pending;
  expect(value.picker.view(state, false)).toMatchObject({ chosen: false, choosing: false });
  expect(ids(value, state)).toEqual(['c1', 'c2', 'c3']);
});
it('discards a pick if another tab completes new durable work before it returns', async () => {
  const state = fixture(); const value = setup(state);
  let release!: (value: { data: unknown; source: string; latencyMs: number; raw: string }) => void;
  value.runLocal.mockImplementation(job => {
    job.onDispatch?.(); return new Promise(resolve => { release = resolve; });
  });
  const pending = run(value);
  await vi.waitFor(() => expect(value.picker.view(state, false).choosing).toBe(true));
  state.jobs.push({ ...state.jobs[0], key: 'explicit-completed', step: 'question', status: 'done', attempts: 1 });
  release({ data: { picks: [4] }, source: 'on_device', latencyMs: 1, raw: '' });
  await pending;
  expect(value.picker.view(state, false).chosen).toBe(false);
  expect(ids(value, state)).toEqual(['c0', 'c1', 'c2']);
});
it('calls once for a new eligible fingerprint after a mark is removed while four remain', async () => {
  const state = fixture(5); const value = setup(state, { picks: [3, 2] });
  await run(value); expect(value.runLocal).toHaveBeenCalledOnce();
  state.cards![4].supersededMark = true;
  await run(value); expect(value.runLocal).toHaveBeenCalledTimes(2);
  expect(value.picker.view(state, false).chosen).toBe(true);
});
it('clears Choosing as soon as generation ends, before the postflight read completes', async () => {
  const state = fixture(); const value = setup(state, { picks: [4] });
  const pickSnapshot = value.store.pickSnapshot as ReturnType<typeof vi.fn>;
  let reads = 0;
  let unblock!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  pickSnapshot.mockImplementation(async () => {
    reads++;
    if (reads === 3) await gate;
    return { snapshot: structuredClone(state), ready: true };
  });
  const pending = run(value);
  await vi.waitFor(() => expect(reads).toBe(3));
  expect(value.picker.view(state, false).choosing).toBe(false);
  expect(value.picker.view(state, false).chosen).toBe(false);
  unblock(); await pending;
  expect(value.picker.view(state, false).chosen).toBe(true);
});
it('clears Choosing as soon as a new request interrupts a held native call', async () => {
  const state = fixture(); const value = setup(state);
  let release!: (value: { data: unknown; source: string; latencyMs: number; raw: string }) => void;
  value.runLocal.mockImplementation(job => {
    job.onDispatch?.(); return new Promise(resolve => { release = resolve; });
  });
  const controller = new AbortController();
  const pending = run(value, controller.signal);
  await vi.waitFor(() => expect(value.picker.view(state, false).choosing).toBe(true));
  controller.abort();
  expect(value.picker.view(state, false).choosing).toBe(false);
  release({ data: { picks: [4] }, source: 'on_device', latencyMs: 1, raw: '' });
  await pending;
  expect(value.picker.view(state, false).chosen).toBe(false);
});
