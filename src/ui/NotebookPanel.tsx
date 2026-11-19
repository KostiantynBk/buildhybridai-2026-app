import { useEffect, useState } from 'react';
import { MIN_WORDS, wordCount, type ProfileRecord, type Snapshot } from '../store';
import { fingerprintsMatch } from '../store/fingerprint';
import type { ThoughtCard } from '../store/triageTypes';
import { lineageHeads } from '../store/lineage';
import { containsQuote } from '../pipeline/compare';
import { calculateStaleness } from '../store/staleness';
import type { Feedback } from '../store/triageTypes';
import type { DisplayAngle } from '../pipeline/selectConcerns';
import type { ResearchView } from '../ai/researchFlow';
import { ResearchBlock } from './ResearchBlock';
import { isGrounded } from '../ai/suggestionsSafety';
import { lineageEligibility } from '../store/eligibility';
import { DraftControls } from './DraftControls';

const angleLabels: Record<DisplayAngle, string> = { 'end-user': 'For the user',
  'cost-at-scale': 'Costs at scale', 'limits-operations': 'Limits and operations',
  'security-privacy': 'Security and privacy', alternatives: 'Alternatives', 'track-record': 'From your experience' };

export function ProfileBlock({ card, profile }: { card: ThoughtCard; profile: ProfileRecord[] }) {
  if (card.triageVersion !== 'v2.1' || card.brief) return null;
  const records = (card.profileRecordIds ?? []).flatMap(id => {
    const record = profile.find(value => value.id === id);
    return record ? [record] : [];
  });
  return records.length ? <div><p>From your profile:</p><ul>{records.map(record =>
    <li key={record.id} style={{ whiteSpace: 'pre-wrap' }}>{record.text}</li>)}</ul></div> : null;
}
export function WhyContent({ card, profile }: { card: ThoughtCard; profile: ProfileRecord[] }) {
  if (!card.why) return null;
  const cited = card.triageVersion === 'v2' ? card.why.used.flatMap(id => {
    const record = profile.find(value => value.id === id);
    return record ? [record] : [];
  }) : [];
  return <><p>{card.why.seeing}{card.why.why ? ` ${card.why.why}` : ''}</p>
    {cited.length > 0 && <div><p>From your profile:</p><ul>{cited.map(record =>
      <li key={record.id} style={{ whiteSpace: 'pre-wrap' }}>{record.text}</li>)}</ul></div>}</>;
}
function FreshWhy({ card, profile }: { card: ThoughtCard; profile: ProfileRecord[] }) {
  const [checked, setChecked] = useState('');
  const signature = JSON.stringify([card.whyFingerprints, (card.whyFingerprints ?? []).map(fingerprint => {
    const record = profile.find(value => value.id === fingerprint.id);
    return record ? [record.id, record.type, record.text, record.depth, [...record.topics].sort()] : null;
  })]);
  useEffect(() => {
    let active = true;
    if (!card.whyFingerprints) { setChecked(''); return () => { active = false; }; }
    void fingerprintsMatch(card.whyFingerprints, profile).then(valid => {
      if (active) setChecked(valid ? signature : '');
    }).catch(() => { if (active) setChecked(''); });
    return () => { active = false; };
  }, [signature]);
  return card.why && checked === signature ? <WhyContent card={card} profile={profile} /> : null;
}
export function emptyReason(snapshot: Snapshot, configured: boolean, ready: boolean,
  cloudMode = false): string {
  if (!snapshot.paragraphs.length) return 'Start writing a plan to see what it relies on.';
  if (snapshot.paragraphs.every(p => wordCount(p.text) < MIN_WORDS)) {
    return `A paragraph needs at least ${MIN_WORDS} words before it can be checked.`;
  }
  if (!configured) return 'Waiting: Firebase is not configured. Your notebook stays local.';
  if (!ready) return cloudMode ? 'Cloud processing is disabled; cloud jobs are paused.' :
    'Waiting for the on-device model. Prepare the model to continue.';
  if (snapshot.jobs.some(job => job.step === 'extract' && job.status === 'failed' &&
      snapshot.paragraphs.some(p => p.id === job.paragraphId && p.version === job.paragraphVersion))) {
    return 'An extraction stopped after bounded retries.';
  }
  if (snapshot.jobs.some(job => job.status === 'pending' || job.status === 'running')) {
    return cloudMode ? 'Checking settled paragraphs in cloud mode.' : 'Checking settled paragraphs on device.';
  }
  if (snapshot.paragraphs.some(p => wordCount(p.text) >= MIN_WORDS && !snapshot.jobs.some(j =>
    j.paragraphId === p.id && j.paragraphVersion === p.version && j.status === 'done'))) {
    return 'Waiting for the paragraph to settle.';
  }
  return 'Nothing found in the current paragraphs.';
}
export function NotebookPanel({ text, save, storageStatus, snapshot, configured, ready, feedback, research,
  researchAgain, researchErrors, cloudMode = false, checkThis, sendDraft, declineDraft, reopenDraft }: {
  text: string; save: (value: string) => void; storageStatus: 'loading' | 'saving' | 'saved' | 'error';
  snapshot: Snapshot; configured: boolean; ready: boolean;
  feedback?: (cardId: string, value: Feedback) => void; research?: Record<string, ResearchView>;
  researchAgain?: (id: string) => Promise<void>; researchErrors?: Record<string, string>; cloudMode?: boolean;
  checkThis?: (itemId: string) => Promise<void>;
  sendDraft?: (cardId: string, text: string) => Promise<void>;
  declineDraft?: (cardId: string) => Promise<void>; reopenDraft?: (cardId: string) => Promise<void>;
}) {
  const [researchError, setResearchError] = useState('');
  const heads = lineageHeads(snapshot.lineages ?? []);
  const removed = heads.filter(lineage => lineage.status === 'removed' &&
    (!snapshot.paragraphs.some(p => p.id === lineage.paragraphId) || snapshot.paragraphs.some(p =>
      p.id === lineage.paragraphId && p.version === lineage.paragraphVersion)));
  const groups = snapshot.paragraphs.map(paragraph => ({ paragraph, items: snapshot.items.filter(item =>
    item.status === 'current' && item.paragraphId === paragraph.id && item.paragraphVersion === paragraph.version) }));
  const visibleGroups = storageStatus === 'saved' ? groups.filter(group => group.items.length > 0) : [];
  const unchecked = heads.filter(lineage => lineage.unchecked && !groups.some(group =>
    group.items.some(item => item.lineageId === lineage.lineageId)));
  const visibleCards = (snapshot.cards ?? []).filter(card => card.questionStatus !== 'marked' && !card.supersededMark);
  const currentExtractionFailed = storageStatus === 'saved' && snapshot.jobs.some(job => job.step === 'extract' &&
    job.status === 'failed' && snapshot.paragraphs.some(p => p.id === job.paragraphId &&
      p.version === job.paragraphVersion));
  const hasItems = visibleGroups.length > 0 || visibleCards.length > 0 || (storageStatus === 'saved' &&
    [...removed, ...unchecked].some(lineage => snapshot.items.some(item => item.id === lineage.itemId)));
  return (
    <div className="workspace">
      <section className="panel notebook">
        <div className="section-title"><div><span className="eyebrow">Your space</span><h2>Notebook</h2></div>
          <span className="muted">{storageStatus === 'saved' ? 'Saved in this browser' :
            storageStatus === 'saving' ? 'Saving…' : storageStatus === 'loading' ? 'Opening local storage…' :
              'Not saved'}</span></div>
        <p>Give your plan room to take shape. Separate paragraphs with a blank line.</p>
        <label htmlFor="notebook" className="sr-only">Your planning notebook</label>
        <textarea id="notebook" value={text} onChange={event => save(event.target.value)}
          disabled={storageStatus === 'loading'} placeholder="Start with the idea you are exploring…" />
        {storageStatus === 'error' && <p role="alert">Could not save in this browser. Your changes may be lost.</p>}
      </section>
      <aside className="panel thoughts"><span className="eyebrow">Alongside your work</span>
        <h2>What your plan relies on</h2>
        {currentExtractionFailed && <p role="status">An extraction stopped after bounded retries.</p>}
        {researchError && <p role="alert">{researchError}</p>}
        {!hasItems && !currentExtractionFailed && <div className="empty" role="status"><p>{storageStatus === 'saving'
          ? 'Saving changes before checking this plan.' : storageStatus === 'error'
            ? 'Cannot check unsaved changes.' : emptyReason(snapshot, configured, ready, cloudMode)}</p></div>}
        {visibleGroups.map(({ paragraph, items }) => <section key={paragraph.id}>
          <h3>Paragraph {paragraph.order + 1}</h3>
          {items.map(item => {
            const head = heads.find(lineage => lineage.lineageId === item.lineageId);
            const previous = snapshot.items.find(candidate => candidate.id === head?.changedFrom);
            const mark = (snapshot.cards ?? []).find(card => head?.itemId === item.id &&
              card.itemLineageId === item.lineageId && card.itemVersion === head.version &&
              card.questionStatus === 'marked' && !card.supersededMark &&
              lineageEligibility(card.itemLineageId, card.itemVersion, snapshot.paragraphs,
                snapshot.lineages ?? [], snapshot.jobs) === 'eligible');
            const source = snapshot.jobs.find(job => job.step === 'extract' && job.status === 'done' &&
              job.paragraphId === item.paragraphId && job.paragraphVersion === item.paragraphVersion)?.measuredSource;
            return <article className="item-card" key={item.id}>
              <div><strong>{item.kind}</strong>{source && <span className="muted"> · {
                source === 'in_cloud' ? 'in the cloud' : 'on device'}</span>}</div>
              <p>{item.text}</p><blockquote>“{item.quote}”</blockquote>
              {mark?.angle && <p>Worth checking · {angleLabels[mark.angle]}</p>}
              {checkThis && <button disabled={storageStatus !== 'saved'} onClick={() => {
                void checkThis(item.id).catch(error => setResearchError(error instanceof Error
                  ? error.message : 'Could not start this check.'));
              }}>Check this</button>}
              {head?.status === 'changed' && !head.needsConfirmation && head.paragraphVersion === paragraph.version &&
                <p>Changed: was “{previous?.text ?? 'earlier statement'}”</p>}
              {head?.needsConfirmation && <p>{head.conflictingEvidence
                ? 'May have changed or been removed; please check.' : 'May have changed; please confirm.'}</p>}
              {head?.needsConfirmation && !head.conflictingEvidence && head.newQuote &&
                containsQuote(paragraph.text, head.newQuote) && <p>Now: “{head.newQuote}”</p>}
              {head?.unchecked && <p>Change not checked; the earlier statement is retained.</p>}
            </article>;
          })}
        </section>)}
        {visibleCards.map(card => {
          const stale = calculateStaleness(card.id, snapshot.dependencies ?? [], snapshot.lineages ?? []);
          const outbox = snapshot.outbox?.find(entry => entry.id === card.outboxId);
          const paragraph = snapshot.paragraphs.find(value => value.id === card.paragraphId);
          const head = heads.find(value => value.lineageId === card.itemLineageId);
          const eligibility = lineageEligibility(card.itemLineageId, card.itemVersion, snapshot.paragraphs,
            snapshot.lineages ?? [], snapshot.jobs);
          const failedCheckVisible = card.recheckFailedVersion !== undefined && paragraph &&
            (paragraph.version === card.recheckFailedVersion || head?.paragraphVersion !== paragraph.version);
          const questionStatus = card.questionStatus === 'blocked' ? card.questionReason === 'private detail'
            ? 'question held back: private detail' : card.questionReason === 'stale'
              ? 'question unavailable: the statement changed' : card.questionReason === 'revalidation-failed'
                ? 'question unavailable: an earlier check stopped' : 'question unavailable after local error'
            : outbox?.status ?? 'preparing';
          const receipts = outbox ? (snapshot.researchReceipts ?? []).filter(value => value.entryId === outbox.id)
            .sort((a, b) => b.sentAt - a.sentAt) : [];
          const receipt = receipts.find(value => value.status === 'completed');
          const questionJob = snapshot.jobs.find(job => job.cardId === card.id && job.step === 'question' &&
            job.status === 'done' && job.measuredSource);
          const angleJob = questionJob && snapshot.jobs.find(job =>
            questionJob.key.startsWith(`${job.key}#question#`) && job.step === 'angles' &&
            job.measuredSource === questionJob.measuredSource && job.status === 'done');
          const extractJob = angleJob && snapshot.jobs.find(job => job.step === 'extract' &&
            job.paragraphId === angleJob.paragraphId && job.paragraphVersion === angleJob.paragraphVersion &&
            job.measuredSource === questionJob?.measuredSource && job.status === 'done');
          const cloudMeasured = !!receipt || !!(outbox && research?.[outbox.id]);
          const route = [extractJob && (extractJob.measuredSource === 'in_cloud' ? 'Read in the cloud' :
            'Read on this device'),
            outbox && (outbox.status === 'approved' || cloudMeasured) && 'Question approved by you',
            cloudMeasured && 'Researched in the cloud'].filter(Boolean).join(' · ');
          return <article className="item-card" key={card.id}>
            {route && <p className="muted">{route}</p>}
            {failedCheckVisible && <p role="status">May have changed: couldn't re-check your edit.</p>}
            {stale.stale && <p role="status">Depends on “{card.itemQuote}” — {stale.reasons.map(reason =>
              reason.kind === 'needsConfirmation' ? 'may have changed' :
                reason.kind === 'removed' ? 'no longer in your plan' : 'changed').join(', ')}</p>}
            {card.askedDirectly ? <p>You asked to check this</p> : card.angle &&
              <div><strong>{angleLabels[card.angle]}</strong></div>}
            <blockquote>“{card.itemQuote}”</blockquote>{card.concern && <p>{card.concern}</p>}
            {!card.askedDirectly && <><h4>Why this matters for you</h4>
              {card.triageVersion === 'v2.1' ? <ProfileBlock card={card} profile={snapshot.profile} /> :
                <FreshWhy card={card} profile={snapshot.profile} />}</>}
            {card.questionStatus === 'blocked' && <p>{questionStatus}</p>}
            {(eligibility === 'stale' || eligibility === 'terminal') && <p>Your plan changed. Check again.</p>}
            {(eligibility === 'stale' || eligibility === 'terminal') && checkThis &&
              <button disabled={!head?.itemId || head.status === 'removed'} onClick={() => {
                if (head?.itemId) void checkThis(head.itemId)
                  .catch(() => setResearchError('Could not check the changed statement.'));
              }}>Check again</button>}
            <DraftControls card={card} outbox={outbox} receiptStatus={receipts[0]?.status} send={sendDraft}
              failureCode={receipts[0]?.failureCode} researchError={outbox && researchErrors?.[outbox.id]}
              decline={declineDraft} reopen={reopenDraft}
              research={researchAgain} />
            {outbox && research?.[outbox.id] && <section><h4>What the research found</h4>
              {stale.stale && <p role="status">Your plan changed since this was researched.</p>}
              {!isGrounded(research[outbox.id].result) && <p>This answer used no web sources.</p>}
              {research[outbox.id].changedAfterSend && <p role="status">Your plan changed (or you added a
                never-send term) after this question was sent.</p>}
              <ResearchBlock result={research[outbox.id].result} />
              <button onClick={() => { void navigator.clipboard.writeText(research[outbox.id].result.text); }}>
                Copy</button></section>}
            {outbox && !research?.[outbox.id] && receipt && <div>
              <p>Researched on {new Date(receipt.sentAt).toLocaleDateString()}.
                Results aren't kept on this device.</p>
              {researchAgain && outbox.status === 'approved' && <button disabled={storageStatus !== 'saved'}
                onClick={() => { void researchAgain(outbox.id).then(() => setResearchError('')).catch(error =>
                  setResearchError(error instanceof Error ? error.message : 'Research could not be completed.')); }}>
                Research again</button>}
              {researchError && <p role="alert">{researchError}</p>}
            </div>}
            {feedback && <div><h4>Was this question useful?</h4>
              {(['useful', 'already knew', 'not relevant', 'wrong'] as Feedback[]).map(value =>
                <button key={value} aria-pressed={card.feedback === value}
                  onClick={() => feedback(card.id, value)}>{value}</button>)}</div>}
          </article>;
        })}
        {storageStatus === 'saved' && unchecked.map(lineage => {
          const item = snapshot.items.find(value => value.id === lineage.itemId);
          return item && <article className="item-card" key={lineage.lineageId}>
            <p>{item.text}</p><p>Change not checked; the earlier statement is retained.</p>
          </article>;
        })}
        {storageStatus === 'saved' && removed.map(lineage => {
          const item = snapshot.items.find(value => value.id === lineage.itemId);
          return item && <article className="item-card" key={lineage.lineageId}>
            <p><s>{item.text}</s> · no longer in your plan</p>
          </article>;
        })}
      </aside>
    </div>
  );
}
