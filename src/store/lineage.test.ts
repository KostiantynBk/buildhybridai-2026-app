import { expect, it } from 'vitest';
import { assignmentsWithConflicts, comparisonBaseline, matchSuccessors, type Decision, type PriorLineage }
  from './lineage';
import type { StoredItem } from './index';
const item = (id: string, quote: string, kind = 'assumption'): StoredItem => ({ id, quote, kind, text: id,
  topics: ['other'], paragraphId: 'p', paragraphVersion: 1, status: 'current', promptVersion: 'extract.v2',
  createdAt: 0 });
const old = (id: string, quote: string): PriorLineage => ({ item: item(id, quote), lineage: { lineageId: id,
  version: 1, itemId: id, paragraphId: 'p', paragraphVersion: 1, status: 'current' } });
const unchanged: Decision = { status: 'unchanged', newQuote: '', newQuoteFound: null, needsConfirmation: false };
const changed = (quote: string): Decision => ({ status: 'changed', newQuote: quote,
  newQuoteFound: true, needsConfirmation: false });
it('keeps identity through reordering, kind changes and merged items', () => {
  const paragraph = 'The budget is small. Hosting is shared.';
  const previous = [old('a', 'Hosting is shared'), old('b', 'The budget is small')];
  const candidates = [item('new-b', 'The budget is small', 'constraint'), item('new-a', 'Hosting is shared')];
  expect([...matchSuccessors(paragraph, previous, candidates, { a: unchanged, b: unchanged })])
    .toEqual([['a', 'new-a'], ['b', 'new-b']]);
  const merged = [item('merged', 'The budget is small. Hosting is shared', 'constraint')];
  expect([...matchSuccessors(paragraph, previous, merged, { a: unchanged, b: unchanged })]).toEqual([['a', 'merged']]);
});
it('uses replacement quotes for changed items and excludes missing or unchecked comparisons', () => {
  const paragraph = 'Twenty visitors will use shared hosting.';
  const prior = [old('a', 'Fifty visitors'), old('b', 'Old other claim')];
  const candidates = [item('n', 'Twenty visitors')];
  expect([...matchSuccessors(paragraph, prior, candidates, { a: changed('Twenty visitors'),
    b: { status: 'unchecked', reason: 'Error' } })]).toEqual([['a', 'n']]);
});
it('never reads an obsolete display quote when verified head evidence exists', () => {
  const prior = old('a', 'old display words');
  prior.lineage.newQuote = 'new verified evidence';
  prior.lineage.needsConfirmation = false;
  Object.defineProperty(prior.item, 'quote', { get() { throw new Error('obsolete quote read'); } });
  Object.defineProperty(prior.item, 'text', { get() { throw new Error('obsolete text read'); } });
  expect(comparisonBaseline(prior)).toEqual({ text: 'new verified evidence', quote: 'new verified evidence' });
  const paragraph = 'old display words now refer to another unrelated item';
  expect(matchSuccessors(paragraph, [prior], [item('wrong', 'old display words')], { a: unchanged }).size).toBe(0);
  const present = 'Here are new verified evidence in the paragraph';
  expect([...matchSuccessors(present, [prior], [item('right', 'new verified evidence')], { a: unchanged })])
    .toEqual([['a', 'right']]);
});
it('marks every lineage with contested changed evidence, regardless of extracted items', () => {
  const paragraph = 'The combined plan is operational.';
  const previous = [old('owner', 'The older hosting method'), old('other', 'The earlier payment method')];
  const decision = changed('The combined plan is operational');
  for (const next of [[], [item('new', 'The combined plan is operational')]]) {
    const result = assignmentsWithConflicts(paragraph, previous, next, { owner: decision, other: decision });
    expect([...result.assignments]).toEqual([]);
    expect([...result.conflicts].sort()).toEqual(['other', 'owner']);
  }
});
it('produces the same conflict outcome across lineage and decision-order permutations', () => {
  const paragraph = 'The combined plan is operational. Another distinct claim remains intact.';
  const previous = [old('a', 'Old hosting'), old('b', 'Old payments'),
    old('c', 'Another distinct claim remains intact')];
  const next = [item('new', 'The combined plan is operational'), item('keep', 'Another distinct claim remains intact')];
  const entries: Array<[string, Decision]> = [['a', changed('The combined plan is operational')],
    ['b', changed('The combined plan is operational')], ['c', unchanged]];
  const permutations = <T,>(values: T[]): T[][] => values.length < 2 ? [values] :
    values.flatMap((value, index) => permutations(values.filter((_, i) => i !== index))
      .map(rest => [value, ...rest]));
  for (const prior of permutations(previous)) for (const ordered of permutations(entries)) {
    const before = JSON.stringify({ prior, ordered, next });
    const result = assignmentsWithConflicts(paragraph, prior, next, Object.fromEntries(ordered));
    expect([...result.conflicts].sort()).toEqual(['a', 'b']);
    expect([...result.assignments].sort()).toEqual([['c', 'keep']]);
    expect(JSON.stringify({ prior, ordered, next })).toBe(before);
  }
});
it('ranks eligible matches globally, then breaks equal scores by old order', () => {
  const paragraph = 'abcd efgh';
  const prior = [old('a', 'abcd'), old('b', 'bc')];
  const candidates = [item('long', 'abcd efgh'), item('short', 'abcd')];
  expect([...matchSuccessors(paragraph, prior, candidates, { a: unchanged, b: unchanged })])
    .toEqual([['a', 'long'], ['b', 'short']]);
});
