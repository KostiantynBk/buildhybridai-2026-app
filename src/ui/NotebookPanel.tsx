import { useEffect, useState } from 'react';
import { MIN_WORDS, wordCount, type ProfileRecord, type Snapshot } from '../store';
import { fingerprintsMatch } from '../store/fingerprint';
import type { ThoughtCard } from '../store/triageTypes';
import { lineageHeads } from '../store/lineage';
import { containsQuote } from '../pipeline/compare';
import { calculateStaleness } from '../store/staleness';
import type { Feedback } from '../store/triageTypes';

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
export function emptyReason(snapshot: Snapshot, configured: boolean, ready: boolean): string {
  if (!snapshot.paragraphs.length) return 'Start writing a plan to see what it relies on.';
  if (snapshot.paragraphs.every(p => wordCount(p.text) < MIN_WORDS)) {
    return `A paragraph needs at least ${MIN_WORDS} words before it can be checked.`;
  }
  if (!configured) return 'Waiting: Firebase is not configured. Your notebook stays local.';
  if (!ready) return 'Waiting for the on-device model. Prepare the model to continue.';
  if (snapshot.jobs.some(job => job.step === 'extract' && job.status === 'failed' &&
      snapshot.paragraphs.some(p => p.id === job.paragraphId && p.version === job.paragraphVersion))) {
    return 'An extraction stopped after bounded retries.';
  }
  if (snapshot.jobs.some(job => job.status === 'pending' || job.status === 'running')) {
    return 'Checking settled paragraphs on device.';
  }
  if (snapshot.paragraphs.some(p => wordCount(p.text) >= MIN_WORDS && !snapshot.jobs.some(j =>
    j.paragraphId === p.id && j.paragraphVersion === p.version && j.status === 'done'))) {
    return 'Waiting for the paragraph to settle.';
  }
  return 'Nothing found in the current paragraphs.';
}
export function NotebookPanel({ text, save, storageStatus, snapshot, configured, ready, feedback }: {
  text: string; save: (value: string) => void; storageStatus: 'loading' | 'saving' | 'saved' | 'error';
  snapshot: Snapshot; configured: boolean; ready: boolean;
  feedback?: (cardId: string, value: Feedback) => void;
}) {
  const heads = lineageHeads(snapshot.lineages ?? []);
  const removed = heads.filter(lineage => lineage.status === 'removed' &&
    (!snapshot.paragraphs.some(p => p.id === lineage.paragraphId) || snapshot.paragraphs.some(p =>
      p.id === lineage.paragraphId && p.version === lineage.paragraphVersion)));
  const groups = snapshot.paragraphs.map(paragraph => ({ paragraph, items: snapshot.items.filter(item =>
    item.status === 'current' && item.paragraphId === paragraph.id && item.paragraphVersion === paragraph.version) }));
  const visibleGroups = storageStatus === 'saved' ? groups.filter(group => group.items.length > 0) : [];
  const unchecked = heads.filter(lineage => lineage.unchecked && !groups.some(group =>
    group.items.some(item => item.lineageId === lineage.lineageId)));
  const visibleCards = (snapshot.cards ?? []).filter(card => card.questionStatus !== 'waiting');
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
        {!hasItems && !currentExtractionFailed && <div className="empty" role="status"><p>{storageStatus === 'saving'
          ? 'Saving changes before checking this plan.' : storageStatus === 'error'
            ? 'Cannot check unsaved changes.' : emptyReason(snapshot, configured, ready)}</p></div>}
        {visibleGroups.map(({ paragraph, items }) => <section key={paragraph.id}>
          <h3>Paragraph {paragraph.order + 1}</h3>
          {items.map(item => {
            const head = heads.find(lineage => lineage.lineageId === item.lineageId);
            const previous = snapshot.items.find(candidate => candidate.id === head?.changedFrom);
            return <article className="item-card" key={item.id}>
              <div><strong>{item.kind}</strong> · <span className="muted">on device</span></div>
              <p>{item.text}</p><blockquote>“{item.quote}”</blockquote>
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
          const failedCheckVisible = card.recheckFailedVersion !== undefined && paragraph &&
            (paragraph.version === card.recheckFailedVersion || head?.paragraphVersion !== paragraph.version);
          const questionStatus = card.questionStatus === 'blocked' ? card.questionReason === 'private detail'
            ? 'question held back: private detail' : card.questionReason === 'stale'
              ? 'question unavailable: the statement changed' : card.questionReason === 'revalidation-failed'
                ? 'question unavailable: an earlier check stopped' : 'question unavailable after local error'
            : outbox?.status ?? 'preparing';
          return <article className="item-card" key={card.id}>
            {failedCheckVisible && <p role="status">May have changed: couldn't re-check your edit.</p>}
            {stale.stale && <p role="status">Depends on “{card.itemQuote}” — {stale.reasons.map(reason =>
              reason.kind === 'needsConfirmation' ? 'may have changed' :
                reason.kind === 'removed' ? 'no longer in your plan' : 'changed').join(', ')}</p>}
            {card.brief ? <p><strong>{card.angle}:</strong> {card.concern} · {questionStatus}</p> : <>
              <div><strong>{card.angle}</strong> · <span className="muted">on device</span></div>
              <blockquote>“{card.itemQuote}”</blockquote><p>{card.concern}</p>
              {card.triageVersion === 'v2.1' ? <ProfileBlock card={card} profile={snapshot.profile} /> :
                <FreshWhy card={card} profile={snapshot.profile} />}
              <p>{outbox ? `${outbox.question} · ${outbox.status}` : questionStatus}</p>
              <p>Research comes in a later version.</p>
              {feedback && <div>{(['useful', 'already knew', 'not relevant', 'wrong'] as Feedback[]).map(value =>
                <button key={value} aria-pressed={card.feedback === value}
                  onClick={() => feedback(card.id, value)}>{value}</button>)}</div>}
            </>}
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
