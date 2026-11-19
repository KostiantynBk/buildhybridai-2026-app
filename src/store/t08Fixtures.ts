import type { LocalStore } from './index';

// Test-only helper: mimic the user's explicit Check this action on a selected mark.
export async function checkFirstMark(store: LocalStore): Promise<string> {
  const snapshot = await store.snapshot();
  const mark = snapshot.cards?.find(card => card.questionStatus === 'marked' && !card.supersededMark);
  const item = snapshot.items.find(value => value.status === 'current' && value.lineageId === mark?.itemLineageId);
  if (!mark || !item) throw new Error('Expected a current marked statement');
  const result = await store.requestCheck(item.id, 0);
  if (!result.cardId) throw new Error(result.reason ?? 'Could not check the marked statement');
  return result.cardId;
}
