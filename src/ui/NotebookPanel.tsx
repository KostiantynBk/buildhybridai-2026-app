import { useEffect, useState } from 'react';
import { MAX_ATTEMPTS, MIN_WORDS, type ProfileRecord, type Snapshot, type StoredJob } from '../store';
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
import { splitParagraphs } from '../store/matcher';
import { extractionEligible, isHeadingBlock, paragraphLabel } from '../structure/planStructure';
import { DraftControls } from './DraftControls';
import { copy, displayMessage } from './copy';

const angleLabels: Record<DisplayAngle, string> = { 'end-user': 'For the user',
  'cost-at-scale': 'Costs at scale', 'limits-operations': 'Limits and operations',
  'security-privacy': 'Security and privacy', alternatives: 'Alternatives', 'track-record': 'From your experience' };

export function ProfileBlock({ card, profile }: { card: ThoughtCard; profile: ProfileRecord[] }) {
  if (card.triageVersion !== 'v2.1' || card.brief) return null;
  const records = (card.profileRecordIds ?? []).flatMap(id => {
    const record = profile.find(value => value.id === id);
    return record ? [record] : [];
  });
  return records.length ? <div><p>{copy.profileVariant}</p><ul>{records.map(record =>
    <li key={record.id} style={{ whiteSpace: 'pre-wrap' }}>{record.text}</li>)}</ul></div> : null;
}
export function WhyContent({ card, profile }: { card: ThoughtCard; profile: ProfileRecord[] }) {
  if (!card.why) return null;
  const cited = card.triageVersion === 'v2' ? card.why.used.flatMap(id => {
    const record = profile.find(value => value.id === id);
    return record ? [record] : [];
  }) : [];
  return <><p>{card.why.seeing}{card.why.why ? ` ${card.why.why}` : ''}</p>
    {cited.length > 0 && <div><p>{copy.profileVariant}</p><ul>{cited.map(record =>
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
  cloudMode = false, version: 'extract.v1' | 'extract.v2' = 'extract.v2', foreground = true): string {
  const paragraphs = snapshot.paragraphs.filter(paragraph => !isHeadingBlock(paragraph.text));
  if (!paragraphs.length) return 'Start writing a plan to see what it relies on.';
  const mode = cloudMode ? 'in_cloud' : 'on_device';
  if (paragraphs.every(p => !extractionEligible(p.text, mode, version, MIN_WORDS))) {
    return `A paragraph needs at least ${MIN_WORDS} words before it can be checked.`;
  }
  if (!configured) return 'Waiting: Firebase is not configured. Your notebook stays local.';
  if (!foreground) return 'Paused while away. Return to this tab to continue.';
  if (!ready) return cloudMode ? 'Cloud processing is disabled; cloud jobs are paused.' :
    'Waiting for the on-device model. Prepare the model to continue.';
  if (snapshot.jobs.some(job => job.step === 'extract' && job.status === 'failed' &&
      paragraphs.some(p => p.id === job.paragraphId && p.version === job.paragraphVersion))) {
    return copy.extractionFailed;
  }
  if (snapshot.jobs.some(job => job.step === 'extract' && (job.status === 'pending' || job.status === 'running') &&
      paragraphs.some(p => p.id === job.paragraphId && p.version === job.paragraphVersion))) {
    return copy.waitingRead;
  }
  if (paragraphs.some(p => extractionEligible(p.text, mode, version, MIN_WORDS) && !snapshot.jobs.some(j =>
    j.paragraphId === p.id && j.paragraphVersion === p.version && j.status === 'done'))) {
    return copy.waiting;
  }
  return 'Nothing found in the current paragraphs.';
}
export function NotebookPanel({ text, save, storageStatus, snapshot, configured, ready, feedback, research,
  researchAgain, researchErrors, searching, checkingSend, cloudMode = false, foreground = true, checkThis, sendDraft,
  declineDraft, reopenDraft, sampleActive = false, trySample, removeSample, cardOnly = false,
  controlsDisabled = false, removedSampleIds = [], extractVersion = 'extract.v2',
  modelState, retryRequired = false, activeClaim, ownedClaim, prepareAgain, storagePaused = false }: {
  text: string; save: (value: string) => void; storageStatus: 'loading' | 'saving' | 'saved' | 'error';
  snapshot: Snapshot; configured: boolean; ready: boolean;
  feedback?: (cardId: string, value: Feedback) => void; research?: Record<string, ResearchView>;
  researchAgain?: (id: string) => Promise<void>; researchErrors?: Record<string, string>;
  searching?: Record<string, boolean>; checkingSend?: Record<string, boolean>; cloudMode?: boolean;
  foreground?: boolean; cardOnly?: boolean; controlsDisabled?: boolean; removedSampleIds?: readonly string[];
  extractVersion?: 'extract.v1' | 'extract.v2';
  modelState?: string; retryRequired?: boolean; activeClaim?: StoredJob; ownedClaim?: StoredJob;
  prepareAgain?: () => void;
  storagePaused?: boolean;
  checkThis?: (itemId: string) => Promise<void>;
  sendDraft?: (cardId: string, text: string) => Promise<void>;
  declineDraft?: (cardId: string) => Promise<void>; reopenDraft?: (cardId: string) => Promise<void>;
  sampleActive?: boolean; trySample?: () => void; removeSample?: () => void;
}) {
  const [researchError, setResearchError] = useState('');
  const heads = lineageHeads(snapshot.lineages ?? []);
  const headingIds = new Set(snapshot.paragraphs.filter(paragraph => isHeadingBlock(paragraph.text))
    .map(paragraph => paragraph.id));
  const removed = heads.filter(lineage => !headingIds.has(lineage.paragraphId) &&
    !removedSampleIds.includes(lineage.paragraphId) && lineage.status === 'removed' &&
    (!snapshot.paragraphs.some(p => p.id === lineage.paragraphId) || snapshot.paragraphs.some(p =>
      p.id === lineage.paragraphId && p.version === lineage.paragraphVersion)));
  const groups = snapshot.paragraphs.filter(paragraph => !isHeadingBlock(paragraph.text))
    .map(paragraph => ({ paragraph, items: snapshot.items.filter(item =>
    item.status === 'current' && item.paragraphId === paragraph.id && item.paragraphVersion === paragraph.version) }));
  const visibleGroups = storageStatus === 'saved' ? groups.filter(group => group.items.length > 0) : [];
  const unchecked = heads.filter(lineage => !headingIds.has(lineage.paragraphId) && lineage.unchecked &&
    !groups.some(group =>
    group.items.some(item => item.lineageId === lineage.lineageId)));
  const visibleCards = (snapshot.cards ?? []).filter(card => card.questionStatus !== 'marked' && !card.supersededMark &&
    !snapshot.paragraphs.some(paragraph => paragraph.id === card.paragraphId && isHeadingBlock(paragraph.text)));
  const currentExtractionFailed = storageStatus === 'saved' && snapshot.jobs.some(job => job.step === 'extract' &&
    job.status === 'failed' && job.failureReason !== 'model-input-quota' &&
    snapshot.paragraphs.some(p => p.id === job.paragraphId &&
      p.version === job.paragraphVersion && !isHeadingBlock(p.text)));
  const reading = !storagePaused && storageStatus === 'saved' && ready && foreground && snapshot.jobs.find(job =>
    job.step === 'extract' && job.status === 'running' && job.key === activeClaim?.key &&
    job.attempts === activeClaim.attempts && (job.runMode ?? 'on_device') === (cloudMode ? 'in_cloud' : 'on_device') &&
    snapshot.paragraphs.some(p => p.id === job.paragraphId &&
      p.version === job.paragraphVersion && !isHeadingBlock(p.text)));
  const automaticAngles = snapshot.jobs.filter(job => job.step === 'angles' && !job.requested &&
    snapshot.paragraphs.some(p => p.id === job.paragraphId && p.version === job.paragraphVersion &&
      !isHeadingBlock(p.text)));
  const modeAngles = automaticAngles.filter(job => (job.runMode ?? 'on_device') ===
    (cloudMode ? 'in_cloud' : 'on_device') && job.status !== 'superseded');
  const looking = !storagePaused && storageStatus === 'saved' && ready && foreground && modeAngles.some(job =>
    job.status === 'running' && job.key === activeClaim?.key && job.attempts === activeClaim.attempts);
  const failedAngles = new Set(automaticAngles.filter(job => job.status === 'failed' &&
    (job.attempts >= MAX_ATTEMPTS || job.failureReason === 'model-input-quota'))
    .map(job => job.paragraphId)).size;
  const work = snapshot.jobs.filter(job => (job.step === 'extract' || (job.step === 'angles' && !job.requested)) &&
    (job.status === 'pending' || job.status === 'running') && snapshot.paragraphs.some(p =>
      p.id === job.paragraphId && p.version === job.paragraphVersion && !isHeadingBlock(p.text)));
  const waiting = new Set(work.map(job => job.paragraphId)).size;
  const otherModeOnly = work.length > 0 && work.every(job => (job.runMode ?? 'on_device') !==
    (cloudMode ? 'in_cloud' : 'on_device'));
  const stalled = !cloudMode && modelState === 'stalled';
  const needsPrepare = !cloudMode && retryRequired;
  const owned = ownedClaim ?? activeClaim;
  const unconfirmed = work.some(job => job.status === 'running' &&
    (job.key !== owned?.key || job.attempts !== owned.attempts));
  const settling = work.some(job => job.status === 'running' && job.key === owned?.key &&
    job.attempts === owned.attempts && (job.key !== activeClaim?.key || job.attempts !== activeClaim.attempts));
  const quota = snapshot.jobs.some(job => job.step === 'extract' && job.status === 'failed' &&
    job.failureReason === 'model-input-quota' && snapshot.paragraphs.some(p =>
      p.id === job.paragraphId && p.version === job.paragraphVersion));
  const hasItems = visibleGroups.length > 0 || visibleCards.length > 0 || (storageStatus === 'saved' &&
    [...removed, ...unchecked].some(lineage => snapshot.items.some(item => item.id === lineage.itemId)));
  return (
    <div className="workspace">
      {!cardOnly && <section className="panel notebook">
        <div className="section-title"><div><span className="eyebrow">Your space</span><h2>Notebook</h2></div>
          <span className="muted">{storageStatus === 'saved' ? 'Saved in this browser' :
            storageStatus === 'saving' ? 'Saving…' : storageStatus === 'loading' ? 'Opening local storage…' :
              'Not saved'}</span></div>
        <p>Give your plan room to take shape. Separate paragraphs with a blank line.</p>
        {trySample && storageStatus === 'saved' && !text.trim() && snapshot.paragraphs.length === 0 &&
          !sampleActive && <button className="secondary" onClick={trySample}>Try a sample plan</button>}
        {sampleActive && <p>Sample plan (invented) · <button className="quiet" onClick={removeSample}>
          Remove sample</button></p>}
        <label htmlFor="notebook" className="sr-only">Your planning notebook</label>
        <textarea id="notebook" value={text} onChange={event => save(event.target.value)}
          disabled={storageStatus === 'loading'} placeholder="Start with the idea you are exploring…" />
        {storageStatus === 'error' && <p role="alert">Could not save in this browser. Your changes may be lost.</p>}
      </section>}
      <aside className="panel thoughts"><span className="eyebrow">Alongside your work</span>
        <h2>What your plan relies on</h2>
        {(currentExtractionFailed || reading || looking || quota || work.length > 0 || storagePaused ||
          stalled || (storageStatus === 'saved' && failedAngles > 0)) &&
          <div role="status" aria-live="polite">
            {currentExtractionFailed && <p>{copy.extractionFailed}</p>}
            {quota && <p>The on-device model couldn't process this part.</p>}
            {storagePaused && <p>Automatic work is paused because browser storage is full.
              Save the notebook to retry.</p>}
            {stalled && <p>
              The on-device model stopped responding. Reload this page to continue reading.
            </p>}
            {!storagePaused && work.length > 0 && !stalled && storageStatus === 'saving' &&
              <p>Saving changes before checking.</p>}
            {!storagePaused && work.length > 0 && !stalled && storageStatus === 'error' &&
              <p>Work is paused because local changes could not be saved.</p>}
            {!storagePaused && work.length > 0 && !stalled && storageStatus === 'loading' &&
              <p>Opening local storage.</p>}
            {!storagePaused && work.length > 0 && !stalled && storageStatus === 'saved' && !foreground &&
              <p>Paused while away.</p>}
            {!storagePaused && work.length > 0 && !stalled && storageStatus === 'saved' && foreground && needsPrepare &&
              <p>
              {waiting} {waiting === 1 ? 'paragraph is' : 'paragraphs are'} waiting.{' '}
              <button onClick={prepareAgain} disabled={!prepareAgain}>Prepare again</button>
            </p>}
            {!storagePaused && work.length > 0 && !stalled && storageStatus === 'saved' && foreground &&
              !needsPrepare && !ready && <p>Waiting for the selected model to be ready.</p>}
            {!storagePaused && work.length > 0 && !stalled && storageStatus === 'saved' && foreground && ready &&
              !needsPrepare && unconfirmed && <p>A previous attempt is interrupted or may be running in another tab.
              </p>}
            {!storagePaused && !stalled && storageStatus === 'saved' && foreground && ready && !needsPrepare &&
              settling && <p>Finishing work in this tab…</p>}
            {!storagePaused && work.length > 0 && !stalled && storageStatus === 'saved' && foreground && ready &&
              !needsPrepare && !unconfirmed && !settling && !reading && !looking && (otherModeOnly
                ? <p>Work is waiting for its original processing mode.</p>
                : <p>{waiting} {waiting === 1 ? 'paragraph' : 'paragraphs'} queued.</p>)}
            {reading && <p>{reading.runMode === 'in_cloud' ? copy.readingCloud : copy.readingLocal}</p>}
            {looking && <p>Looking for things worth checking (
              {modeAngles.filter(job => job.status === 'done' || job.status === 'failed').length + 1}
              {' of '}{modeAngles.length} queued)</p>}
            {storageStatus === 'saved' && failedAngles > 0 && <p>
              Couldn't look for things worth checking in {failedAngles}{' '}
              {failedAngles === 1 ? 'paragraph' : 'paragraphs'}.
            </p>}
          </div>}
        {researchError && <p role="alert">{researchError}</p>}
        {!hasItems && !currentExtractionFailed && !reading && !looking && !work.length && !quota && !stalled &&
          !storagePaused &&
          <div className="empty" role="status"><p>
          {storageStatus === 'saving' ? 'Saving changes before checking this plan.' : storageStatus === 'error'
            ? 'Cannot check unsaved changes.' :
              emptyReason(snapshot, configured, ready, cloudMode, extractVersion, foreground)}</p></div>}
        {visibleGroups.filter(group => !cardOnly || group.items.some(item => (snapshot.cards ?? []).some(card =>
          card.itemLineageId === item.lineageId && card.questionStatus === 'marked')))
          .map(({ paragraph, items }) => <section key={paragraph.id}>
          <h3>{paragraphLabel(paragraph, snapshot.paragraphs)}</h3>
          {items.filter(item => !cardOnly || (snapshot.cards ?? []).some(card =>
            card.itemLineageId === item.lineageId && card.questionStatus === 'marked')).map(item => {
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
              {checkThis && <button disabled={storageStatus !== 'saved' || controlsDisabled} onClick={() => {
                void checkThis(item.id).catch(error => setResearchError(error instanceof Error
                  ? displayMessage(error.message) : 'Could not start this check.'));
              }}>Check this</button>}
              {head?.status === 'changed' && !head.needsConfirmation && head.paragraphVersion === paragraph.version &&
                <p>Changed: was “{previous?.text ?? 'earlier statement'}”</p>}
              {head?.needsConfirmation && <p>{copy.uncertain} Please check.</p>}
              {head?.needsConfirmation && !head.conflictingEvidence && head.newQuote &&
                containsQuote(paragraph.text, head.newQuote) && <p>Now: “{head.newQuote}”</p>}
              {head?.unchecked && <p>{copy.uncertain} Please check.</p>}
            </article>;
          })}
        </section>)}
        {visibleCards.map(card => {
          const stale = calculateStaleness(card.id, snapshot.dependencies ?? [], snapshot.lineages ?? []);
          const provenChange = stale.reasons.some(reason => reason.kind === 'changed' || reason.kind === 'removed');
          const outbox = snapshot.outbox?.find(entry => entry.id === card.outboxId);
          const privacyChanged = !!outbox && !!research?.[outbox.id]?.changedAfterSend;
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
            <div role="status" aria-live="polite">
              {(stale.stale || failedCheckVisible || eligibility === 'stale' || eligibility === 'terminal' ||
                privacyChanged) && <p>{provenChange ? copy.definite : copy.uncertain}{' '}
                {privacyChanged && 'Your privacy settings may also have changed. '}Check again.</p>}
              {card.questionStatus === 'waiting' && <p>{copy.draftQuestion}</p>}
              {outbox?.status === 'approved' && outbox && checkingSend?.[outbox.id] &&
                <p>{copy.checkingBeforeResearch}</p>}
              {outbox?.status === 'approved' && outbox && searching?.[outbox.id] && <p>{copy.searching}</p>}
            </div>
            {card.askedDirectly ? <><h4>{copy.questionHeading}</h4><p>{copy.requestedVariant}</p></> : card.angle &&
              <div><strong>{angleLabels[card.angle]}</strong></div>}
            <blockquote>“{card.itemQuote}”</blockquote>{card.concern && <p>{card.concern}</p>}
            {!card.askedDirectly && <><h4>{copy.questionHeading}</h4>
              {card.triageVersion === 'v2.1' ? <ProfileBlock card={card} profile={snapshot.profile} /> :
                <FreshWhy card={card} profile={snapshot.profile} />}</>}
            {card.questionStatus === 'blocked' && <p>{questionStatus}</p>}
            {(eligibility === 'stale' || eligibility === 'terminal') && checkThis &&
              <button disabled={controlsDisabled || !head?.itemId || head.status === 'removed'} onClick={() => {
                if (head?.itemId) void checkThis(head.itemId)
                  .catch(() => setResearchError('Could not check the changed statement.'));
              }}>Check again</button>}
            <DraftControls card={card} outbox={outbox} receiptStatus={receipts[0]?.status} send={sendDraft}
              planTexts={splitParagraphs(text)}
              failureCode={receipts[0]?.failureCode} researchError={outbox && researchErrors?.[outbox.id]}
              searching={!!outbox && !!searching?.[outbox.id]} checkingSend={!!outbox && !!checkingSend?.[outbox.id]}
              statusInParent controlsDisabled={controlsDisabled} decline={declineDraft} reopen={reopenDraft}
              research={researchAgain} />
            {outbox && research?.[outbox.id] && <section><h4>What the research found</h4>
              {!isGrounded(research[outbox.id].result) && <p>{copy.noSources}</p>}
              <ResearchBlock result={research[outbox.id].result} />
              <button disabled={controlsDisabled}
                onClick={() => { void navigator.clipboard.writeText(research[outbox.id].result.text); }}>
                Copy</button></section>}
            {outbox && !research?.[outbox.id] && receipt && <div>
              <p>Researched on {new Date(receipt.sentAt).toLocaleDateString()}.
                Results aren't kept on this device.</p>
              {researchAgain && outbox.status === 'approved' && !searching?.[outbox.id] &&
                <button disabled={storageStatus !== 'saved' || controlsDisabled || !!checkingSend?.[outbox.id]}
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
            <p>{item.text}</p><p>{copy.uncertain} Please check.</p>
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
