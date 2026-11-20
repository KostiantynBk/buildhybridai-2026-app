import type { Paragraph } from './matcher';

export type OpeningBasis = { id: string; version: number; order: number };
export function firstParagraph(paragraphs: readonly Paragraph[]): Paragraph | undefined {
  return [...paragraphs].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))[0];
}
export function openingMatches(basis: OpeningBasis | undefined, paragraphs: readonly Paragraph[],
  required = false): boolean {
  if (!basis) return !required;
  const first = firstParagraph(paragraphs);
  return !!first && first.id === basis.id && first.version === basis.version && first.order === basis.order;
}
export function sentenceBoundedOpening(text: string, limit = 120): string {
  const normalized = text.trim().replace(/\s+/g, ' ');
  let lastEnd = 0;
  for (const end of normalized.matchAll(/[.!?](?:["'”’)]*)?(?=\s|$)/g)) {
    if (end.index === undefined) continue;
    const atPunctuation = normalized.slice(0, end.index + 1);
    if (end[0][0] === '.' && (normalized[end.index - 1] === '.' || normalized[end.index - 1] === '…' ||
      /\b(?:dr|mr|mrs|ms|st|prof|sr|jr|inc|ltd|vs|etc|no)\.$/i.test(atPunctuation) ||
      /(?:^|[^\p{L}\p{N}])[A-Z]\.$/u.test(atPunctuation) || /\b(?:[a-z]\.){2,}$/i.test(atPunctuation))) continue;
    const position = end.index + end[0].length;
    if (normalized.slice(0, position).split(/\s+/).filter(Boolean).length > limit) break;
    lastEnd = position;
  }
  return normalized.slice(0, lastEnd);
}
