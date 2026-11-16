import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';
// This regression explicitly exercises the pinned v2 path.
vi.mock('../pipeline/triageVersion', async importOriginal => ({
  ...(await importOriginal<typeof import('../pipeline/triageVersion')>()), TRIAGE_PROMPT_SET: 'v2',
}));

import type { Job } from '../ai/localModel';
import { anglesV2 } from '../pipeline/prompts/angles.v2';
import { questionV2 } from '../pipeline/prompts/question.v2';
import { whynoteV2 } from '../pipeline/prompts/whynote.v2';
import { prepareSessionStart, sessionForPlay } from '../eval/sessionPlayer';
import { openLocalStore } from './index';
import { Scheduler, type LocalService } from './scheduler';

const paragraph = 'The hosting service supports fifty users at once ' +
  'and provides a simple catalogue for early visitors.';
const item = { kind: 'assumption', text: 'Fifty users', quote: 'The hosting service supports fifty users at once',
  topics: ['hosting'] };
it('runs the durable local pipeline and keeps profile/list sentinels out of forbidden prompts and Outbox', async () => {
  const store = await openLocalStore(`triage-${crypto.randomUUID()}`);
  await store.putProfile({ id: 's1', type: 'skill', depth: 'new', text: 'PROFILE_SENTINEL', topics: ['hosting'],
    tags: [], updatedAt: 0 });
  await store.putProfile({ id: 'lesson', type: 'lesson', text: 'LESSON_PROFILE_SENTINEL', topics: ['hosting'],
    tags: [], updatedAt: 0 });
  await store.putNeverSend(['NEVER_SEND_SENTINEL']);
  await store.saveNotebook(paragraph, 0);
  const run = vi.fn(async (job: Job<unknown>) => {
    job.onDispatch?.();
    const data = job.instructions === anglesV2 ? { concerns: [{ item: 1, angle: 'limits-operations',
      concern: 'Could hosting have limits?', checkable: true }] } : job.instructions === questionV2
      ? { question: 'Which hosting limits apply?', keptOut: ['client name', 'NEVER_SEND_SENTINEL'] }
      : job.instructions === whynoteV2 ? { seeing: 'You plan hosting.', why: 'Your experience is relevant.',
        used: ['s1', 'unknown'] } : { items: [item] };
    return { data, source: 'on_device', latencyMs: 1, raw: '{}' };
  });
  const service = { state: { kind: 'ready' }, subscribe: () => () => {}, runLocal: run } as unknown as LocalService;
  const scheduler = new Scheduler(store, service, () => 'extract.v2', () => {}, () => 10000);
  try {
    await scheduler.start();
    await scheduler.tick();
    await scheduler.tick();
    await scheduler.tick();
    const snapshot = await store.snapshot();
    expect(snapshot.cards).toHaveLength(1);
    expect(snapshot.cards![0]).toMatchObject({ angle: 'track-record', questionStatus: 'ready', why: { used: ['s1'] } });
    expect(snapshot.outbox).toHaveLength(1);
    expect(snapshot.outbox![0]).toMatchObject({ question: 'Which hosting limits apply?', status: 'pending',
      keptOut: ['client name'] });
    expect(JSON.stringify(snapshot.outbox)).not.toContain('PROFILE_SENTINEL');
    expect(JSON.stringify(snapshot.outbox)).not.toContain('NEVER_SEND_SENTINEL');
    const anglesCall = run.mock.calls.find(call => call[0].instructions === anglesV2)![0];
    const questionCall = run.mock.calls.find(call => call[0].instructions === questionV2)![0];
    const whyCall = run.mock.calls.find(call => call[0].instructions === whynoteV2)![0];
    expect(anglesCall.prompt).not.toContain('PROFILE_SENTINEL');
    expect(questionCall.prompt).not.toContain('PROFILE_SENTINEL');
    expect(questionCall.prompt).not.toContain('track-record');
    expect(questionCall.prompt).toContain('Angle: limits-operations');
    expect(whyCall.prompt).toContain('PROFILE_SENTINEL');
    expect(whyCall.prompt).toContain('LESSON_PROFILE_SENTINEL');
    for (const call of run.mock.calls) expect(call[0].prompt).not.toContain('NEVER_SEND_SENTINEL');
    expect((await store.funnel()).map(event => event.event)).toEqual(expect.arrayContaining([
      'considered', 'picked', 'question', 'outbox',
    ]));
    expect(await store.decideOutbox(snapshot.outbox![0].id, 'approved')).toBe(true);
    expect(await store.setFeedback(snapshot.cards![0].id, 'useful')).toBe(true);
    await store.putNeverSend(['hosting']);
    const events = await store.funnel();
    expect(events.some(event => event.event === 'outbox' && event.reason === 'approved')).toBe(true);
    expect(events.some(event => event.event === 'outbox' && event.reason === 'withdrawn:listed-term')).toBe(true);
    expect(events.some(event => event.event === 'feedback' && event.reason === 'useful')).toBe(true);
    expect(JSON.stringify(events)).not.toContain('PROFILE_SENTINEL');
    expect(JSON.stringify(events)).not.toContain('NEVER_SEND_SENTINEL');
  } finally { scheduler.stop(); store.close(); }
});
it('gives a score-zero brief a filtered Outbox question but no why-note job', async () => {
  const store = await openLocalStore(`triage-brief-${crypto.randomUUID()}`);
  await store.putProfile({ id: 'deep', type: 'skill', depth: 'deep', text: 'Experienced', topics: ['hosting'],
    tags: [], updatedAt: 0 });
  await store.saveNotebook(paragraph, 0);
  const run = vi.fn(async (job: Job<unknown>) => {
    job.onDispatch?.();
    const data = job.instructions === anglesV2 ? { concerns: [{ item: 1, angle: 'end-user',
      concern: 'A concern', checkable: true }] } : job.instructions === questionV2
      ? { question: 'What are public hosting limits?', keptOut: [] } : { items: [item] };
    return { data, source: 'on_device', latencyMs: 1, raw: '{}' };
  });
  const service = { state: { kind: 'ready' }, subscribe: () => () => {}, runLocal: run } as unknown as LocalService;
  const scheduler = new Scheduler(store, service, () => 'extract.v2', () => {}, () => 10000);
  try {
    await scheduler.start(); await scheduler.tick(); await scheduler.tick(); await scheduler.tick();
    const snapshot = await store.snapshot();
    expect(snapshot.cards?.[0]).toMatchObject({ brief: true, score: 0, questionStatus: 'ready' });
    expect(snapshot.outbox?.[0].status).toBe('pending');
    expect(snapshot.jobs.some(job => job.step === 'whynote')).toBe(false);
    expect(run.mock.calls.some(call => call[0].instructions === whynoteV2)).toBe(false);
  } finally { scheduler.stop(); store.close(); }
});
it('uses S1-added terms to hold back a matching question on the normal scheduler path', async () => {
  const store = await openLocalStore(`triage-s1-${crypto.randomUUID()}`);
  const tokens = sessionForPlay('S1').privateTokens;
  const started = await prepareSessionStart('own', [], [], tokens, () => true, terms => store.putNeverSend(terms),
    records => store.replaceProfile(records));
  expect(started?.added).toContain(tokens[0]);
  await store.saveNotebook(paragraph, 0);
  const run = vi.fn(async (job: Job<unknown>) => {
    job.onDispatch?.();
    const data = job.instructions === anglesV2 ? { concerns: [{ item: 1, angle: 'end-user',
      concern: 'A concern', checkable: true }] } : job.instructions === questionV2
      ? { question: `What about ${tokens[0]}?`, keptOut: [] } : { items: [item] };
    return { data, source: 'on_device', latencyMs: 1, raw: '{}' };
  });
  const service = { state: { kind: 'ready' }, subscribe: () => () => {}, runLocal: run } as unknown as LocalService;
  const scheduler = new Scheduler(store, service, () => 'extract.v2', () => {}, () => 10000);
  try {
    await scheduler.start(); await scheduler.tick(); await scheduler.tick(); await scheduler.tick();
    const snapshot = await store.snapshot();
    expect(snapshot.cards?.[0]).toMatchObject({ questionStatus: 'blocked', questionReason: 'private detail' });
    expect(snapshot.outbox).toHaveLength(0);
  } finally { scheduler.stop(); store.close(); }
});
it('stops the worker on a cloud-sourced angles response', async () => {
  const store = await openLocalStore(`triage-source-${crypto.randomUUID()}`);
  await store.saveNotebook(paragraph, 0);
  const run = vi.fn(async (job: Job<unknown>) => {
    job.onDispatch?.();
    return { data: job.instructions === anglesV2 ? { concerns: [] } : { items: [item] },
      source: job.instructions === anglesV2 ? 'in_cloud' : 'on_device', latencyMs: 1, raw: '{}' };
  });
  const service = { state: { kind: 'ready' }, subscribe: () => () => {}, runLocal: run } as unknown as LocalService;
  const scheduler = new Scheduler(store, service, () => 'extract.v2', () => {}, () => 10000);
  try {
    await scheduler.start();
    await scheduler.tick();
    await scheduler.tick();
    expect(run).toHaveBeenCalledTimes(2);
    expect((await store.snapshot()).jobs.find(job => job.step === 'angles')?.status).toBe('failed');
    expect((await store.snapshot()).outbox).toHaveLength(0);
  } finally { scheduler.stop(); store.close(); }
});
it('blocks a question if the never-send list changes before the result commits', async () => {
  const store = await openLocalStore(`triage-race-${crypto.randomUUID()}`);
  await store.saveNotebook(paragraph, 0);
  let finish!: (value: typeof result) => void;
  const run = vi.fn(async (job: Job<unknown>) => {
    job.onDispatch?.();
    if (job.instructions === anglesV2) return { data: { concerns: [{ item: 1, angle: 'end-user',
      concern: 'A concern', checkable: true }] }, source: 'on_device', latencyMs: 1, raw: '{}' };
    if (job.instructions === questionV2) return new Promise<typeof result>(resolve => { finish = resolve; });
    return { data: { items: [item] }, source: 'on_device', latencyMs: 1, raw: '{}' };
  });
  const result = { data: { question: 'Does Acme Service have limits?', keptOut: [] },
    source: 'on_device', latencyMs: 1, raw: '{}' };
  const service = { state: { kind: 'ready' }, subscribe: () => () => {}, runLocal: run } as unknown as LocalService;
  const scheduler = new Scheduler(store, service, () => 'extract.v2', () => {}, () => 10000);
  try {
    await scheduler.start();
    await scheduler.tick();
    const pending = scheduler.tick();
    await vi.waitFor(() => expect(run.mock.calls.some(call => call[0].instructions === questionV2)).toBe(true));
    await store.putNeverSend(['Acme Service']);
    finish(result);
    await pending;
    const snapshot = await store.snapshot();
    expect(snapshot.outbox).toHaveLength(0);
    expect(snapshot.cards?.[0].questionStatus).toBe('blocked');
    expect((await store.funnel()).some(event => event.event === 'question' && event.reason === 'private detail'))
      .toBe(true);
  } finally { scheduler.stop(); store.close(); }
});
