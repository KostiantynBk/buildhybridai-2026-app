import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openLocalStore, type LocalStore } from './index';
import type { OutboxEntry } from './triageTypes';

const text = 'The hosting service permits fifty visitors at once while the application serves a public catalogue.';
const quote = 'The hosting service permits fifty visitors at once';
let store: LocalStore;
let lineageId: string;
beforeEach(async () => {
  store = await openLocalStore(`outbox-${crypto.randomUUID()}`);
  await store.saveNotebook(text, 0);
  await store.enqueueSettled(4000, 'extract.v2');
  const claim = await store.claim(4000);
  if (!claim) throw new Error('Expected initial job');
  await store.complete(claim.job, [{ kind: 'assumption', text: 'Hosting capacity', quote, topics: ['hosting'] }], 4000);
  await store.finalizeReady();
  lineageId = (await store.snapshot()).items[0].lineageId!;
});
afterEach(() => store.close());
function entry(id: string, question: string): Omit<OutboxEntry, 'status'> {
  return { id, question, keptOut: ['client name'], cardId: `card-${id}`, itemLineageId: lineageId,
    itemVersion: 1, createdAt: 10 };
}
it('withdraws pending and approved entries immediately after adding a matching term', async () => {
  expect(await store.queueOutbox(entry('pending', 'Does Acme Cloud support this?'))).toBe(true);
  expect(await store.queueOutbox(entry('approved', 'What are Acme Cloud limits?'))).toBe(true);
  expect(await store.decideOutbox('approved', 'approved')).toBe(true);
  expect(await store.preSendCheck('approved')).toEqual({ allowed: true, reason: null });
  await store.putNeverSend(['  ACME CLOUD ']);
  const entries = (await store.snapshot()).outbox!;
  expect(entries.map(value => [value.id, value.status, value.withdrawReason]).sort()).toEqual([
    ['approved', 'withdrawn', 'listed-term'], ['pending', 'withdrawn', 'listed-term'],
  ]);
  expect(entries.find(value => value.id === 'pending')?.question).toContain('Acme Cloud');
  expect(await store.decideOutbox('pending', 'approved')).toBe(false);
  expect(await store.preSendCheck('approved')).toEqual({ allowed: false, reason: 'listed-term' });
});
it('withdraws an entry when a newly listed term appears only in kept-out metadata', async () => {
  expect(await store.queueOutbox({ ...entry('meta', 'What are public hosting limits?'),
    keptOut: ['client name'] })).toBe(true);
  await store.putNeverSend(['CLIENT NAME']);
  expect((await store.snapshot()).outbox?.[0]).toMatchObject({ status: 'withdrawn', withdrawReason: 'listed-term' });
  expect(await store.decideOutbox('meta', 'approved')).toBe(false);
});
it('refuses unsafe questions before queueing and never copies private terms into keptOut', async () => {
  await store.putNeverSend(['private-token']);
  expect(await store.queueOutbox(entry('unsafe', 'Could PRIVATE-TOKEN handle this?'))).toBe(false);
  expect(await store.queueOutbox({ ...entry('safe', 'What are public service limits?'),
    keptOut: ['client name', 'PRIVATE-TOKEN'] })).toBe(true);
  const outbox = (await store.snapshot()).outbox!;
  expect(outbox).toHaveLength(1);
  expect(outbox[0].keptOut).toEqual(['client name']);
});
it('defers approval and pre-send during edit validation, then restores unchanged eligibility', async () => {
  expect(await store.queueOutbox(entry('pending', 'What are the service limits?'))).toBe(true);
  expect(await store.queueOutbox(entry('approved', 'How are service limits measured?'))).toBe(true);
  expect(await store.decideOutbox('approved', 'approved')).toBe(true);
  await store.saveNotebook(`${text} Additional unrelated context.`, 10000);
  expect(await store.decideOutbox('pending', 'approved')).toBe(false);
  expect(await store.preSendCheck('approved')).toEqual({ allowed: false, reason: 'not-eligible-yet' });
  expect((await store.snapshot()).outbox?.find(value => value.id === 'pending')?.status).toBe('pending');
  await store.enqueueSettled(14000, 'extract.v2');
  const extracted = await store.claim(14000);
  if (!extracted) throw new Error('Expected extraction');
  await store.complete(extracted.job, [{ kind: 'assumption', text: 'Hosting capacity', quote,
    topics: ['hosting'] }], 14000);
  expect(await store.preSendCheck('approved')).toEqual({ allowed: false, reason: 'not-eligible-yet' });
  await store.finalizeReady();
  expect(await store.preSendCheck('approved')).toEqual({ allowed: true, reason: null });
  expect(await store.decideOutbox('pending', 'approved')).toBe(true);
});
for (const uncertain of [false, true]) {
  it(`defers during comparison and rejects a ${uncertain ? 'uncertain' : 'changed'} finalized lineage`, async () => {
    expect(await store.queueOutbox(entry('pending', 'What are the service limits?'))).toBe(true);
    expect(await store.queueOutbox(entry('approved', 'How are service limits measured?'))).toBe(true);
    expect(await store.decideOutbox('approved', 'approved')).toBe(true);
    const changed = text.replace('fifty', 'twenty');
    await store.saveNotebook(changed, 10000);
    await store.enqueueSettled(14000, 'extract.v2');
    const extract = await store.claim(14000);
    if (!extract) throw new Error('Expected extraction');
    await store.complete(extract.job, [{ kind: 'assumption', text: 'Hosting capacity',
      quote: quote.replace('fifty', 'twenty'), topics: ['hosting'] }], 14000);
    const compare = await store.claim(14000);
    if (!compare) throw new Error('Expected comparison');
    expect(await store.decideOutbox('pending', 'approved')).toBe(false);
    expect(await store.preSendCheck('approved')).toEqual({ allowed: false, reason: 'not-eligible-yet' });
    await store.completeComparison(compare.job, { status: 'changed', newQuote: quote.replace('fifty', 'twenty'),
      newQuoteFound: true, needsConfirmation: uncertain, source: 'on_device', latencyMs: 1,
      promptVersion: 'compare.v1' });
    await store.finalizeReady();
    expect(await store.preSendCheck('approved')).toEqual({ allowed: false, reason: 'stale' });
    expect(await store.decideOutbox('pending', 'approved')).toBe(false);
  });
}
it('keeps a retryable failed comparison in checking rather than withdrawing', async () => {
  expect(await store.queueOutbox(entry('pending', 'What are the service limits?'))).toBe(true);
  const changed = text.replace('fifty', 'twenty');
  await store.saveNotebook(changed, 10000);
  await store.enqueueSettled(14000, 'extract.v2');
  const extract = await store.claim(14000);
  if (!extract) throw new Error('Expected extraction');
  await store.complete(extract.job, [{ kind: 'assumption', text: 'Hosting capacity',
    quote: quote.replace('fifty', 'twenty'), topics: ['hosting'] }], 14000);
  const compare = await store.claim(14000);
  if (!compare) throw new Error('Expected comparison');
  await store.fail(compare.job, 'Error', false, 14000, false, true);
  await store.reconcileOutbox();
  expect((await store.snapshot()).outbox?.[0].status).toBe('pending');
  expect(await store.decideOutbox('pending', 'approved')).toBe(false);
});
it('keeps approval deferred if a second edit arrives during comparison', async () => {
  expect(await store.queueOutbox(entry('pending', 'What are the service limits?'))).toBe(true);
  const changed = text.replace('fifty', 'twenty');
  await store.saveNotebook(changed, 10000);
  await store.enqueueSettled(14000, 'extract.v2');
  const extract = await store.claim(14000);
  if (!extract) throw new Error('Expected extraction');
  await store.complete(extract.job, [{ kind: 'assumption', text: 'Hosting capacity',
    quote: quote.replace('fifty', 'twenty'), topics: ['hosting'] }], 14000);
  const compare = await store.claim(14000);
  if (!compare) throw new Error('Expected comparison');
  await store.saveNotebook(`${changed} A second edit.`, 15000);
  expect(await store.completeComparison(compare.job, { status: 'unchanged', newQuote: '', newQuoteFound: null,
    needsConfirmation: false, source: 'on_device', latencyMs: 1, promptVersion: 'compare.v1' })).toBe(false);
  await store.finalizeReady();
  expect(await store.decideOutbox('pending', 'approved')).toBe(false);
  expect((await store.snapshot()).outbox?.[0].status).toBe('pending');
});
it('withdraws stale pending entries and blocks an approved entry at the pre-send hook', async () => {
  expect(await store.queueOutbox(entry('pending', 'What are the service limits?'))).toBe(true);
  expect(await store.queueOutbox(entry('approved', 'How are service limits measured?'))).toBe(true);
  expect(await store.decideOutbox('approved', 'approved')).toBe(true);
  const changed = text.replace('fifty', 'twenty');
  await store.saveNotebook(changed, 10000);
  await store.enqueueSettled(14000, 'extract.v2');
  const extracted = await store.claim(14000);
  if (!extracted) throw new Error('Expected new extract');
  await store.complete(extracted.job, [{ kind: 'assumption', text: 'Hosting capacity',
    quote: quote.replace('fifty', 'twenty'), topics: ['hosting'] }], 14000);
  const compared = await store.claim(14000);
  if (!compared) throw new Error('Expected comparison');
  await store.completeComparison(compared.job, { status: 'changed', newQuote: quote.replace('fifty', 'twenty'),
    newQuoteFound: true, needsConfirmation: false, source: 'on_device', latencyMs: 1, promptVersion: 'compare.v1' });
  await store.finalizeReady();
  await store.reconcileOutbox();
  expect((await store.snapshot()).outbox!.find(value => value.id === 'pending'))
    .toMatchObject({ status: 'withdrawn', withdrawReason: 'stale' });
  expect(await store.preSendCheck('approved')).toEqual({ allowed: false, reason: 'stale' });
});
