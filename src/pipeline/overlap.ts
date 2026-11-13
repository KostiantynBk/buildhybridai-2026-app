import { normalizeQuote } from './extract';

// Mirrors the frozen D-019 occurrence calculation, but returns the best ratio for ranking only.
export function overlapRatio(text: string, quote: string, span: string): number {
  const body = normalizeQuote(text);
  const a = normalizeQuote(quote);
  const b = normalizeQuote(span);
  if (!a || !b) return 0;
  let best = 0;
  for (let x = body.indexOf(a); x >= 0; x = body.indexOf(a, x + 1)) {
    for (let y = body.indexOf(b); y >= 0; y = body.indexOf(b, y + 1)) {
      const shared = Math.max(0, Math.min(x + a.length, y + b.length) - Math.max(x, y));
      best = Math.max(best, shared / Math.min(a.length, b.length));
    }
  }
  return best;
}
