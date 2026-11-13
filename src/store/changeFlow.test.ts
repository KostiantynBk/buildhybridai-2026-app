import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openLocalStore, type LocalStore } from './index';
import { compare, type Comparison } from '../pipeline/compare';
import type { LocalRunner } from '../pipeline/extract';
import { vi } from 'vitest';

const oldText = 'The hosting handles fifty visitors at once. The budget remains under ten pounds each month. ' +
  'The project will have a simple catalogue and a small first release.';
const edited = 'The hosting handles twenty visitors at once. The budget remains under ten pounds each month. ' +
  'The project will have a simple catalogue and a small first release.';
const initialItems = [
  { kind: 'assumption', text: 'Fifty visitors', quote: 'The hosting handles fifty visitors at once',
    topics: ['hosting'] },
  { kind: 'constraint', text: 'Ten pound budget', quote: 'The budget remains under ten pounds each month',
    topics: ['pricing'] },
];
let store: LocalStore;
beforeEach(async () => { store = await openLocalStore(`changes-${crypto.randomUUID()}`); });
afterEach(() => store.close());
async function extractVersion(text: string, items: typeof initialItems, now: number) {
  const [paragraph] = await store.saveNotebook(text, now);
  await store.enqueueSettled(now + 4000, 'extract.v2');
  const claim = await store.claim(now + 4000);
  if (!claim || claim.job.step !== 'extract') throw new Error('Expected extract job');
  await store.complete(claim.job, items, now + 4000);
  await store.finalizeReady();
  return paragraph;
}
const comparison = (status: Comparison['status'], newQuote = '', found: boolean | null = null): Comparison => ({
  status, newQuote, newQuoteFound: found, needsConfirmation: status === 'changed' && !found,
  source: 'on_device', latencyMs: 1, promptVersion: 'compare.v1',
});
async function answer(result: Comparison) {
  const claim = await store.claim(100000);
  if (!claim || claim.job.step !== 'compare') throw new Error('Expected compare job');
  await store.completeComparison(claim.job, result);
  await store.finalizeReady();
  return claim;
}
it('preserves lineages across reordered quotes without a model comparison', async () => {
  await extractVersion(oldText, initialItems, 0);
  const old = await store.lineages();
  const reordered = 'The budget remains under ten pounds each month. The hosting handles fifty visitors at once. ' +
    'The project will have a simple catalogue and a small first release.';
  await extractVersion(reordered, [initialItems[1], { ...initialItems[0], kind: 'constraint' }], 10000);
  const newer = await store.lineages();
  expect(newer.map(value => [value.lineageId, value.version]).sort())
    .toEqual(old.map(value => [value.lineageId, value.version]).sort());
  expect((await store.snapshot()).jobs.filter(job => job.step === 'compare')).toHaveLength(0);
});
it('keeps the earlier lineage when two old quotes compete for a merged item', async () => {
  await extractVersion(oldText, initialItems, 0);
  const before = await store.snapshot();
  const first = before.items.find(item => item.text === 'Fifty visitors')!;
  const second = before.items.find(item => item.text === 'Ten pound budget')!;
  const reordered = 'The budget remains under ten pounds each month. The hosting handles fifty visitors at once. ' +
    'The project will have a simple catalogue and a small first release.';
  const merged = [{ kind: 'constraint', text: 'Merged',
    quote: 'The budget remains under ten pounds each month. The hosting handles fifty visitors at once',
    topics: ['hosting'] }];
  await extractVersion(reordered, merged, 10000);
  const current = (await store.snapshot()).items.filter(item => item.status === 'current');
  expect(current.find(item => item.text === 'Merged')?.lineageId).toBe(first.lineageId);
  expect(current.find(item => item.lineageId === second.lineageId)?.text).toBe('Ten pound budget');
});
it('changes only one lineage and marks its dependency stale', async () => {
  await extractVersion(oldText, initialItems, 0);
  const snapshot = await store.snapshot();
  const hostingItem = snapshot.items.find(item => item.text === 'Fifty visitors')!;
  const budgetItem = snapshot.items.find(item => item.text === 'Ten pound budget')!;
  await store.putDependency({ consumerId: 'hosting-card', lineageId: hostingItem.lineageId!, version: 1 });
  await store.putDependency({ consumerId: 'budget-card', lineageId: budgetItem.lineageId!, version: 1 });
  const changedItems = [{ ...initialItems[0], kind: 'constraint', text: 'Twenty visitors',
    quote: 'The hosting handles twenty visitors at once' }, initialItems[1]];
  await extractVersion(edited, changedItems, 10000);
  expect((await store.staleness('hosting-card')).stale).toBe(false);
  await answer(comparison('changed', 'The hosting handles twenty visitors at once', true));
  expect(await store.staleness('hosting-card')).toEqual({ stale: true, reasons: [{
    lineageId: hostingItem.lineageId, was: 1, now: 2, kind: 'changed' }] });
  expect(await store.staleness('budget-card')).toEqual({ stale: false, reasons: [] });
  const latest = (await store.snapshot()).items.find(item => item.status === 'current' &&
    item.text === 'Twenty visitors');
  expect(latest).toMatchObject({ lineageId: hostingItem.lineageId, kind: 'constraint' });
});
it('retires a removed statement, and preserves an unchanged rewording by carrying the prior item', async () => {
  await extractVersion(oldText, initialItems, 0);
  const before = await store.snapshot();
  const budget = before.items.find(item => item.text === 'Ten pound budget')!;
  const removedText = 'The hosting handles fifty visitors at once. The project will have a simple catalogue ' +
    'and a small first release for a group of early users.';
  await extractVersion(removedText, [initialItems[0]], 10000);
  await answer(comparison('removed'));
  expect((await store.lineages()).find(lineage => lineage.lineageId === budget.lineageId && lineage.version === 2))
    .toMatchObject({ status: 'removed' });
});
it('retains the earlier lineage as unchanged when a removed quote is merely reworded', async () => {
  await extractVersion(oldText, initialItems, 0);
  const first = (await store.snapshot()).items.find(item => item.text === 'Fifty visitors')!;
  await extractVersion(edited, initialItems.slice(1), 10000);
  await answer(comparison('unchanged'));
  const result = (await store.snapshot()).items.find(item => item.lineageId === first.lineageId &&
    item.paragraphVersion === 2 && item.status === 'current');
  expect(result).toMatchObject({ text: 'Fifty visitors', quote: first.quote });
  expect((await store.lineages()).filter(lineage => lineage.lineageId === first.lineageId)).toHaveLength(1);
});
it('never transfers a desktop dependency to a lexically similar mobile statement', async () => {
  const desktop = 'The desktop app stores account data offline for thirty days';
  const reworded = 'The desktop app retains user records offline for thirty days';
  const mobile = 'The mobile app stores account data offline for seven days';
  const later = 'The desktop app retains user records offline for forty days';
  const tail = 'The project has a simple catalogue and a small first release for early users.';
  const record = (text: string, quote: string) => ({ kind: 'assumption', text, quote, topics: ['data-storage'] });
  await extractVersion(`${desktop}. ${tail}`, [record('Desktop 30', desktop)], 0);
  const original = (await store.snapshot()).items.find(item => item.text === 'Desktop 30')!;
  await store.putDependency({ consumerId: 'desktop-card', lineageId: original.lineageId!, version: 1 });
  await extractVersion(`${reworded}. ${mobile}. ${tail}`,
    [record('Desktop 30 reworded', reworded), record('Mobile 7', mobile)], 10000);
  await answer(comparison('unchanged'));
  const afterReword = await store.snapshot();
  const current = afterReword.items.filter(item => item.status === 'current');
  expect(current.find(item => item.text === 'Desktop 30')?.lineageId).toBe(original.lineageId);
  expect(current.find(item => item.text === 'Mobile 7')?.lineageId).not.toBe(original.lineageId);
  await extractVersion(`${later}. ${mobile}. ${tail}`,
    [record('Desktop 40', later), record('Mobile 7', mobile)], 20000);
  const pending = (await store.snapshot()).jobs.filter(job => job.step === 'compare' && job.status === 'pending');
  expect(pending).toHaveLength(2);
  for (const _job of pending) {
    const claim = await store.claim(100000);
    if (!claim) throw new Error('Expected comparison');
    await store.completeComparison(claim.job, comparison('changed', later, true));
  }
  await store.finalizeReady();
  const stale = await store.staleness('desktop-card');
  expect(stale.stale).toBe(true);
  expect(['changed', 'needsConfirmation']).toContain(stale.reasons[0].kind);
});
it('carries an unchanged old item and independently records unrelated items', async () => {
  await extractVersion(oldText, initialItems, 0);
  const first = (await store.snapshot()).items.find(item => item.text === 'Fifty visitors')!;
  const text = edited + ' Apples grow in a quiet orchard beside the river.';
  const unrelated = { kind: 'decision', text: 'Orchard', quote: 'Apples grow in a quiet orchard beside the river',
    topics: ['other'] };
  await extractVersion(text, [initialItems[1], unrelated], 10000);
  await answer(comparison('unchanged'));
  const current = (await store.snapshot()).items.filter(item => item.status === 'current');
  expect(current.find(item => item.text === 'Fifty visitors')?.lineageId).toBe(first.lineageId);
  expect(current.find(item => item.text === 'Orchard')?.lineageId).toBeTruthy();
  expect(current.find(item => item.text === 'Orchard')?.lineageId).not.toBe(first.lineageId);
});
it('retires lineages when their entire paragraph is deleted', async () => {
  await extractVersion(oldText, initialItems, 0);
  const first = (await store.snapshot()).items.find(item => item.text === 'Fifty visitors')!;
  await store.putDependency({ consumerId: 'card', lineageId: first.lineageId!, version: 1 });
  await store.saveNotebook('', 10000);
  expect(await store.staleness('card')).toEqual({ stale: true, reasons: [{
    lineageId: first.lineageId, was: 1, now: 2, kind: 'removed' }] });
});
it('drops superseded comparisons before dispatch and before storing a late result', async () => {
  await extractVersion(oldText, initialItems, 0);
  const first = (await store.snapshot()).items.find(item => item.text === 'Fifty visitors')!;
  await store.putDependency({ consumerId: 'card', lineageId: first.lineageId!, version: 1 });
  await extractVersion(edited, initialItems.slice(1), 10000);
  const inflight = await store.claim(14000);
  if (!inflight || inflight.job.step !== 'compare') throw new Error('Expected comparison');
  await store.saveNotebook(`${edited} Additional later words.`, 15000);
  expect(await store.completeComparison(inflight.job, comparison('changed', 'twenty visitors', true))).toBe(false);
  expect(await store.staleness('card')).toEqual({ stale: false, reasons: [] });
  expect((await store.snapshot()).jobs.find(job => job.key === inflight.job.key)?.status).toBe('superseded');
});
it('does not dispatch a comparison superseded while pending', async () => {
  await extractVersion(oldText, initialItems, 0);
  await extractVersion(edited, initialItems.slice(1), 10000);
  await store.saveNotebook(`${edited} Newer detail.`, 15000);
  expect(await store.claim(15000)).toBeNull();
  expect((await store.snapshot()).jobs.find(job => job.step === 'compare')?.status).toBe('superseded');
});
it('resumes interrupted comparisons at most three times and leaves a failure unchecked', async () => {
  await extractVersion(oldText, initialItems, 0);
  const first = (await store.snapshot()).items.find(item => item.text === 'Fifty visitors')!;
  await store.putDependency({ consumerId: 'card', lineageId: first.lineageId!, version: 1 });
  await extractVersion(edited, initialItems.slice(1), 10000);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const claim = await store.claim(14000);
    expect(claim?.job).toMatchObject({ step: 'compare', status: 'running', attempts: attempt });
    await store.resume();
  }
  expect(await store.claim(14000)).toBeNull();
  await store.finalizeReady();
  expect((await store.lineages()).find(lineage => lineage.lineageId === first.lineageId))
    .toMatchObject({ version: 1, status: 'current', unchecked: true,
      uncheckedReason: 'interrupted-at-attempt-limit' });
  expect(await store.staleness('card')).toEqual({ stale: false, reasons: [] });
});
it('a failed comparison is visibly unchecked and never marks a dependency changed', async () => {
  await extractVersion(oldText, initialItems, 0);
  const first = (await store.snapshot()).items.find(item => item.text === 'Fifty visitors')!;
  await store.putDependency({ consumerId: 'card', lineageId: first.lineageId!, version: 1 });
  await extractVersion(edited, initialItems.slice(1), 10000);
  const claim = await store.claim(14000);
  if (!claim) throw new Error('Expected comparison');
  await store.fail(claim.job, 'private raw data', false, 14000, true);
  await store.finalizeReady();
  expect((await store.lineages()).find(lineage => lineage.lineageId === first.lineageId))
    .toMatchObject({ version: 1, status: 'current', unchecked: true, uncheckedReason: 'OtherError' });
  expect(await store.staleness('card')).toEqual({ stale: false, reasons: [] });
});
it('marks an unmatched replacement uncertain and links a later matching item', async () => {
  await extractVersion(oldText, initialItems, 0);
  const first = (await store.snapshot()).items.find(item => item.text === 'Fifty visitors')!;
  await store.putDependency({ consumerId: 'card', lineageId: first.lineageId!, version: 1 });
  await extractVersion(edited, initialItems.slice(1), 10000);
  const newQuote = 'The hosting handles twenty visitors at once';
  await answer(comparison('changed', newQuote, true));
  let snapshot = await store.snapshot();
  const head = snapshot.lineages!.find(lineage => lineage.lineageId === first.lineageId && lineage.version === 2);
  expect(head).toMatchObject({ status: 'changed', needsConfirmation: true, newQuote });
  expect(snapshot.items.find(item => item.id === head?.itemId)).toMatchObject({ text: first.text, quote: first.quote });
  expect(await store.staleness('card')).toEqual({ stale: true, reasons: [{
    lineageId: first.lineageId, was: 1, now: 2, kind: 'needsConfirmation' }] });
  await store.putDependency({ consumerId: 'v2-card', lineageId: first.lineageId!, version: 2 });
  const candidate = { ...initialItems[0], kind: 'constraint', text: 'Twenty visitors', quote: newQuote };
  await extractVersion(`${edited} More details follow.`, [candidate, initialItems[1]], 20000);
  snapshot = await store.snapshot();
  expect(snapshot.jobs.filter(job => job.step === 'compare' && job.paragraphVersion === 3)).toHaveLength(0);
  expect(await store.staleness('v2-card')).toEqual({ stale: false, reasons: [] });
  const linked = snapshot.items.find(item => item.status === 'current' && item.text === 'Twenty visitors');
  expect(linked?.lineageId).toBe(first.lineageId);
  expect(snapshot.lineages!.find(lineage => lineage.lineageId === first.lineageId && lineage.version === 2))
    .toMatchObject({ status: 'current', needsConfirmation: false, itemId: linked?.id });
  expect((await store.staleness('card')).reasons[0].kind).toBe('changed');
  const thirtyText = `${edited.replace('twenty', 'thirty')} More details follow.`;
  const thirtyQuote = newQuote.replace('twenty', 'thirty');
  await extractVersion(thirtyText, [{ ...candidate, text: 'Thirty visitors', quote: thirtyQuote }, initialItems[1]],
    30000);
  const next = await store.claim(100000);
  if (!next) throw new Error('Expected new comparison');
  const input = await store.comparisonInput(next.job);
  expect(input?.item).toEqual({ text: newQuote, quote: newQuote });
  await store.completeComparison(next.job, comparison('changed', thirtyQuote, true));
  await store.finalizeReady();
  expect((await store.staleness('v2-card')).reasons).toEqual([{
    lineageId: first.lineageId, was: 2, now: 3, kind: 'changed',
  }]);
});
it('uses unresolved verified evidence as both comparison fields when that evidence disappears', async () => {
  await extractVersion(oldText, initialItems, 0);
  const first = (await store.snapshot()).items.find(item => item.text === 'Fifty visitors')!;
  await extractVersion(edited, initialItems.slice(1), 10000);
  const twenty = 'The hosting handles twenty visitors at once';
  await answer(comparison('changed', twenty, true));
  await store.putDependency({ consumerId: 'v2', lineageId: first.lineageId!, version: 2 });
  const thirty = twenty.replace('twenty', 'thirty');
  const nextText = edited.replace(twenty, thirty);
  await extractVersion(nextText, [{ ...initialItems[0], text: 'Thirty visitors', quote: thirty }, initialItems[1]],
    20000);
  const job = await store.claim(100000);
  if (!job) throw new Error('Expected evidence comparison');
  const input = await store.comparisonInput(job.job);
  if (!input) throw new Error('Expected prior lineage');
  expect(input.item).toMatchObject({ text: twenty, quote: twenty });
  const runner = vi.fn(async () => ({ data: { status: 'changed', newQuote: thirty },
    source: 'on_device', latencyMs: 1, raw: '{}' })) as unknown as LocalRunner;
  const result = await compare(runner, input.item, nextText);
  expect(vi.mocked(runner).mock.calls[0][0].prompt).toContain(`Earlier statement: ${twenty}`);
  expect(vi.mocked(runner).mock.calls[0][0].prompt).toContain(`Earlier words: "${twenty}"`);
  expect(vi.mocked(runner).mock.calls[0][0].prompt).not.toContain('Fifty visitors');
  await store.completeComparison(job.job, result);
  await store.finalizeReady();
  expect((await store.staleness('v2')).reasons).toEqual([{
    lineageId: first.lineageId, was: 2, now: 3, kind: 'changed',
  }]);
});
it('never relinks uncertain Basic evidence to an obsolete quote in a Premium statement', async () => {
  const old = 'The basic plan supports fifty simultaneous visitors';
  const oldQuote = 'supports fifty simultaneous visitors';
  const evidence = 'The basic plan supports twenty simultaneous visitors';
  const reworded = 'On the basic tier, twenty concurrent visitors are supported';
  const premium = 'The premium plan supports fifty simultaneous visitors';
  const next = 'On the basic tier, thirty concurrent visitors are supported';
  const tail = 'The project has a simple catalogue and a small first release for early users.';
  const record = (text: string, quote: string) => ({ kind: 'assumption', text, quote, topics: ['pricing'] });
  await extractVersion(`${old}. ${tail}`, [record('Basic 50', oldQuote)], 0);
  const original = (await store.snapshot()).items.find(item => item.text === 'Basic 50')!;
  await extractVersion(`${evidence}. ${tail}`, [], 10000);
  await answer(comparison('changed', evidence, true));
  await store.putDependency({ consumerId: 'basic-v2', lineageId: original.lineageId!, version: 2 });
  await extractVersion(`${reworded}. ${premium}. ${tail}`,
    [record('Basic 20 reworded', reworded), record('Premium 50', premium)], 20000);
  const claim = await store.claim(100000);
  if (!claim) throw new Error('Expected reworded evidence comparison');
  expect((await store.comparisonInput(claim.job))?.item).toEqual({ text: evidence, quote: evidence });
  await store.completeComparison(claim.job, comparison('unchanged'));
  await store.finalizeReady();
  const third = await store.snapshot();
  const head = third.lineages!.find(lineage => lineage.lineageId === original.lineageId && lineage.version === 2);
  expect(head).toMatchObject({ status: 'current', needsConfirmation: true, newQuote: evidence });
  expect(third.items.find(item => item.id === head?.itemId)).toMatchObject({ text: 'Basic 50', quote: oldQuote });
  expect(third.items.find(item => item.text === 'Premium 50' && item.status === 'current')?.lineageId)
    .not.toBe(original.lineageId);
  expect(await store.staleness('basic-v2')).toEqual({ stale: false, reasons: [] });
  await extractVersion(`${next}. ${premium}. ${tail}`,
    [record('Basic 30', next), record('Premium 50', premium)], 30000);
  const pending = (await store.snapshot()).jobs.filter(job => job.step === 'compare' && job.status === 'pending');
  expect(pending).toHaveLength(2);
  for (const _job of pending) {
    const later = await store.claim(100000);
    if (!later) throw new Error('Expected changed comparison');
    await store.completeComparison(later.job, comparison('changed', next, true));
  }
  await store.finalizeReady();
  const stale = await store.staleness('basic-v2');
  expect(stale.stale).toBe(true);
  expect(['changed', 'needsConfirmation']).toContain(stale.reasons[0].kind);
  const latest = await store.snapshot();
  expect(latest.items.find(item => item.text === 'Premium 50' && item.status === 'current')?.lineageId)
    .not.toBe(original.lineageId);
});
it('does not attach the same merged successor to two changed lineages', async () => {
  await extractVersion(oldText, initialItems, 0);
  const before = await store.snapshot();
  const first = before.items.find(item => item.text === 'Fifty visitors')!;
  const second = before.items.find(item => item.text === 'Ten pound budget')!;
  await store.putDependency({ consumerId: 'budget', lineageId: second.lineageId!, version: 1 });
  const text = 'The hosting handles twenty visitors at once. The budget remains under five pounds each month. ' +
    'The project will have a simple catalogue and a small first release.';
  const combined = [{ kind: 'constraint', text: 'Combined', quote:
    'The hosting handles twenty visitors at once. The budget remains under five pounds each month',
    topics: ['hosting'] }];
  await extractVersion(text, combined, 10000);
  const q1 = 'The hosting handles twenty visitors at once';
  const q2 = 'The budget remains under five pounds each month';
  const pending = (await store.snapshot()).jobs.filter(job => job.step === 'compare');
  expect(pending).toHaveLength(2);
  for (const job of pending) {
    const claim = await store.claim(100000);
    if (!claim) throw new Error('Expected comparison');
    await store.completeComparison(claim.job,
      comparison('changed', claim.job.lineageId === first.lineageId ? q1 : q2, true));
  }
  await store.finalizeReady();
  const snapshot = await store.snapshot();
  expect(snapshot.items.find(item => item.text === 'Combined')?.lineageId).toBe(first.lineageId);
  const uncertain = snapshot.lineages!.find(lineage => lineage.lineageId === second.lineageId && lineage.version === 2);
  expect(uncertain).toMatchObject({ needsConfirmation: true, conflictingEvidence: false, newQuote: q2 });
  expect(snapshot.items.find(item => item.id === uncertain?.itemId)?.text).toBe('Ten pound budget');
  expect((await store.staleness('budget')).reasons[0].kind).toBe('needsConfirmation');
});
it('marks missing model replacement wording as requiring confirmation', async () => {
  await extractVersion(oldText, initialItems, 0);
  const first = (await store.snapshot()).items.find(item => item.text === 'Fifty visitors')!;
  await store.putDependency({ consumerId: 'card', lineageId: first.lineageId!, version: 1 });
  await extractVersion(edited, initialItems.slice(1), 10000);
  await answer(comparison('changed', 'quote not in paragraph', false));
  expect((await store.staleness('card')).reasons).toEqual([{
    lineageId: first.lineageId, was: 1, now: 2, kind: 'needsConfirmation',
  }]);
  expect((await store.lineages()).find(lineage => lineage.lineageId === first.lineageId && lineage.version === 2)
    ?.newQuote).toBeUndefined();
  await extractVersion(`${edited} More context.`, initialItems.slice(1), 20000);
  const job = await store.claim(100000);
  if (!job) throw new Error('Expected comparison without verified evidence');
  const input = await store.comparisonInput(job.job);
  expect(input?.item).toMatchObject({ text: first.text, quote: first.quote });
});
