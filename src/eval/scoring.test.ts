import { describe, expect, it } from 'vitest';
import { latencySummary, median, quantile } from './runner';
import { overlaps, summarize } from './scoring';

const notes = [
  {
    id: 'a',
    text: 'The plan uses a quiet server today.',
    expected: [
      { kind: 'decision', span: 'uses a quiet server', topics: ['hosting'] },
      { kind: 'assumption', span: 'quiet server today', topics: ['performance'] },
    ],
  },
  { id: 'b', text: 'Maybe draw a circle.', expected: [] },
];
const item = {
  kind: 'decision',
  text: 'server',
  quote: 'uses a quiet server',
  topics: ['hosting'],
};

describe('scoring', () => {
  it('uses at least half of the shorter span, within the same normalized paragraph', () => {
    expect(overlaps(notes[0].text, 'uses a quiet server', 'quiet server today')).toBe(true);
    expect(overlaps('red blue green', 'red blue', 'blue green')).toBe(true);
    expect(overlaps('one two three four', 'one two', 'three four')).toBe(false);
    expect(overlaps('one', '', 'one')).toBe(false);
  });
  it('counts recall, precision, topic agreement and restraint and retains null denominators', () => {
    const summary = summarize(
      [
        { noteId: 'a', schemaValid: true, items: [item], beforeDrop: 2, quoteExact: 1 },
        { noteId: 'b', schemaValid: true, items: [], beforeDrop: 0, quoteExact: 0 },
        { noteId: 'b', schemaValid: false, items: [], beforeDrop: 0, quoteExact: 0 },
      ],
      notes,
    );
    expect(summary.counts.expectedMatched).toBe(2);
    expect(summary.rates.precision).toBe(1);
    expect(summary.rates.recall).toBe(1);
    expect(summary.rates.quoteExact).toBe(0.5);
    expect(summary.rates.topicAgreement).toBe(1);
    expect(summary.counts.restraintPassed).toBe(1);
    expect(summary.counts.restraintTotal).toBe(2);
    expect(summary.perNote.b.rates.precision).toBeNull();
  });
  it('uses explicit nearest-rank percentiles', () => {
    expect(quantile([10, 1, 5, 3, 2], 0.5)).toBe(3);
    expect(quantile([10, 1, 5, 3, 2], 0.95)).toBe(10);
    expect(median([1, 3, 5, 9])).toBe(4);
    expect(latencySummary([]).sizes[0].medianMs).toBeNull();
  });
});
