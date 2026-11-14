import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';
import { LocalError, type Job } from '../ai/localModel';
import { anglesV2 } from '../pipeline/prompts/angles.v2';
import { questionV2 } from '../pipeline/prompts/question.v2';
import { whynoteV2 } from '../pipeline/prompts/whynote.v2';
import { openLocalStore } from './index';
import { Scheduler, type LocalService } from './scheduler';

const paragraph = 'The hosting service supports fifty users at once and provides a simple catalogue for visitors.';
const item = { kind: 'assumption', text: 'Fifty users', quote: 'The hosting service supports fifty users at once',
  topics: ['hosting'] };
const question = { question: 'What are hosting limits?', keptOut: [] };
const why = { seeing: 'You plan hosting.', why: 'Your experience is relevant.', used: [] };
const output = (data: unknown) => ({ data, source: 'on_device', latencyMs: 1, raw: '{}' });

it('ends a question after bounded failures without leaving an ownerless waiting card', async () => {
  const store = await openLocalStore(`retarget-failure-${crypto.randomUUID()}`);
  await store.saveNotebook(paragraph, 0);
  let now = 20000;
  const run = vi.fn(async (job: Job<unknown>) => {
    job.onDispatch?.();
    if (job.instructions === questionV2) throw new Error('Synthetic failure');
    if (job.instructions === anglesV2) return output({ concerns: [{ item: 1, angle: 'end-user',
      concern: 'Can we check this?', checkable: true }] });
    return output({ items: [item] });
  });
  const service = { state: { kind: 'ready' }, subscribe: () => () => {}, runLocal: run } as unknown as LocalService;
  const scheduler = new Scheduler(store, service, () => 'extract.v2', () => {}, () => now);
  try {
    await scheduler.start(); await scheduler.tick();
    for (let i = 0; i < 3; i++) { await scheduler.tick(); now += 30000; }
    const snapshot = await store.snapshot();
    expect(snapshot.cards?.[0]).toMatchObject({ questionStatus: 'blocked', questionReason: 'local-step-failed' });
    expect(snapshot.jobs.find(job => job.step === 'question')).toMatchObject({ status: 'failed', attempts: 3 });
  } finally { scheduler.stop(); store.close(); }
});
it('refunds an ordinary cancellation before dispatch when there is no retarget', async () => {
  const store = await openLocalStore(`cancel-before-dispatch-${crypto.randomUUID()}`);
  await store.saveNotebook(paragraph, 0);
  const run = vi.fn(async (job: Job<unknown>) => {
    if (job.instructions === questionV2) throw new LocalError('cancelled', 'Cancelled before dispatch.');
    job.onDispatch?.();
    if (job.instructions === anglesV2) return output({ concerns: [{ item: 1, angle: 'end-user',
      concern: 'Can we check this?', checkable: true }] });
    return output({ items: [item] });
  });
  const service = { state: { kind: 'ready' }, subscribe: () => () => {}, runLocal: run } as unknown as LocalService;
  const scheduler = new Scheduler(store, service, () => 'extract.v2', () => {}, () => 20000);
  try {
    await scheduler.start(); await scheduler.tick(); await scheduler.tick();
    expect((await store.snapshot()).jobs.find(job => job.step === 'question'))
      .toMatchObject({ status: 'pending', attempts: 0 });
  } finally { scheduler.stop(); store.close(); }
});
it('conservatively retains a claim made before dispatch when an edit retargets the question', async () => {
  const store = await openLocalStore(`retarget-before-dispatch-${crypto.randomUUID()}`);
  await store.saveNotebook(paragraph, 0);
  let continueInput!: () => void;
  let entered = false;
  const originalInput = store.questionInput.bind(store);
  vi.spyOn(store, 'questionInput').mockImplementationOnce(async job => {
    entered = true;
    await new Promise<void>(resolve => { continueInput = resolve; });
    return originalInput(job);
  });
  const run = vi.fn(async (job: Job<unknown>) => {
    job.onDispatch?.();
    if (job.instructions === anglesV2) return output({ concerns: [{ item: 1, angle: 'end-user',
      concern: 'Can we check this?', checkable: true }] });
    if (job.instructions === questionV2) return output(question);
    if (job.instructions === whynoteV2) return output(why);
    return output({ items: [item] });
  });
  const service = { state: { kind: 'ready' }, subscribe: () => () => {}, runLocal: run } as unknown as LocalService;
  const scheduler = new Scheduler(store, service, () => 'extract.v2', () => {}, () => 20000);
  try {
    await scheduler.start(); await scheduler.tick();
    const claimed = scheduler.tick();
    await vi.waitFor(() => expect(entered).toBe(true));
    expect(run.mock.calls.some(call => call[0].instructions === questionV2)).toBe(false);
    const before = await store.snapshot();
    const edited = `${paragraph} Extra context for testers.`;
    scheduler.edited(edited, before.paragraphs);
    await store.saveNotebook(edited, 10000);
    expect((await store.snapshot()).jobs.filter(job => job.step === 'question' && job.status === 'pending')[0].attempts)
      .toBe(1);
    scheduler.saved(); continueInput(); await claimed;
    for (let i = 0; i < 8; i++) await scheduler.tick();
    const snapshot = await store.snapshot();
    expect(snapshot.cards?.[0].questionStatus).toBe('ready');
    expect(snapshot.jobs.filter(job => job.step === 'question').every(job => job.attempts <= 3)).toBe(true);
    expect(snapshot.jobs.some(job => job.step === 'question' && job.status === 'done' && job.attempts === 2))
      .toBe(true);
  } finally { scheduler.stop(); store.close(); }
});
for (const waitingFor of ['question', 'whynote'] as const) {
  it(`retargets a dispatched ${waitingFor} after an unrelated edit without accepting its late result`, async () => {
    const name = `retarget-${crypto.randomUUID()}`;
    let store = await openLocalStore(name);
    await store.saveNotebook(paragraph, 0);
    let finish!: (value: ReturnType<typeof output>) => void;
    let held = false;
    const run = vi.fn(async (job: Job<unknown>) => {
      job.onDispatch?.();
      const target = waitingFor === 'question' ? questionV2 : whynoteV2;
      if (job.instructions === target && !held) {
        held = true;
        return new Promise<ReturnType<typeof output>>(resolve => { finish = resolve; });
      }
      if (job.instructions === anglesV2) return output({ concerns: [{ item: 1, angle: 'end-user',
        concern: 'Can we check this?', checkable: true }] });
      if (job.instructions === questionV2) return output(question);
      if (job.instructions === whynoteV2) return output(why);
      return output({ items: [item] });
    });
    const service = { state: { kind: 'ready' }, subscribe: () => () => {}, runLocal: run } as unknown as LocalService;
    let scheduler = new Scheduler(store, service, () => 'extract.v2', () => {}, () => 20000);
    try {
      await scheduler.start();
      await scheduler.tick();
      if (waitingFor === 'whynote') await scheduler.tick();
      const inflight = scheduler.tick();
      await vi.waitFor(() => expect(held).toBe(true));
      const before = await store.snapshot();
      const originalCard = before.cards![0];
      const edited = `${paragraph} Extra context for testers.`;
      scheduler.edited(edited, before.paragraphs);
      await store.saveNotebook(edited, 10000);
      scheduler.saved();
      let snapshot = await store.snapshot();
      expect(snapshot.jobs.some(job => job.cardId === originalCard.id && job.step === waitingFor &&
        job.status === 'pending' && job.attempts === 1)).toBe(true);
      finish(output(waitingFor === 'question' ? { ...question, question: 'Late obsolete question?' } :
        { ...why, why: 'Late obsolete note.' }));
      await inflight;
      scheduler.stop();
      store.close();
      store = await openLocalStore(name);
      scheduler = new Scheduler(store, service, () => 'extract.v2', () => {}, () => 20000);
      await scheduler.start();
      for (let i = 0; i < 8; i++) await scheduler.tick();
      snapshot = await store.snapshot();
      const card = snapshot.cards!.find(value => value.id === originalCard.id)!;
      expect(card.questionStatus).toBe('ready');
      expect(card.why?.why).toBe(why.why);
      expect(snapshot.outbox!.find(value => value.cardId === card.id)?.question).toBe(question.question);
      expect(snapshot.cards!.filter(value => value.id === card.id)).toHaveLength(1);
      expect(snapshot.jobs.some(job => job.cardId === card.id && job.step === waitingFor &&
        job.status === 'done' && job.attempts === 2)).toBe(true);
      expect(snapshot.cards!.every(value => value.questionStatus !== 'waiting' || snapshot.jobs.some(job =>
        job.cardId === value.id && job.step === 'question' && ['pending', 'running'].includes(job.status)))).toBe(true);
    } finally { scheduler.stop(); store.close(); }
  });
}
