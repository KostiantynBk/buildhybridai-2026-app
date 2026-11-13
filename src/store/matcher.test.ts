import { describe, expect, it } from 'vitest';
import { matchParagraphs, overlap, type Paragraph } from './matcher';

const initial = (text: string) => {
  let counter = 0;
  const generate = () => `p${++counter}`;
  const old = matchParagraphs([], text, 100, generate);
  return { old, update: (next: string) => matchParagraphs(old, next, 200, generate) };
};
const ids = (paragraphs: Paragraph[]) => paragraphs.map(p => p.id);
describe('deterministic paragraph matching', () => {
  it('keeps ids on insert, delete and moves', () => {
    const { old, update } = initial('alpha beta gamma\n\ndelta epsilon zeta\n\nother red blue');
    expect(ids(update('inserted fresh text\n\nalpha beta gamma\n\ndelta epsilon zeta\n\nother red blue')))
      .toEqual(['p4', ...ids(old)]);
    expect(ids(update('other red blue\n\nalpha beta gamma'))).toEqual(['p3', 'p1']);
  });
  it('increments only the matched edit and preserves timestamps across moves', () => {
    const { update } = initial('one two three four\n\nfive six seven eight');
    const result = update('five six seven eight\n\none two three changed');
    expect(ids(result)).toEqual(['p2', 'p1']);
    expect(result.map(p => p.version)).toEqual([1, 2]);
    expect(result.map(p => p.updatedAt)).toEqual([100, 200]);
  });
  it('assigns one existing identity at most when splitting, and one on merging', () => {
    const split = initial('alpha beta gamma delta epsilon zeta');
    const pieces = split.update('alpha beta gamma\n\ndelta epsilon zeta');
    expect(pieces.filter(p => p.id === 'p1')).toHaveLength(1);
    expect(new Set(ids(pieces)).size).toBe(2);
    const merge = initial('alpha beta gamma\n\ndelta epsilon zeta');
    const joined = merge.update('alpha beta gamma delta epsilon zeta');
    expect(['p1', 'p2']).toContain(joined[0].id);
    expect(joined[0].version).toBe(2);
  });
  it('treats boundary whitespace as unchanged but internal whitespace as an edit', () => {
    const { update } = initial('one two three four');
    expect(update('  one two three four  ')[0]).toMatchObject({ id: 'p1', version: 1, updatedAt: 100 });
    expect(update('one  two three four')[0]).toMatchObject({ id: 'p1', version: 2, updatedAt: 200 });
    expect(overlap('one two', 'one  two')).toBe(1);
  });
  it('handles duplicates deterministically and leaves unrelated content new', () => {
    const { update } = initial('same exact text\n\nsame exact text');
    expect(ids(update('same exact text\n\nsame exact text'))).toEqual(['p1', 'p2']);
    expect(ids(update('unrelated zebra ocean'))).toEqual(['p3']);
  });
});
