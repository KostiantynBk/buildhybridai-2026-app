export type CheckFocusRequest = { cardId: string; trigger: Element | null };

/** Focus only an explicitly requested card, and only if the user has not moved focus elsewhere. */
export function focusCheck(request: CheckFocusRequest, doc: Document, prefix: string): boolean {
  const target = doc.getElementById(`check-card-${prefix}-${request.cardId}`);
  if (!target) return false;
  if (doc.activeElement !== request.trigger && doc.activeElement !== doc.body) return true;
  if (target.closest?.('[inert], [hidden]')) return false;
  target.scrollIntoView?.({ block: 'nearest' });
  target.focus();
  return true;
}
