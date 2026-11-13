import { overlaps } from '../eval/scoring';
import { overlapRatio } from '../pipeline/overlap';
import type { StoredItem, LineageVersion } from './index';
import type { Comparison } from '../pipeline/compare';

export type Decision = Pick<Comparison, 'status' | 'newQuote' | 'newQuoteFound' | 'needsConfirmation'> |
  { status: 'unchecked'; reason: string };
export type PriorLineage = { lineage: LineageVersion; item: StoredItem };
export function comparisonBaseline(prior: PriorLineage): { text: string; quote: string } {
  const evidence = prior.lineage.newQuote;
  return evidence ? { text: evidence, quote: evidence } : { text: prior.item.text, quote: prior.item.quote };
}
export function lineageHeads(versions: LineageVersion[]): LineageVersion[] {
  const heads = new Map<string, LineageVersion>();
  for (const version of versions) {
    const previous = heads.get(version.lineageId);
    if (!previous || version.version > previous.version) heads.set(version.lineageId, version);
  }
  return [...heads.values()];
}
export function matchSuccessors(paragraph: string, old: PriorLineage[], candidates: StoredItem[],
  decisions: Record<string, Decision>): Map<string, string> {
  const edges: { oldIndex: number; newIndex: number; score: number }[] = [];
  old.forEach((prior, oldIndex) => {
    const decision = decisions[prior.lineage.lineageId];
    if (!decision || decision.status === 'removed' || decision.status === 'unchecked') return;
    const quote = decision.status === 'unchanged' ? comparisonBaseline(prior).quote
      : decision.newQuoteFound ? decision.newQuote : '';
    if (!quote) return;
    candidates.forEach((candidate, newIndex) => {
      if (!overlaps(paragraph, quote, candidate.quote)) return;
      edges.push({ oldIndex, newIndex, score: overlapRatio(paragraph, quote, candidate.quote) });
    });
  });
  edges.sort((a, b) => b.score - a.score || a.oldIndex - b.oldIndex || a.newIndex - b.newIndex);
  const assigned = new Map<string, string>();
  const used = new Set<number>();
  for (const edge of edges) {
    const lineageId = old[edge.oldIndex].lineage.lineageId;
    if (assigned.has(lineageId) || used.has(edge.newIndex)) continue;
    assigned.set(lineageId, candidates[edge.newIndex].id);
    used.add(edge.newIndex);
  }
  return assigned;
}

export function assignmentsWithConflicts(paragraph: string, old: PriorLineage[], candidates: StoredItem[],
  decisions: Record<string, Decision>): { assignments: Map<string, string>; conflicts: Set<string> } {
  const conflicts = new Set<string>();
  const changed = old.flatMap(prior => {
    const decision = decisions[prior.lineage.lineageId];
    return decision?.status === 'changed' && decision.newQuoteFound
      ? [{ id: prior.lineage.lineageId, quote: decision.newQuote }] : [];
  });
  for (const entry of changed) {
    if (old.some(other => other.lineage.lineageId !== entry.id &&
      overlaps(paragraph, entry.quote, comparisonBaseline(other).quote))) conflicts.add(entry.id);
  }
  for (let i = 0; i < changed.length; i++) {
    for (let j = i + 1; j < changed.length; j++) {
      if (overlaps(paragraph, changed[i].quote, changed[j].quote)) {
        conflicts.add(changed[i].id);
        conflicts.add(changed[j].id);
      }
    }
  }
  const eligible = { ...decisions };
  for (const id of conflicts) {
    const decision = eligible[id];
    if (decision?.status === 'changed') eligible[id] = { ...decision, newQuoteFound: false };
  }
  return { assignments: matchSuccessors(paragraph, old, candidates, eligible), conflicts };
}
