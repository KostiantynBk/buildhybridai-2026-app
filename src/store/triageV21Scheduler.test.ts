import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { expect, it, vi } from 'vitest';
import type { Job } from '../ai/localModel';
import { anglesV21 } from '../pipeline/prompts/angles.v2.1';
import { questionV21 } from '../pipeline/prompts/question.v2.1';
import { whynoteV1 } from '../pipeline/prompts/whynote.v1';
import { whynoteV2 } from '../pipeline/prompts/whynote.v2';
import { anglesV2 } from '../pipeline/prompts/angles.v2';
import { questionV2 } from '../pipeline/prompts/question.v2';
import { anglesV1 } from '../pipeline/prompts/angles.v1';
import { questionV1 } from '../pipeline/prompts/question.v1';
import { openLocalStore } from './index';
import { Scheduler, type LocalService } from './scheduler';

it.each(['v1', 'v2'] as const)('keeps a previously queued %s job pinned including its why-note', async version => {
  const name = `triage-${version}-pinned-${crypto.randomUUID()}`;
  const anglesPrompt = version === 'v1' ? anglesV1 : anglesV2;
  const questionPrompt = version === 'v1' ? questionV1 : questionV2;
  const whyPrompt = version === 'v1' ? whynoteV1 : whynoteV2;
  const store = await openLocalStore(name);
  const paragraph = 'The hosted service supports fifty visitors at once and provides a simple early catalogue.';
  const quote = 'The hosted service supports fifty visitors at once';
  await store.saveNotebook(paragraph, 0); await store.enqueueSettled(4000, 'extract.v2');
  const extract = await store.claim(4000);
  if (!extract) throw new Error('Expected extraction');
  await store.complete(extract.job, [{ kind: 'assumption', text: 'Fifty visitors', quote, topics: ['hosting'] }], 4000);
  await store.finalizeReady();
  const p = (await store.snapshot()).paragraphs[0];
  const db = await openDB(name, 4);
  try {
    await db.put('jobs', { key: `${p.id}@${p.version}#angles`, paragraphId: p.id, paragraphVersion: p.version,
      step: 'angles', promptVersion: `angles.${version}`, status: 'pending', attempts: 0,
      createdAt: 4000, nextRunAt: 4000 });
  } finally { db.close(); }
  const run = vi.fn(async (job: Job<unknown>) => {
    job.onDispatch?.();
    const data = job.instructions === anglesPrompt ? { concerns: [{ item: 1, angle: 'end-user',
      concern: 'Short v2', checkable: true }] } : job.instructions === questionPrompt
      ? { question: 'What are public hosting limits?', keptOut: [] }
      : { seeing: 'You are planning hosting.', why: 'It matters.', used: [] };
    return { data, source: 'on_device', latencyMs: 1, raw: '{}' };
  });
  const service = { state: { kind: 'ready' }, subscribe: () => () => {}, runLocal: run } as unknown as LocalService;
  const scheduler = new Scheduler(store, service, () => 'extract.v2', () => {}, () => 20000);
  try {
    await scheduler.start(); await scheduler.tick(); await scheduler.tick();
    expect((await store.snapshot()).cards![0]).toMatchObject({ triageVersion: version,
      why: { seeing: expect.any(String) } });
    expect(run.mock.calls.some(call => call[0].instructions === anglesPrompt)).toBe(true);
    expect(run.mock.calls.some(call => call[0].instructions === questionPrompt)).toBe(true);
    expect(run.mock.calls.some(call => call[0].instructions === whyPrompt)).toBe(true);
  } finally { scheduler.stop(); store.close(); }
});
it('preserves terminal revalidation behavior for v2.1 question work', async () => {
  const store = await openLocalStore(`triage-v21-terminal-${crypto.randomUUID()}`);
  const paragraph = 'The hosted service supports fifty visitors at once and provides a simple early catalogue.';
  const quote = 'The hosted service supports fifty visitors at once';
  await store.saveNotebook(paragraph, 0);
  let now = 20000;
  let failExtract = false;
  let finish!: (value: { data: unknown; source: string; latencyMs: number; raw: string }) => void;
  const run = vi.fn(async (job: Job<unknown>) => {
    job.onDispatch?.();
    if (job.instructions === anglesV21) return { data: { concerns: [{ item: 1, angle: 'end-user',
      concern: 'Can customers reach this hosting service reliably?', checkable: true }] },
    source: 'on_device', latencyMs: 1, raw: '{}' };
    if (job.instructions === questionV21) return new Promise<{
      data: unknown; source: string; latencyMs: number; raw: string }>(resolve => { finish = resolve; });
    if (failExtract) throw new Error('Synthetic extraction failure');
    return { data: { items: [{ kind: 'assumption', text: 'Fifty visitors', quote, topics: ['hosting'] }] },
      source: 'on_device', latencyMs: 1, raw: '{}' };
  });
  const service = { state: { kind: 'ready' }, subscribe: () => () => {}, runLocal: run } as unknown as LocalService;
  const scheduler = new Scheduler(store, service, () => 'extract.v2', () => {}, () => now);
  try {
    await scheduler.start(); await scheduler.tick();
    const inflight = scheduler.tick();
    await vi.waitFor(() => expect(finish).toBeDefined());
    const before = await store.snapshot();
    const edited = `${paragraph} A friend will help.`;
    scheduler.edited(edited, before.paragraphs); now += 10000;
    await store.saveNotebook(edited, now - 5000); failExtract = true; scheduler.saved();
    finish({ data: { question: 'What are the hosting limits?', keptOut: [] },
      source: 'on_device', latencyMs: 1, raw: '{}' });
    await inflight;
    for (let attempt = 1; attempt <= 3; attempt++) {
      await vi.waitFor(async () => {
        await scheduler.tick();
        const state = await store.snapshot();
        const job = state.jobs.find(value => value.step === 'extract' &&
          value.paragraphVersion === state.paragraphs[0].version);
        expect(job?.attempts).toBeGreaterThanOrEqual(attempt);
        expect(job?.status).toBe(attempt === 3 ? 'failed' : 'pending');
      }, { timeout: 5000 });
      now += 30000;
    }
    const after = await store.snapshot();
    expect(after.cards![0]).toMatchObject({ questionStatus: 'blocked', questionReason: 'revalidation-failed',
      recheckFailedVersion: after.paragraphs[0].version });
    expect(after.jobs.some(job => job.step === 'whynote')).toBe(false);
  } finally { scheduler.stop(); store.close(); }
}, 15000);
it('completes a v2.1 local pipeline without a why-note call or profile in any prompt', async () => {
  const store = await openLocalStore(`triage-v21-${crypto.randomUUID()}`);
  const paragraph = 'The hosted service supports fifty visitors at once and provides a simple early catalogue.';
  const quote = 'The hosted service supports fifty visitors at once';
  await store.putProfile({ id: 's', type: 'skill', depth: 'new', text: 'PROFILE_SENTINEL', topics: ['hosting'],
    tags: [], updatedAt: 0 });
  await store.putProfile({ id: 'lesson', type: 'lesson', text: 'LESSON_SENTINEL', topics: ['hosting'],
    tags: [], updatedAt: 0 });
  await store.putNeverSend(['LIST_SENTINEL']);
  await store.saveNotebook(paragraph, 0);
  const run = vi.fn(async (job: Job<unknown>) => {
    job.onDispatch?.();
    const data = job.instructions === anglesV21 ? { concerns: [
      { item: 1, angle: 'end-user', concern: 'The', checkable: true },
      { item: 1, angle: 'limits-operations', concern: 'Are there public limits on hosted visitors?', checkable: true },
    ] } : job.instructions === questionV21 ? { question: 'What are the public hosting limits?', keptOut: [] }
      : { items: [{ kind: 'assumption', text: 'Fifty visitors', quote, topics: ['hosting'] }] };
    return { data, source: 'on_device', latencyMs: 1, raw: '{}' };
  });
  const service = { state: { kind: 'ready' }, subscribe: () => () => {}, runLocal: run } as unknown as LocalService;
  const scheduler = new Scheduler(store, service, () => 'extract.v2', () => {}, () => 20000);
  try {
    await scheduler.start(); for (let i = 0; i < 6; i++) await scheduler.tick();
    const snapshot = await store.snapshot();
    expect(snapshot.cards).toHaveLength(1);
    expect(snapshot.cards![0]).toMatchObject({ triageVersion: 'v2.1', questionStatus: 'ready',
      profileRecordIds: ['lesson', 's'] });
    expect(snapshot.jobs.some(job => job.step === 'whynote')).toBe(false);
    expect(run.mock.calls.some(call => call[0].instructions === whynoteV1 ||
      call[0].instructions === whynoteV2)).toBe(false);
    const events = await store.funnel();
    expect(events.some(event => event.reason === 'held back: incomplete')).toBe(true);
    expect(events.every(event => event.promptVersions?.angles === 'angles.v2.1' &&
      event.promptVersions.question === 'question.v2.1' && event.promptVersions.whynote === null)).toBe(true);
    for (const [job] of run.mock.calls) {
      expect(job.prompt).not.toContain('PROFILE_SENTINEL');
      expect(job.prompt).not.toContain('LESSON_SENTINEL');
      expect(job.prompt).not.toContain('LIST_SENTINEL');
    }
    expect(JSON.stringify(snapshot.outbox)).not.toContain('PROFILE_SENTINEL');
    await store.putProfile({ id: 's', type: 'skill', depth: 'some', text: 'Updated profile record', topics: ['hosting'],
      tags: [], updatedAt: 1 });
    expect((await store.snapshot()).jobs.some(job => job.step === 'whynote')).toBe(false);
    await store.deleteProfile('s');
    expect((await store.snapshot()).jobs.some(job => job.step === 'whynote')).toBe(false);
  } finally { scheduler.stop(); store.close(); }
});
