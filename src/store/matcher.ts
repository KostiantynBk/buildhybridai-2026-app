export interface Paragraph {
  id: string;
  projectId: string;
  order: number;
  text: string;
  version: number;
  updatedAt: number;
}
export const PARAGRAPH_MATCH_THRESHOLD = 0.55;
export function splitParagraphs(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split(/\n[\t ]*\n+/).map(part => part.trim()).filter(Boolean);
}
function tokens(text: string): Set<string> {
  return new Set(text.toLocaleLowerCase('en').match(/[\p{L}\p{N}]+/gu) ?? []);
}
export function overlap(a: string, b: string): number {
  const left = tokens(a);
  const right = tokens(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  return (2 * shared) / (left.size + right.size);
}
export function matchParagraphs(
  old: Paragraph[], text: string, now: number, newId: () => string,
): Paragraph[] {
  const previous = [...old].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const parts = splitParagraphs(text);
  const matches = new Map<number, number>();
  const used = new Set<number>();
  parts.forEach((part, index) => {
    const oldIndex = previous.findIndex((p, i) => !used.has(i) && p.text === part);
    if (oldIndex >= 0) { matches.set(index, oldIndex); used.add(oldIndex); }
  });
  const candidates: { oldIndex: number; index: number; score: number }[] = [];
  parts.forEach((part, index) => {
    if (matches.has(index)) return;
    previous.forEach((p, oldIndex) => {
      if (used.has(oldIndex)) return;
      const score = overlap(p.text, part);
      if (score >= PARAGRAPH_MATCH_THRESHOLD) candidates.push({ index, oldIndex, score });
    });
  });
  candidates.sort((a, b) => b.score - a.score ||
    Math.abs(a.oldIndex - a.index) - Math.abs(b.oldIndex - b.index) ||
    a.oldIndex - b.oldIndex || a.index - b.index);
  for (const candidate of candidates) {
    if (matches.has(candidate.index) || used.has(candidate.oldIndex)) continue;
    matches.set(candidate.index, candidate.oldIndex);
    used.add(candidate.oldIndex);
  }
  return parts.map((part, order) => {
    const oldIndex = matches.get(order);
    if (oldIndex === undefined) return { id: newId(), projectId: 'default', order, text: part,
      version: 1, updatedAt: now };
    const oldParagraph = previous[oldIndex];
    return { ...oldParagraph, order, text: part,
      version: oldParagraph.version + (oldParagraph.text === part ? 0 : 1),
      updatedAt: oldParagraph.text === part ? oldParagraph.updatedAt : now };
  });
}
