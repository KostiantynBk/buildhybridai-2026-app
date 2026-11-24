import type { Snapshot } from '../store';
import { lineageHeads } from '../store/lineage';
import { lineageEligibility } from '../store/eligibility';
import { isHeadingBlock, paragraphLabel } from '../structure/planStructure';
import type { DisplayAngle } from '../pipeline/selectConcerns';

export const angleLabels: Record<DisplayAngle, string> = { 'end-user': 'For the user',
  'cost-at-scale': 'Costs at scale', 'limits-operations': 'Limits and operations',
  'security-privacy': 'Security and privacy', alternatives: 'Alternatives', 'track-record': 'From your experience' };

export function hasCurrentStatements(snapshot: Snapshot): boolean {
  return snapshot.paragraphs.some(paragraph => !isHeadingBlock(paragraph.text) && snapshot.items.some(item =>
    item.status === 'current' && item.paragraphId === paragraph.id && item.paragraphVersion === paragraph.version));
}

/** Existing marks, in notebook paragraph and statement order; no new scoring. */
export function eligibleMarks(snapshot: Snapshot) {
  const heads = lineageHeads(snapshot.lineages ?? []);
  return [...snapshot.paragraphs].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .filter(p => !isHeadingBlock(p.text)).flatMap(paragraph =>
    snapshot.items.filter(item => item.status === 'current' && item.paragraphId === paragraph.id &&
      item.paragraphVersion === paragraph.version).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) ||
        a.id.localeCompare(b.id)).flatMap(item => {
      const head = heads.find(value => value.itemId === item.id);
      if (!head || lineageEligibility(head.lineageId, head.version, snapshot.paragraphs,
        snapshot.lineages ?? [], snapshot.jobs) !== 'eligible') return [];
      const mark = (snapshot.cards ?? []).find(card => card.itemLineageId === head.lineageId &&
        card.itemVersion === head.version && card.questionStatus === 'marked' && !card.supersededMark && card.angle);
      return mark ? [{ item, mark, label: paragraphLabel(paragraph, snapshot.paragraphs) }] : [];
    }));
}
