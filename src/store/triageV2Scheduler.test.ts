import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { expect, it, vi } from 'vitest';
// This regression explicitly exercises the pinned v2 path.
vi.mock('../pipeline/triageVersion', async importOriginal => ({
  ...(await importOriginal<typeof import('../pipeline/triageVersion')>()), TRIAGE_PROMPT_SET: 'v2',
}));

import type { Job } from '../ai/localModel';
import { anglesV2 } from '../pipeline/prompts/angles.v2';
import { questionV21 as questionV2 } from '../pipeline/prompts/question.v2.1';
import { whynoteV2 } from '../pipeline/prompts/whynote.v2';
import { anglesV1 } from '../pipeline/prompts/angles.v1';
import { questionV1 } from '../pipeline/prompts/question.v1';
import { whynoteV1 } from '../pipeline/prompts/whynote.v1';
import { openLocalStore } from './index';
import { Scheduler, type LocalService } from './scheduler';

it('preserves the prompt versions of a previously queued v1 angles job', async () => {
  const name = `triage-legacy-${crypto.randomUUID()}`;
  const store = await openLocalStore(name);
  const text = 'The hosted service supports fifty visitors at once and provides a simple early catalogue.';
  const quote = 'The hosted service supports fifty visitors at once';
  await store.saveNotebook(text, 0);
  await store.enqueueSettled(4000, 'extract.v2');
  const extract = await store.claim(4000);
  if (!extract) throw new Error('Expected extraction');
  await store.complete(extract.job, [{ kind: 'assumption', text: 'Fifty visitors', quote, topics: ['hosting'] }], 4000);
  await store.finalizeReady();
  const paragraph = (await store.snapshot()).paragraphs[0];
  const db = await openDB(name, 6);
  try {
    await db.put('jobs', { key: `${paragraph.id}@${paragraph.version}#angles`, paragraphId: paragraph.id,
      paragraphVersion: paragraph.version, step: 'angles', promptVersion: 'angles.v1', status: 'pending',
      attempts: 0, createdAt: 4000, nextRunAt: 4000 });
  } finally { db.close(); }
  const run = vi.fn(async (job: Job<unknown>) => {
    job.onDispatch?.();
    const data = job.instructions === anglesV1 ? { concerns: [{ item: 1, angle: 'end-user',
      concern: 'What are the limits?', checkable: true }] } : job.instructions === questionV1
      ? { question: 'What are the public limits?', keptOut: [] }
      : { seeing: 'You are planning hosting.', why: 'You have not done this.', used: [] };
    return { data, source: 'on_device', latencyMs: 1, raw: '{}' };
  });
  const service = { state: { kind: 'ready' }, subscribe: () => () => {}, runLocal: run } as unknown as LocalService;
  const scheduler = new Scheduler(store, service, () => 'extract.v2', () => {}, () => 20000);
  try {
    await scheduler.start(); await scheduler.tick(); await scheduler.tick();
    const card = (await store.snapshot()).cards![0];
    expect(card.triageVersion).toBe('v1');
    expect(card.questionStatus).toBe('marked');
    expect(run.mock.calls.some(call => call[0].instructions === anglesV1)).toBe(true);
    expect(run.mock.calls.some(call => call[0].instructions === questionV1)).toBe(false);
    expect(run.mock.calls.some(call => call[0].instructions === whynoteV1)).toBe(false);
    expect((await store.funnel()).every(event => event.promptVersions?.angles === 'angles.v1')).toBe(true);
  } finally { scheduler.stop(); store.close(); }
});
it('leaves v1 open questions unconsidered until the next edit, then sends them to v2', async () => {
  const name = `triage-open-after-v1-${crypto.randomUUID()}`;
  const store = await openLocalStore(name);
  const text = 'The hosted service supports fifty visitors at once and provides a simple early catalogue. ' +
    'Can customers receive refunds after cancelling their booking?';
  const items = [{ kind: 'assumption', text: 'Fifty visitors',
    quote: 'The hosted service supports fifty visitors at once', topics: ['hosting'] },
  { kind: 'open-question', text: 'Can customers receive refunds?',
    quote: 'Can customers receive refunds after cancelling their booking?', topics: ['payments'] }];
  await store.saveNotebook(text, 0); await store.enqueueSettled(4000, 'extract.v2');
  const extract = await store.claim(4000);
  if (!extract) throw new Error('Expected extraction');
  await store.complete(extract.job, items, 4000); await store.finalizeReady();
  let snapshot = await store.snapshot();
  const paragraph = snapshot.paragraphs[0];
  const db = await openDB(name, 6);
  try {
    await db.put('jobs', { key: `${paragraph.id}@${paragraph.version}#angles`, paragraphId: paragraph.id,
      paragraphVersion: paragraph.version, step: 'angles', promptVersion: 'angles.v1', status: 'pending',
      attempts: 0, createdAt: 4000, nextRunAt: 4000 });
  } finally { db.close(); }
  let now = 20000;
  const run = vi.fn(async (job: Job<unknown>) => {
    job.onDispatch?.();
    const data = job.instructions === anglesV1 || job.instructions === anglesV2 ? { concerns: [] } : { items };
    return { data, source: 'on_device', latencyMs: 1, raw: '{}' };
  });
  const service = { state: { kind: 'ready' }, subscribe: () => () => {}, runLocal: run } as unknown as LocalService;
  const scheduler = new Scheduler(store, service, () => 'extract.v2', () => {}, () => now);
  try {
    await scheduler.start();
    snapshot = await store.snapshot();
    const openLineage = snapshot.items.find(item => item.kind === 'open-question')!.lineageId!;
    const assumptionLineage = snapshot.items.find(item => item.kind === 'assumption')!.lineageId!;
    const raw = await openDB(name, 6);
    try {
      expect(await raw.get('anglesConsidered', [assumptionLineage, 1])).toBeDefined();
      expect(await raw.get('anglesConsidered', [openLineage, 1])).toBeUndefined();
    } finally { raw.close(); }
    expect(run.mock.calls.filter(call => call[0].instructions === anglesV2)).toHaveLength(0);
    const edited = `${text} A friend will help.`;
    now += 10000; scheduler.edited(edited, snapshot.paragraphs);
    await store.saveNotebook(edited, now - 5000); scheduler.saved();
    await vi.waitFor(async () => {
      await scheduler.tick();
      expect(run.mock.calls.filter(call => call[0].instructions === anglesV2)).toHaveLength(1);
    }, { timeout: 5000 });
    const prompt = run.mock.calls.find(call => call[0].instructions === anglesV2)![0].prompt;
    const statements = prompt.split('Statements:\n')[1];
    expect(statements).toContain('(open-question) Can customers receive refunds?');
    expect(statements).not.toContain('(assumption) Fifty visitors');
  } finally { scheduler.stop(); store.close(); }
});
it('uses v2 for open questions, holds decision alternatives and logs an unsupported why claim', async () => {
  const store = await openLocalStore(`triage-v2-${crypto.randomUUID()}`);
  const paragraph = 'I have decided to use Stripe Checkout for all payments. ' +
    'I do not know whether customers can get refunds after making their booking.';
  await store.putProfile({ id: 'p', type: 'skill', depth: 'new', text: 'PROFILE_SENTINEL payment experience',
    topics: ['payments'], tags: [], updatedAt: 0 });
  await store.putNeverSend(['LIST_SENTINEL']);
  await store.saveNotebook(paragraph, 0);
  const run = vi.fn(async (job: Job<unknown>) => {
    job.onDispatch?.();
    const data = job.instructions === anglesV2 ? { concerns: [
      { item: 1, angle: 'alternatives', concern: 'Try a different option?', checkable: true },
      { item: 2, angle: 'end-user', concern: 'What refund rules apply?', checkable: true },
      { item: 1, angle: 'limits-operations', concern: 'What are its limits?', checkable: true },
    ] } : job.instructions === questionV2 ? { question: 'What refund rules apply?', keptOut: [] }
      : job.instructions === whynoteV2 ? { seeing: 'You are planning payments.',
        why: 'You have not handled refunds before.', used: ['p'] } : { items: [
        { kind: 'decision', text: 'Use Stripe Checkout',
          quote: 'I have decided to use Stripe Checkout for all payments',
          topics: ['payments'] },
        { kind: 'open-question', text: 'Can customers get refunds?',
          quote: 'I do not know whether customers can get refunds after making their booking', topics: ['payments'] },
      ] };
    return { data, source: 'on_device', latencyMs: 1, raw: '{}' };
  });
  const service = { state: { kind: 'ready' }, subscribe: () => () => {}, runLocal: run } as unknown as LocalService;
  const scheduler = new Scheduler(store, service, () => 'extract.v2', () => {}, () => 20000);
  try {
    await scheduler.start(); await scheduler.tick();
    const marks = await store.snapshot();
    for (const card of marks.cards ?? []) {
      const item = marks.items.find(value => value.lineageId === card.itemLineageId)!;
      await store.requestCheck(item.id, 0);
    }
    for (let i = 0; i < 8; i++) await scheduler.tick();
    const snapshot = await store.snapshot();
    expect(snapshot.cards).toHaveLength(2);
    expect(snapshot.cards!.some(card => card.itemKind === 'open-question')).toBe(true);
    expect(snapshot.cards!.every(card => card.triageVersion === 'v2')).toBe(true);
    expect(snapshot.cards!.every(card => card.why?.seeing && card.why.why === '' && card.why.used.includes('p')))
      .toBe(true);
    const events = await store.funnel();
    expect(events.some(event => event.reason === 'held back: decision respected')).toBe(true);
    expect(events.filter(event => event.reason === 'why dropped: unsupported claim')).toHaveLength(2);
    expect(events.every(event => event.promptVersions?.angles === 'angles.v2' &&
      event.promptVersions.whynote === 'whynote.v2')).toBe(true);
    expect(events.filter(event => event.event === 'question').every(event =>
      event.promptVersions?.question === 'question.v2.1')).toBe(true);
    const anglesCall = run.mock.calls.find(call => call[0].instructions === anglesV2)![0];
    expect(anglesCall.prompt).toContain('(open-question) Can customers get refunds?');
    for (const [job] of run.mock.calls) {
      expect(job.prompt).not.toContain('LIST_SENTINEL');
      if (job.instructions === whynoteV2) {
        expect(job.prompt).toContain('PROFILE_SENTINEL');
        expect(job.prompt).toContain('Kind: ');
      } else expect(job.prompt).not.toContain('PROFILE_SENTINEL');
    }
    expect(JSON.stringify(snapshot.outbox)).not.toContain('PROFILE_SENTINEL');
  } finally { scheduler.stop(); store.close(); }
});
