import { useEffect, useState } from 'react';
import type { IdeaRecord, Snapshot } from '../store';
import { lineageHeads } from '../store/lineage';
import { lineageEligibility } from '../store/eligibility';
import { openingMatches } from '../store/ideaBasis';
import type { ResearchView } from '../ai/researchFlow';
import { IDEA_DRAFT_HINT } from '../pipeline/describeIdea';
import { ResearchBlock } from './ResearchBlock';
import { isGrounded } from '../ai/suggestionsSafety';
import { researchFailureMessage } from '../ai/researchFailure';
import { copy, displayMessage } from './copy';
import { dedupeKeptOut, findPlanNames } from './planNames';
import { isHeadingBlock } from '../structure/planStructure';
import { useAutoGrow } from './useAutoGrow';
import { NameWarning, useNameDismissals } from './NameWarning';

export function IdeaPanel({ snapshot, idea, view, start, send, retry, decline, searching = false,
  checkingSend = false, busy = false, planTexts }: {
  snapshot: Snapshot; idea?: IdeaRecord; view?: ResearchView; busy?: boolean; searching?: boolean;
  checkingSend?: boolean; planTexts?: readonly string[];
  start(): Promise<void>; send(id: string, text: string): Promise<void>; retry(id: string): Promise<void>;
  decline(id: string): Promise<void>;
}) {
  const [text, setText] = useState(idea?.draft ?? '');
  const dismissals = useNameDismissals(text, idea?.id ?? '');
  const textarea = useAutoGrow(text, `${idea?.id ?? ''}:${snapshot.jobs.find(job =>
    job.key === idea?.describeJobKey)?.status ?? ''}`);
  const [message, setMessage] = useState('');
  const keptOut = dedupeKeptOut(idea?.keptOut ?? []);
  useEffect(() => { setText(idea?.draft ?? ''); }, [idea?.id, idea?.draft]);
  const heads = lineageHeads(snapshot.lineages ?? []);
  const kinds = ['decision', 'constraint', 'assumption', 'open-question'];
  const eligible = snapshot.items.filter(item => item.status === 'current' && kinds.includes(item.kind) &&
    snapshot.paragraphs.some(paragraph => paragraph.id === item.paragraphId && !isHeadingBlock(paragraph.text)) &&
    heads.some(head => head.itemId === item.id && lineageEligibility(head.lineageId, head.version,
      snapshot.paragraphs, snapshot.lineages ?? [], snapshot.jobs) === 'eligible'));
  const job = idea && snapshot.jobs.find(value => value.key === idea.describeJobKey);
  const entry = idea?.outboxId ? snapshot.outbox?.find(value => value.id === idea.outboxId) : undefined;
  const receipt = entry && [...(snapshot.researchReceipts ?? [])].filter(value => value.entryId === entry.id)
    .sort((a, b) => b.sentAt - a.sentAt)[0];
  const requiresOpening = idea?.describePromptVersion === 'describe.v2';
  const requiresEntry = !!idea && requiresOpening && (!!idea.outboxId ||
    ['approved', 'sent', 'failed', 'withdrawn'].includes(idea.status));
  const openingChanged = !!idea && requiresOpening &&
    (!openingMatches(idea.openingBasis, snapshot.paragraphs, true) ||
      (requiresEntry && (!entry || !openingMatches(entry.openingBasis, snapshot.paragraphs, true))));
  const drafting = !openingChanged && (job?.status === 'pending' || job?.status === 'running');
  const stale = openingChanged || (idea?.basis.some(basis => {
    const head = heads.find(value => value.lineageId === basis.lineageId);
    return !!head && !head.needsConfirmation && !head.unchecked &&
      (head.version > basis.version || head.status === 'removed');
  }) ?? false);
  const ungrounded = receipt?.status === 'completed' && receipt.failureCode === 'ungrounded' ||
    (!!view && !isGrounded(view.result));
  const basisStatuses = idea?.basis.map(basis => lineageEligibility(basis.lineageId, basis.version,
    snapshot.paragraphs, snapshot.lineages ?? [], snapshot.jobs)) ?? [];
  const cannotApprove = openingChanged || basisStatuses.some(status => status === 'stale' || status === 'terminal');
  const checking = basisStatuses.some(status => status === 'checking');
  const uncertain = basisStatuses.some(status => status === 'terminal' || status === 'stale');
  let names: string[] = [];
  let nameCheckFailed = false;
  if (idea?.status === 'ready' && job?.status === 'done' && !cannotApprove) {
    try { names = dismissals.remaining(findPlanNames(text, planTexts ?? snapshot.paragraphs.map(p => p.text))); }
    catch { nameCheckFailed = true; }
  }
  const act = (fn: () => Promise<void>) => { setMessage(''); void fn().catch(error => setMessage(
    error instanceof Error ? displayMessage(error.message) : 'Could not complete this action.')); };
  return <section className="panel idea-card" tabIndex={-1}><h2>Research this idea</h2>
    <button className="primary" disabled={busy || drafting || searching || checkingSend || eligible.length < 3}
      onClick={() => act(start)}>
      {view || stale || receipt?.status === 'completed' ? 'Research again' :
        job?.errorName === 'ModeChanged' ? 'Draft again' : 'Research this idea'}</button>
    {eligible.length < 3 && <p>Add at least three current statements first.</p>}
    <div role="status" aria-live="polite">
      {drafting && <p>{copy.draftDescription}</p>}
      {entry?.status !== 'withdrawn' && searching && <p>{copy.searching}</p>}
      {entry?.status !== 'withdrawn' && checkingSend && <p>{copy.checkingBeforeResearch}</p>}
      {entry?.status !== 'withdrawn' && (searching || checkingSend) && receipt?.status === 'completed' &&
        <p>Previous research completed.</p>}
      {entry?.status !== 'withdrawn' && (searching || checkingSend) && receipt?.status === 'failed' &&
        <p>Previous attempt failed: {
        researchFailureMessage(receipt.failureCode)}</p>}
      {(view || receipt?.status === 'completed' || openingChanged) && stale &&
        <p>{copy.definite} Research again.</p>}
      {view && !stale && uncertain && <p>{copy.uncertain} Research again.</p>}
      {view && !stale && !uncertain && checking && <p>Checking your latest change…</p>}
    </div>
    {idea?.status === 'ready' && (job?.status === 'failed' || job?.status === 'superseded') &&
      <p>{job.errorName === 'ModeChanged' ? copy.modeChanged : copy.draftUnavailable}</p>}
    {idea?.status === 'ready' && job?.status === 'done' && <>
      <label>Public description <textarea ref={textarea} className="draft-textarea" rows={3} value={text}
        onChange={event => setText(event.target.value)} /></label>
      {!idea.draft && <p>{IDEA_DRAFT_HINT}</p>}
      {keptOut.length > 0 && <p>Left out of the description: {keptOut.join(', ')}</p>}
      {cannotApprove && <p>{stale ? copy.definite : copy.uncertain} Draft again.</p>}
      {cannotApprove ? <button disabled={busy} onClick={() => act(start)}>Draft again</button> : <>
        {nameCheckFailed ? <p>Couldn't check this text for names from your plan. Review it before sending.</p> :
          names.length > 0 && <NameWarning names={names} dismiss={dismissals.dismiss} />}
        <button disabled={busy} onClick={() => act(() => send(idea.id, text))}>
          {nameCheckFailed || names.length > 0 ? 'Send anyway' : 'Send this description'}</button>
        <button disabled={busy} onClick={() => act(() => decline(idea.id))}>Don't send</button></>}
    </>}
    {entry?.status === 'withdrawn' && <p>Withdrawn: your plan or privacy settings changed. Draft again.</p>}
    {ungrounded && <p>{researchFailureMessage('ungrounded')}</p>}
    {entry?.status === 'approved' && receipt?.status === 'completed' && !view && !ungrounded &&
      <p>{copy.resultsNotSaved}</p>}
    {idea && entry?.status === 'approved' && receipt?.status !== 'completed' && !view && !searching &&
      (idea.status === 'approved' || idea.status === 'failed' || idea.status === 'sent') && <>
      {!checkingSend && <p>{receipt?.status === 'failed'
        ? `Sent, but the search failed: ${researchFailureMessage(receipt.failureCode)}` :
          receipt?.status === 'sent' ? copy.requestSent : copy.approvedNotSent}</p>}
      <button disabled={busy || stale || checkingSend} onClick={() => act(() => retry(idea.id))}>Try again</button></>}
    {view && !ungrounded && <section><ResearchBlock result={view.result} />
      <p>Combinations are the model's suggestions; check their sources.</p></section>}
    {message && entry?.status !== 'withdrawn' && !receipt && <p role="alert">{message}</p>}
  </section>;
}
