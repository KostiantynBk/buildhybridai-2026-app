import 'fake-indexeddb/auto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { compare } from '../pipeline/compare';
import type { LocalRunner } from '../pipeline/extract';
import { NotebookPanel } from '../ui/NotebookPanel';
import { openLocalStore, type LocalStore } from './index';

const hosting = 'I will host on a free plan that allows 10 requests a minute';
const payments = 'Payments go through a card processor that charges 3% per sale';
const initialText = `${hosting}. ${payments}.`;
const hostItem = { kind: 'decision', text: 'Free hosting', quote: hosting, topics: ['hosting'] };
const paymentItem = { kind: 'decision', text: 'Card processor', quote: 'Payments go through a card processor',
  topics: ['payments'] };
const feeItem = { kind: 'constraint', text: '3% charge', quote: 'charges 3% per sale', topics: ['payments'] };
let store: LocalStore;
beforeEach(async () => { store = await openLocalStore(`conflict-${crypto.randomUUID()}`); });
afterEach(() => store.close());
async function extract(text: string, items: typeof hostItem[], now: number) {
  await store.saveNotebook(text, now);
  await store.enqueueSettled(now + 4000, 'extract.v2');
  const claim = await store.claim(now + 4000);
  if (!claim || claim.job.step !== 'extract') throw new Error('Expected extract job');
  await store.complete(claim.job, items, now + 4000);
  await store.finalizeReady();
}
async function resolve(status: 'changed' | 'removed', quote = '') {
  const claim = await store.claim(100000);
  if (!claim || claim.job.step !== 'compare') throw new Error('Expected comparison');
  await store.completeComparison(claim.job, { status, newQuote: quote,
    newQuoteFound: status === 'changed' ? true : null, needsConfirmation: false,
    latencyMs: 1, source: 'on_device', promptVersion: 'compare.v1' });
  await store.finalizeReady();
  return claim.job;
}
it('suppresses a hosting quote incorrectly returned as changed payment evidence', async () => {
  // Payment first forces initial matching to give it the candidate, so conflict detection must reassign it.
  await extract(initialText, [paymentItem, hostItem, feeItem], 0);
  const before = await store.snapshot();
  const host = before.items.find(item => item.text === 'Free hosting')!;
  const payment = before.items.find(item => item.text === 'Card processor')!;
  const fee = before.items.find(item => item.text === '3% charge')!;
  await store.putDependency({ consumerId: 'payment-card', lineageId: payment.lineageId!, version: 1 });
  await extract(`${hosting}.`, [hostItem], 10000);
  const pending = (await store.snapshot()).jobs.filter(job => job.step === 'compare' && job.status === 'pending');
  expect(pending).toHaveLength(2);
  for (const _job of pending) {
    const claim = await store.claim(100000);
    if (!claim) throw new Error('Expected comparison');
    const status = claim.job.lineageId === payment.lineageId ? 'changed' : 'removed';
    await store.completeComparison(claim.job, { status, newQuote: status === 'changed' ? hosting : '',
      newQuoteFound: status === 'changed' ? true : null, needsConfirmation: false,
      source: 'on_device', latencyMs: 1, promptVersion: 'compare.v1' });
  }
  await store.finalizeReady();
  const snapshot = await store.snapshot();
  const head = snapshot.lineages!.find(value => value.lineageId === payment.lineageId && value.version === 2);
  expect(head).toMatchObject({ status: 'changed', needsConfirmation: true, conflictingEvidence: true });
  expect(head?.newQuote).toBeUndefined();
  expect(snapshot.items.find(item => item.id === head?.itemId))
    .toMatchObject({ text: payment.text, quote: payment.quote });
  expect(snapshot.items.find(item => item.status === 'current' && item.text === 'Free hosting')?.lineageId)
    .toBe(host.lineageId);
  expect(snapshot.lineages!.find(value => value.lineageId === fee.lineageId && value.version === 2))
    .toMatchObject({ status: 'removed' });
  expect(await store.staleness('payment-card')).toEqual({ stale: true, reasons: [{
    lineageId: payment.lineageId, was: 1, now: 2, kind: 'needsConfirmation',
  }] });
  const html = renderToStaticMarkup(createElement(NotebookPanel, { text: `${hosting}.`, save: () => {},
    storageStatus: 'saved', snapshot, configured: true, ready: true }));
  expect(html).toContain('May have changed or been removed; please check.');
  expect(html).not.toContain('Now:');
  await extract(`${hosting}. This version adds a small explanatory note for the planning session.`, [hostItem], 20000);
  const next = await store.claim(100000);
  if (!next || next.job.step !== 'compare') throw new Error('Expected follow-up payment comparison');
  expect((await store.comparisonInput(next.job))?.item).toEqual({ text: payment.text, quote: payment.quote });
});
it.each([
  ['payment-first', true, true], ['hosting-first', false, true],
  ['payment-first/no-successor', true, false], ['hosting-first/no-successor', false, false],
])('treats identical changed evidence as contested: %s', async (_label, paymentFirst, hasSuccessor) => {
  const oldHosting = hosting.replace('10 requests', '100 requests');
  const originalHost = { ...hostItem, quote: oldHosting };
  const ordered = paymentFirst ? [paymentItem, originalHost, feeItem] : [originalHost, paymentItem, feeItem];
  await extract(`${oldHosting}. ${payments}.`, ordered, 0);
  const initial = await store.snapshot();
  const payment = initial.items.find(item => item.text === 'Card processor')!;
  const host = initial.items.find(item => item.text === 'Free hosting')!;
  const fee = initial.items.find(item => item.text === '3% charge')!;
  await store.putDependency({ consumerId: 'payment-v1', lineageId: payment.lineageId!, version: 1 });
  await store.putDependency({ consumerId: 'hosting-v1', lineageId: host.lineageId!, version: 1 });
  await extract(`${hosting}.`, hasSuccessor ? [hostItem] : [], 10000);
  const jobs = (await store.snapshot()).jobs.filter(job => job.step === 'compare' && job.status === 'pending');
  expect(jobs).toHaveLength(3);
  for (const _job of jobs) {
    const claim = await store.claim(100000);
    if (!claim) throw new Error('Expected comparison');
    const removed = claim.job.lineageId === fee.lineageId;
    await store.completeComparison(claim.job, { status: removed ? 'removed' : 'changed',
      newQuote: removed ? '' : hosting, newQuoteFound: removed ? null : true, needsConfirmation: false,
      source: 'on_device', latencyMs: 1, promptVersion: 'compare.v1' });
  }
  await store.finalizeReady();
  const snapshot = await store.snapshot();
  for (const original of [payment, host]) {
    const head = snapshot.lineages!.find(lineage => lineage.lineageId === original.lineageId && lineage.version === 2);
    expect(head).toMatchObject({ status: 'changed', needsConfirmation: true, conflictingEvidence: true });
    expect(head?.newQuote).toBeUndefined();
    expect(snapshot.items.find(item => item.id === head?.itemId)).toMatchObject({ text: original.text,
      quote: original.quote });
  }
  const hostingCandidate = snapshot.items.find(item => item.status === 'current' && item.quote === hosting);
  if (hasSuccessor) {
    expect(hostingCandidate?.lineageId).toBeTruthy();
    expect([payment.lineageId, host.lineageId]).not.toContain(hostingCandidate?.lineageId);
  } else expect(hostingCandidate).toBeUndefined();
  for (const consumer of ['payment-v1', 'hosting-v1']) {
    expect((await store.staleness(consumer)).reasons[0].kind).toBe('needsConfirmation');
  }
  const html = renderToStaticMarkup(createElement(NotebookPanel, { text: `${hosting}.`, save: () => {},
    storageStatus: 'saved', snapshot, configured: true, ready: true }));
  expect(html.match(/May have changed or been removed; please check\./g)).toHaveLength(2);
  expect(html).not.toContain('Now:');
  expect(html).not.toContain('Changed: was');
  await store.putDependency({ consumerId: 'payment-v2', lineageId: payment.lineageId!, version: 2 });
  const bank = 'Payments instead use direct bank transfers with a fixed monthly charge';
  await extract(`${hosting}. ${bank}.`, [hostItem, { ...paymentItem, text: 'Bank transfers', quote: bank }], 20000);
  const nextJobs = (await store.snapshot()).jobs.filter(job => job.step === 'compare' && job.status === 'pending');
  let sawPayment = false;
  for (const _job of nextJobs) {
    const claim = await store.claim(100000);
    if (!claim) throw new Error('Expected later comparison');
    const input = await store.comparisonInput(claim.job);
    if (claim.job.lineageId === payment.lineageId) {
      sawPayment = true;
      expect(input?.item).toEqual({ text: payment.text, quote: payment.quote });
      const runner = vi.fn(async () => ({ data: { status: 'changed', newQuote: bank },
        source: 'on_device', latencyMs: 1, raw: '{}' })) as unknown as LocalRunner;
      const output = await compare(runner, input!.item, `${hosting}. ${bank}.`);
      expect(vi.mocked(runner).mock.calls[0][0].prompt).toContain(payment.quote);
      await store.completeComparison(claim.job, output);
    } else {
      await store.completeComparison(claim.job, { status: 'changed', newQuote: hosting, newQuoteFound: true,
        needsConfirmation: false, source: 'on_device', latencyMs: 1, promptVersion: 'compare.v1' });
    }
  }
  expect(sawPayment).toBe(true);
  await store.finalizeReady();
  expect((await store.staleness('payment-v2')).stale).toBe(true);
});
it('preserves a previously verified evidence baseline when a later quote conflicts', async () => {
  await extract(initialText, [hostItem, paymentItem], 0);
  const original = (await store.snapshot()).items.find(item => item.text === 'Card processor')!;
  const paymentEvidence = 'Card transactions are settled daily by a payment service';
  await extract(`${hosting}. ${paymentEvidence}.`, [hostItem], 10000);
  await resolve('changed', paymentEvidence);
  const second = (await store.lineages()).find(lineage => lineage.lineageId === original.lineageId &&
    lineage.version === 2);
  expect(second).toMatchObject({ needsConfirmation: true, newQuote: paymentEvidence });
  await extract(`${hosting}.`, [hostItem], 20000);
  await resolve('changed', hosting);
  const third = (await store.lineages()).find(lineage => lineage.lineageId === original.lineageId &&
    lineage.version === 3);
  expect(third).toMatchObject({ needsConfirmation: true, conflictingEvidence: true, newQuote: paymentEvidence });
  const html = renderToStaticMarkup(createElement(NotebookPanel, { text: `${hosting}.`, save: () => {},
    storageStatus: 'saved', snapshot: await store.snapshot(), configured: true, ready: true }));
  expect(html).toContain('May have changed or been removed; please check.');
  expect(html).not.toContain('Now:');
  await extract(`${hosting}. A later edit adds extra explanatory context for the plan.`, [hostItem], 30000);
  const claim = await store.claim(100000);
  if (!claim) throw new Error('Expected follow-up comparison');
  expect((await store.comparisonInput(claim.job))?.item).toEqual({ text: paymentEvidence, quote: paymentEvidence });
});
it('conservatively flags a genuine merged sentence that overlaps another lineage baseline', async () => {
  const shortHost = { ...hostItem, quote: 'free plan' };
  await extract(initialText, [shortHost, paymentItem], 0);
  const before = await store.snapshot();
  const host = before.items.find(item => item.text === 'Free hosting')!;
  const payment = before.items.find(item => item.text === 'Card processor')!;
  const mergedText = 'I will host on a free plan and route all payments through a card processor for each sale.';
  const merged = { kind: 'decision', text: 'Combined plan', quote: mergedText.slice(0, -1), topics: ['hosting'] };
  await extract(mergedText, [merged], 10000);
  await resolve('changed', merged.quote);
  const snapshot = await store.snapshot();
  const paymentHead = snapshot.lineages!.find(value => value.lineageId === payment.lineageId && value.version === 2);
  expect(paymentHead).toMatchObject({ status: 'changed', needsConfirmation: true, conflictingEvidence: true });
  expect(paymentHead?.newQuote).toBeUndefined();
  expect(snapshot.items.find(item => item.id === paymentHead?.itemId)?.text).toBe(payment.text);
  expect(snapshot.items.find(item => item.text === 'Combined plan' && item.status === 'current')?.lineageId)
    .toBe(host.lineageId);
});
