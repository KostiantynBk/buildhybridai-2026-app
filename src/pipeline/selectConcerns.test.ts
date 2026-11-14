import { describe, expect, it } from 'vitest';
import type { ProfileRecord } from '../store';
import { selectConcerns, unfamiliarity, type Concern, type SelectionItem } from './selectConcerns';

const skill = (id: string, depth: ProfileRecord['depth'], topics: string[]): ProfileRecord => ({
  id, type: 'skill', text: id, depth, topics, tags: [], updatedAt: 0,
});
const lesson = (id: string, topics: string[]): ProfileRecord => ({ id, type: 'lesson', text: id, topics,
  tags: [], updatedAt: 0 });
const item = (id: string, topics: string[], quote = 'a quoted statement'): SelectionItem => ({
  lineageId: id, version: 1, kind: 'assumption', quote, topics,
});
const concern = (itemNumber: number, angle: Concern['angle'] = 'end-user', checkable = true): Concern => ({
  item: itemNumber, angle, concern: 'A relevant question.', checkable,
});
const run = (items: SelectionItem[], concerns: Concern[], profile: ProfileRecord[] = [], extra = {}) =>
  selectConcerns({ paragraph: 'A quoted statement in the plan.', items, concerns, profile, used: [], angleCounts: {},
    ...extra });
describe('selection rule', () => {
  it.each([
    ['new', 2], ['some', 1], ['deep', 0],
  ] as const)('maps %s skill depth to %s', (depth, score) => {
    expect(unfamiliarity(['payments'], [skill('s', depth, ['payments'])])).toBe(score);
  });
  it('uses no-skill=1, strongest skill per topic, and the maximum topic score', () => {
    expect(unfamiliarity(['payments'], [])).toBe(1);
    expect(unfamiliarity([], [])).toBe(1);
    expect(unfamiliarity(['frontend', 'payments'], [skill('front', 'deep', ['frontend']),
      skill('payments', 'new', ['payments'])])).toBe(2);
    expect(unfamiliarity(['payments'], [skill('new', 'new', ['payments']), skill('strong', 'deep', ['payments'])]))
      .toBe(0);
    expect(unfamiliarity(['payments'], [skill('new', 'new', ['payments']), skill('some', 'some', ['payments'])]))
      .toBe(1);
  });
  it('checks every pair of skill depths on two topics against the strongest-per-topic rule', () => {
    const depths = ['new', 'some', 'deep'] as const;
    const score = { new: 2, some: 1, deep: 0 } as const;
    for (const a of depths) for (const b of depths) for (const c of depths) for (const d of depths) {
      const profile = [skill('a', a, ['frontend']), skill('b', b, ['frontend']),
        skill('c', c, ['payments']), skill('d', d, ['payments'])];
      expect(unfamiliarity(['frontend', 'payments'], profile))
        .toBe(Math.max(Math.min(score[a], score[b]), Math.min(score[c], score[d])));
    }
  });
  it('adds exactly one lesson bonus, labels track-record and picks a stable lesson ID', () => {
    const result = run([item('a', ['hosting'])], [concern(1)], [skill('s', 'deep', ['hosting']),
      lesson('l2', ['hosting']), lesson('l1', ['hosting'])]);
    expect(result.picked[0]).toMatchObject({ score: 1, angle: 'track-record', lessonId: 'l1', brief: false });
  });
  it('chooses the triggering lesson by most shared topics before ID', () => {
    const result = run([item('a', ['hosting', 'payments'])], [concern(1)],
      [lesson('a', ['hosting']), lesson('z', ['hosting', 'payments'])]);
    expect(result.picked[0].lessonId).toBe('z');
  });
  it('requires valid numbered, eligible and quote-verified items and holds non-checkable concerns', () => {
    const items = [item('a', ['hosting']), { ...item('b', ['hosting']), kind: 'open-question' },
      item('c', ['hosting'], 'not in the paragraph')];
    const result = run(items, [concern(0), concern(2), concern(3), concern(1, 'end-user', false)]);
    expect(result.picked).toHaveLength(0);
    expect(result.held.map(value => value.reason))
      .toEqual(['invalid-item', 'invalid-item', 'unverified-quote', 'only-you']);
  });
  it('honors repeats by lineage, version and effective angle, including duplicates within the same batch', () => {
    const items = [item('a', ['hosting']), { ...item('a', ['hosting']), version: 2 }];
    const result = run(items, [concern(1), concern(2), concern(2)], [],
      { used: [{ lineageId: 'a', version: 1, angle: 'end-user' }] });
    expect(result.picked.map(value => value.item.version)).toEqual([2]);
    expect(result.held.map(value => value.reason)).toEqual(['repeat', 'repeat']);
  });
  it('does not repeat a source angle when a changed profile relabels it track-record', () => {
    const result = run([item('a', ['hosting'])], [concern(1, 'end-user')], [lesson('lesson', ['hosting'])],
      { used: [{ lineageId: 'a', version: 1, angle: 'end-user' }] });
    expect(result.picked).toHaveLength(0);
    expect(result.held[0].reason).toBe('repeat');
  });
  it('holds cross-version quote overlaps only for matching source or effective angles', () => {
    const items = [item('a', ['hosting'], 'quoted statement'), item('b', ['payments'], 'in the plan')];
    const concerns = [concern(1, 'end-user'), concern(2, 'alternatives')];
    const baseline = run(items, concerns);
    expect(baseline.picked).toHaveLength(2);
    const priorLiveCards = [{ quote: 'A quoted statement', angle: 'end-user', sourceAngle: 'end-user' }];
    const filtered = run(items, concerns, [], { priorLiveCards });
    expect(filtered.held).toEqual([expect.objectContaining({ modelOrder: 0, reason: 'repeat' })]);
    expect(filtered.picked.map(value => value.modelOrder)).toEqual([1]);
    const effective = run([items[0]], [concern(1, 'alternatives')], [lesson('l', ['hosting'])],
      { priorLiveCards: [{ quote: 'A quoted statement', angle: 'track-record', sourceAngle: 'end-user' }] });
    expect(effective.held[0].reason).toBe('repeat');
    expect(run(items, concerns)).toEqual(baseline);
    const sameVersion = run([item('x', ['hosting'], 'A quoted statement'),
      item('y', ['hosting'], 'quoted statement')], [concern(1), concern(2)]);
    expect(sameVersion.picked.map(value => value.modelOrder)).toEqual([0, 1]);
  });
  it('shows at most one track-record card per item version even across different source angles', () => {
    const result = run([item('a', ['hosting'])], [concern(1, 'end-user'), concern(1, 'alternatives')],
      [lesson('lesson', ['hosting'])]);
    expect(result.picked).toHaveLength(1);
    expect(result.picked[0].angle).toBe('track-record');
    expect(result.held[0].reason).toBe('repeat');
  });
  it('orders by score, least-used effective angle, then model order and updates counts between picks', () => {
    const items = [item('a', ['hosting']), item('b', ['payments']), item('c', ['hosting'])];
    const result = run(items, [concern(1, 'end-user'), concern(2, 'cost-at-scale'),
      concern(3, 'security-privacy')], [skill('new', 'new', ['payments'])],
    { angleCounts: { 'end-user': 3, 'cost-at-scale': 4, 'security-privacy': 0 } });
    expect(result.picked.map(value => value.item.lineageId)).toEqual(['b', 'c']);
    expect(result.held[0]).toMatchObject({ modelOrder: 0, reason: 'over-limit' });
    const ties = run([item('a', ['hosting']), item('b', ['hosting']), item('c', ['hosting'])],
      [concern(1, 'end-user'), concern(2, 'end-user'), concern(3, 'alternatives')]);
    expect(ties.picked.map(value => value.modelOrder)).toEqual([0, 2]);
  });
  it('caps two per paragraph, counts existing cards, and marks zero score as a brief mention', () => {
    const profile = [skill('deep', 'deep', ['hosting'])];
    const result = run([item('a', ['hosting']), item('b', ['hosting'])],
      [concern(1), concern(2, 'alternatives')], profile, { alreadyShown: 1 });
    expect(result.picked).toHaveLength(1);
    expect(result.picked[0]).toMatchObject({ score: 0, brief: true });
    expect(result.held[0].reason).toBe('over-limit');
    expect(run([item('a', ['hosting'])], [concern(1)], profile, { alreadyShown: 2 }).picked).toHaveLength(0);
  });
});
