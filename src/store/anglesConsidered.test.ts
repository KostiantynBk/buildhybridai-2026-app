import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { expect, it, vi } from 'vitest';
import type { Job } from '../ai/localModel';
import { anglesV1 } from '../pipeline/prompts/angles.v1';
import { compareV1 } from '../pipeline/prompts/compare.v1';
import { questionV1 } from '../pipeline/prompts/question.v1';
import { whynoteV1 } from '../pipeline/prompts/whynote.v1';
import { openLocalStore } from './index';
import { Scheduler, type LocalService } from './scheduler';

const base = "I'll host it on one cheap VPS because traffic will be tiny, about 50 bookings a month. " +
  'Payments go through Stripe Checkout. My friend Marta will help. People will share links on forums.';
const whole = "I'll host it on one cheap VPS because traffic will be tiny, about 50 bookings a month";
const stripe = 'Payments go through Stripe Checkout';
const host = "I'll host it on one cheap VPS";
const traffic = 'traffic will be tiny, about 50 bookings a month';
const forum = 'People will share links on forums';
const line = (text: string, quote: string, topics = ['hosting']) => ({ kind: 'assumption', text, quote, topics });
const result = (data: unknown) => ({ data, source: 'on_device', latencyMs: 1, raw: '{}' });

it('rolls back considered pairs when angles adoption fails', async () => {
  const name = `angles-atomic-${crypto.randomUUID()}`;
  const store = await openLocalStore(name);
  await store.saveNotebook(base, 0);
  await store.enqueueSettled(4000, 'extract.v2');
  const extract = await store.claim(4000);
  if (!extract) throw new Error('Expected extraction');
  await store.complete(extract.job, [line('VPS hosting and traffic', whole)], 4000);
  await store.finalizeReady(); await store.enqueueAngles(4000);
  const angles = await store.claim(4000);
  if (!angles) throw new Error('Expected angles job');
  const input = await store.anglesInput(angles.job);
  if (!input) throw new Error('Expected eligible angles input');
  const originalPut = IDBObjectStore.prototype.put;
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
    if (this.name === 'anglesConsidered') {
      this.transaction.abort();
      throw new DOMException('Synthetic adoption abort', 'AbortError');
    }
    return key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
  });
  try {
    await expect(store.completeAngles(angles.job, input, [], 'test-session', 4000)).rejects.toBeDefined();
    spy.mockRestore();
    const raw = await openDB(name, 4);
    try { expect(await raw.count('anglesConsidered')).toBe(0); } finally { raw.close(); }
    expect((await store.snapshot()).jobs.find(job => job.key === angles.job.key)?.status).toBe('running');
    expect(await store.completeAngles(angles.job, input, [], 'test-session', 4000)).toBe(true);
  } finally { spy.mockRestore(); store.close(); }
});
it('skips angles entirely on an edit with no newly eligible lineage versions', async () => {
  const name = `angles-unchanged-${crypto.randomUUID()}`;
  const store = await openLocalStore(name);
  await store.saveNotebook(base, 0);
  let now = 20000;
  const run = vi.fn(async (job: Job<unknown>) => {
    job.onDispatch?.();
    if (job.instructions === anglesV1) return result({ concerns: [] });
    return result({ items: [line('VPS hosting and traffic', whole), line('Stripe', stripe, ['payments'])] });
  });
  const service = { state: { kind: 'ready' }, subscribe: () => () => {}, runLocal: run } as unknown as LocalService;
  const scheduler = new Scheduler(store, service, () => 'extract.v2', () => {}, () => now);
  try {
    await scheduler.start(); await scheduler.tick();
    expect(run.mock.calls.filter(call => call[0].instructions === anglesV1)).toHaveLength(1);
    const before = await store.snapshot();
    const edited = base.replace('My friend Marta', 'My friend Marta and her sister');
    now += 10000; scheduler.edited(edited, before.paragraphs);
    await store.saveNotebook(edited, now - 5000); scheduler.saved();
    await vi.waitFor(async () => {
      await scheduler.tick();
      const snapshot = await store.snapshot();
      const current = snapshot.paragraphs[0];
      expect(snapshot.jobs.some(job => job.step === 'extract' && job.paragraphVersion === current.version &&
        job.status === 'done')).toBe(true);
      expect(snapshot.lineages?.every(lineage => lineage.paragraphVersion === current.version)).toBe(true);
    }, { timeout: 5000 });
    for (let i = 0; i < 2; i++) await scheduler.tick();
    expect(run.mock.calls.filter(call => call[0].instructions === anglesV1)).toHaveLength(1);
    const raw = await openDB(name, 4);
    try { expect(await raw.count('anglesConsidered')).toBe(2); } finally { raw.close(); }
    const snapshot = await store.snapshot();
    expect(snapshot.jobs.some(job => job.step === 'angles' &&
      job.paragraphVersion === snapshot.paragraphs[0].version)).toBe(false);
    await store.clearAll({ getItem: () => null, removeItem: () => {} });
    const cleared = await openDB(name, 4);
    try { expect(await cleared.count('anglesConsidered')).toBe(0); } finally { cleared.close(); }
  } finally { scheduler.stop(); store.close(); }
});
it('retries an unadopted failed angles input on the next edit', async () => {
  const store = await openLocalStore(`angles-failed-${crypto.randomUUID()}`);
  await store.saveNotebook(base, 0);
  let now = 20000;
  let failing = true;
  const run = vi.fn(async (job: Job<unknown>) => {
    job.onDispatch?.();
    if (job.instructions === anglesV1) {
      if (failing) throw new Error('Synthetic failure');
      return result({ concerns: [] });
    }
    return result({ items: [line('VPS hosting and traffic', whole)] });
  });
  const service = { state: { kind: 'ready' }, subscribe: () => () => {}, runLocal: run } as unknown as LocalService;
  const scheduler = new Scheduler(store, service, () => 'extract.v2', () => {}, () => now);
  try {
    await scheduler.start();
    for (let i = 0; i < 3; i++) { await scheduler.tick(); now += 30000; }
    expect((await store.snapshot()).jobs.find(job => job.step === 'angles')).toMatchObject({ status: 'failed' });
    const before = await store.snapshot();
    const edited = base.replace('My friend Marta', 'My friend Marta and her sister');
    failing = false; now += 10000; scheduler.edited(edited, before.paragraphs);
    await store.saveNotebook(edited, now - 5000); scheduler.saved();
    await vi.waitFor(async () => {
      await scheduler.tick();
      const snapshot = await store.snapshot();
      expect(snapshot.jobs.some(job => job.step === 'angles' && job.status === 'done' &&
        job.paragraphVersion === snapshot.paragraphs[0].version)).toBe(true);
    }, { timeout: 5000 });
    expect(run.mock.calls.filter(call => call[0].instructions === anglesV1)).toHaveLength(4);
  } finally { scheduler.stop(); store.close(); }
});
it('considers a changed lineage version again and permits a new non-stale card', async () => {
  const store = await openLocalStore(`angles-changed-${crypto.randomUUID()}`);
  await store.saveNotebook(base, 0);
  let now = 20000;
  let changed = false;
  const newQuote = 'traffic will be tiny';
  const run = vi.fn(async (job: Job<unknown>) => {
    job.onDispatch?.();
    if (job.instructions === anglesV1) return result({ concerns: [{ item: 1, angle: 'end-user',
      concern: 'What about traffic?', checkable: true }] });
    if (job.instructions === compareV1) return result({ status: 'changed', newQuote });
    if (job.instructions === questionV1) return result({ question: 'What are public traffic limits?', keptOut: [] });
    if (job.instructions === whynoteV1) return result({ seeing: 'You are planning.', why: 'Relevant.', used: [] });
    return result({ items: [line('Traffic estimate', changed ? newQuote : traffic)] });
  });
  const service = { state: { kind: 'ready' }, subscribe: () => () => {}, runLocal: run } as unknown as LocalService;
  const scheduler = new Scheduler(store, service, () => 'extract.v2', () => {}, () => now);
  try {
    await scheduler.start();
    for (let i = 0; i < 4; i++) await scheduler.tick();
    const before = await store.snapshot();
    expect(before.cards).toHaveLength(1);
    const original = before.cards![0];
    const edited = base.replace('50 bookings', '500 bookings');
    changed = true; now += 10000; scheduler.edited(edited, before.paragraphs);
    await store.saveNotebook(edited, now - 5000); scheduler.saved();
    await vi.waitFor(async () => {
      await scheduler.tick();
      const snapshot = await store.snapshot();
      expect(snapshot.cards).toHaveLength(2);
    }, { timeout: 5000 });
    const after = await store.snapshot();
    expect(after.cards!.find(card => card.id !== original.id)).toMatchObject({
      itemLineageId: original.itemLineageId, itemVersion: original.itemVersion + 1,
    });
    expect(run.mock.calls.filter(call => call[0].instructions === anglesV1)).toHaveLength(2);
  } finally { scheduler.stop(); store.close(); }
});
for (const { addUnrelated, decision } of [
  { addUnrelated: false, decision: 'approved' as const },
  { addUnrelated: true, decision: 'approved' as const },
  { addUnrelated: false, decision: 'rejected' as const },
  { addUnrelated: false, decision: 'blocked' as const },
]) {
  it(`handles the Marta edit with a ${decision} question${addUnrelated ? ' and unrelated item' : ''}`, async () => {
    const store = await openLocalStore(`angles-split-${crypto.randomUUID()}`);
    await store.putProfile({ id: 'hosting-lesson', type: 'lesson', text: 'A hosting lesson', topics: ['hosting'],
      tags: [], updatedAt: 0 });
    await store.saveNotebook(base, 0);
    let split = false;
    let now = 20000;
    const run = vi.fn(async (job: Job<unknown>) => {
      job.onDispatch?.();
      if (job.instructions === anglesV1) {
        const count = (job.prompt.split('Statements:\n')[1].match(/^\d+\. \(/gm) ?? []).length;
        return result({ concerns: Array.from({ length: count }, (_, index) => ({ item: index + 1,
          angle: split && index === 1 ? 'alternatives' : index === 0 ? 'end-user' : 'security-privacy',
          concern: `Concern ${index + 1}`, checkable: true })) });
      }
      if (job.instructions === questionV1) return result({
        question: decision === 'blocked' && job.prompt.includes('VPS hosting and traffic')
          ? 'What about person@example.com?' : 'What are public service limits?', keptOut: [] });
      if (job.instructions === whynoteV1) return result({ seeing: 'You are planning.', why: 'Relevant.', used: [] });
      if (job.instructions === compareV1) return result({ status: 'unchanged', newQuote: '' });
      return result({ items: split ? [line('VPS hosting', host), line('Low traffic', traffic),
        line('Stripe Checkout', stripe, ['payments']), ...(addUnrelated ? [line('Forum sharing', forum, ['marketing'])]
          : [])] : [line('VPS hosting and traffic', whole), line('Stripe Checkout', stripe, ['payments'])] });
    });
    const service = { state: { kind: 'ready' }, subscribe: () => () => {}, runLocal: run } as unknown as LocalService;
    const scheduler = new Scheduler(store, service, () => 'extract.v2', () => {}, () => now);
    try {
      await scheduler.start();
      for (let i = 0; i < 8; i++) await scheduler.tick();
      let snapshot = await store.snapshot();
      expect(snapshot.cards).toHaveLength(2);
      const original = [...snapshot.cards!];
      const hostingCard = original.find(card => card.topics.includes('hosting'))!;
      const entryId = snapshot.outbox!.find(entry => entry.cardId === hostingCard.id)?.id;
      if (decision === 'blocked') expect(hostingCard.questionStatus).toBe('blocked');
      else {
        expect(entryId).toBeDefined();
        expect(await store.decideOutbox(entryId!, decision)).toBe(true);
      }
      const prior = snapshot.paragraphs;
      const edited = base.replace('my friend Marta', 'my friend Marta and her sister')
        .replace('My friend Marta', 'My friend Marta and her sister');
      split = true;
      scheduler.edited(edited, prior); now += 10000;
      await store.saveNotebook(edited, now - 5000); scheduler.saved();
      await vi.waitFor(async () => {
        await scheduler.tick();
        const calls = run.mock.calls.filter(call => call[0].instructions === anglesV1);
        expect(calls.length).toBe(2);
      }, { timeout: 5000 });
      for (let i = 0; i < 6; i++) { await scheduler.tick(); await new Promise(resolve => setTimeout(resolve, 0)); }
      snapshot = await store.snapshot();
      const call = run.mock.calls.filter(value => value[0].instructions === anglesV1)[1][0];
      expect(call.prompt).toContain(edited);
      const statements = call.prompt.split('Statements:\n')[1];
      const unchanged = snapshot.items.filter(value => value.status === 'current' &&
        original.some(card => card.itemLineageId === value.lineageId));
      for (const item of unchanged) expect(statements).not.toContain(item.text);
      expect((statements.match(/^\d+\. \(/gm) ?? []).length).toBe(addUnrelated ? 2 : 1);
      expect(snapshot.cards).toHaveLength(addUnrelated ? 3 : 2);
      if (addUnrelated) {
        expect(snapshot.cards!.find(card => card.itemQuote === forum)?.sourceAngle).toBe('alternatives');
      }
      expect((await store.funnel()).some(event => event.event === 'held' && event.reason === 'repeat')).toBe(true);
      for (const card of original) expect(snapshot.cards!.some(value => value.id === card.id)).toBe(true);
      if (entryId) expect(snapshot.outbox!.find(entry => entry.id === entryId)?.status).toBe(decision);
      expect((await store.staleness(hostingCard.id)).stale).toBe(false);
    } finally { scheduler.stop(); store.close(); }
  });
}
