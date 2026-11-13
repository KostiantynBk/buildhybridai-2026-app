import { MIN_WORDS, wordCount, type Snapshot } from '../store';
import { lineageHeads } from '../store/lineage';
import { containsQuote } from '../pipeline/compare';

export function emptyReason(snapshot: Snapshot, configured: boolean, ready: boolean): string {
  if (!snapshot.paragraphs.length) return 'Start writing a plan to see what it relies on.';
  if (snapshot.paragraphs.every(p => wordCount(p.text) < MIN_WORDS)) {
    return `A paragraph needs at least ${MIN_WORDS} words before it can be checked.`;
  }
  if (!configured) return 'Waiting: Firebase is not configured. Your notebook stays local.';
  if (!ready) return 'Waiting for the on-device model. Prepare the model to continue.';
  if (snapshot.jobs.some(job => job.status === 'failed')) return 'An extraction stopped after bounded retries.';
  if (snapshot.jobs.some(job => job.status === 'pending' || job.status === 'running')) {
    return 'Checking settled paragraphs on device.';
  }
  if (snapshot.paragraphs.some(p => wordCount(p.text) >= MIN_WORDS && !snapshot.jobs.some(j =>
    j.paragraphId === p.id && j.paragraphVersion === p.version && j.status === 'done'))) {
    return 'Waiting for the paragraph to settle.';
  }
  return 'Nothing found in the current paragraphs.';
}
export function NotebookPanel({ text, save, storageStatus, snapshot, configured, ready }: {
  text: string; save: (value: string) => void; storageStatus: 'loading' | 'saving' | 'saved' | 'error';
  snapshot: Snapshot; configured: boolean; ready: boolean;
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
  const hasItems = visibleGroups.length > 0 ||
    (storageStatus === 'saved' && (removed.length > 0 || unchecked.length > 0));
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
        {!hasItems && <div className="empty" role="status"><p>{storageStatus === 'saving'
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
