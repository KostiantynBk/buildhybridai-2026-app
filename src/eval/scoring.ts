import { normalizeQuote, type Item } from '../pipeline/extract';

export type Expected = { kind: string; span: string; topics: readonly string[] };
export type ScoredRow = {
  noteId: string;
  schemaValid: boolean;
  source?: string | null;
  items: Item[];
  beforeDrop: number;
  quoteExact: number;
};
export type LabelledNote = { id: string; text: string; expected: readonly Expected[] };
function occurrences(text: string, part: string): number[] {
  if (!part) return [];
  const result: number[] = [];
  for (let pos = text.indexOf(part); pos >= 0; pos = text.indexOf(part, pos + 1)) result.push(pos);
  return result;
}
// Normalize case and whitespace and choose the best pair of occurrences in the same paragraph.
export function overlaps(text: string, quote: string, span: string): boolean {
  const body = normalizeQuote(text);
  const a = normalizeQuote(quote);
  const b = normalizeQuote(span);
  for (const x of occurrences(body, a)) {
    for (const y of occurrences(body, b)) {
      const shared = Math.max(0, Math.min(x + a.length, y + b.length) - Math.max(x, y));
      if (shared >= 0.5 * Math.min(a.length, b.length)) return true;
    }
  }
  return false;
}
export type Counts = {
  calls: number;
  onDevice: number;
  sourceUnknown: number;
  otherSource: number;
  schemaValid: number;
  quoteExact: number;
  quoteTotal: number;
  expectedMatched: number;
  expectedTotal: number;
  extractedMatched: number;
  extractedTotal: number;
  topicsMatched: number;
  topicTotal: number;
  restraintPassed: number;
  restraintTotal: number;
};
const empty = (): Counts => ({
  calls: 0,
  onDevice: 0,
  sourceUnknown: 0,
  otherSource: 0,
  schemaValid: 0,
  quoteExact: 0,
  quoteTotal: 0,
  expectedMatched: 0,
  expectedTotal: 0,
  extractedMatched: 0,
  extractedTotal: 0,
  topicsMatched: 0,
  topicTotal: 0,
  restraintPassed: 0,
  restraintTotal: 0,
});
const fraction = (n: number, d: number): number | null => (d ? n / d : null);
export function summarize(rows: ScoredRow[], notes: readonly LabelledNote[]) {
  const counts = empty();
  const perNote: Record<string, Counts> = {};
  for (const row of rows) {
    const note = notes.find((n) => n.id === row.noteId);
    if (!note) continue;
    const target = (perNote[note.id] ??= empty());
    for (const c of [counts, target]) {
      c.calls++;
      if (row.source === 'on_device') c.onDevice++;
      else if (!row.source || row.source === 'not reported') c.sourceUnknown++;
      else c.otherSource++;
      c.schemaValid += Number(row.schemaValid);
      c.quoteExact += row.quoteExact;
      c.quoteTotal += row.beforeDrop;
      c.expectedTotal += note.expected.length;
      c.extractedTotal += row.items.length;
      c.expectedMatched += note.expected.filter((label) =>
        row.items.some((item) => overlaps(note.text, item.quote, label.span)),
      ).length;
      for (const item of row.items) {
        const matches = note.expected.filter((label) =>
          overlaps(note.text, item.quote, label.span),
        );
        if (matches.length) {
          c.extractedMatched++;
          c.topicTotal++;
          if (matches.some((label) => item.topics.some((topic) => label.topics.includes(topic))))
            c.topicsMatched++;
        }
      }
      if (!note.expected.length) {
        c.restraintTotal++;
        if (row.schemaValid && !row.items.length) c.restraintPassed++;
      }
    }
  }
  const rates = (c: Counts) => ({
    onDevice: fraction(c.onDevice, c.calls),
    schemaValid: fraction(c.schemaValid, c.calls),
    quoteExact: fraction(c.quoteExact, c.quoteTotal),
    recall: fraction(c.expectedMatched, c.expectedTotal),
    precision: fraction(c.extractedMatched, c.extractedTotal),
    topicAgreement: fraction(c.topicsMatched, c.topicTotal),
    restraint: fraction(c.restraintPassed, c.restraintTotal),
  });
  return {
    counts,
    rates: rates(counts),
    perNote: Object.fromEntries(
      Object.entries(perNote).map(([id, c]) => [id, { counts: c, rates: rates(c) }]),
    ),
  };
}
