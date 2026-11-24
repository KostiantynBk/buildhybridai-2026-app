import type { Snapshot, StoredJob } from '../store';
import { isHeadingBlock } from '../structure/planStructure';
import { angleLabels, eligibleMarks } from './marks';

export function CheckShortlist({ snapshot, view, setView, check, disabled = false, activeClaim,
  ready = false, foreground = true, cloudMode = false, stalled = false, paused = false, retryRequired = false,
  showMarks = true }: {
  snapshot: Snapshot; view: 'checks' | 'all'; setView(view: 'checks' | 'all'): void;
  check(itemId: string): void; disabled?: boolean; activeClaim?: StoredJob; ready?: boolean; foreground?: boolean;
  cloudMode?: boolean; stalled?: boolean; paused?: boolean; retryRequired?: boolean; showMarks?: boolean;
}) {
  const marks = showMarks ? eligibleMarks(snapshot) : [];
  const active = !disabled && ready && foreground && !stalled && !paused && !retryRequired &&
    snapshot.jobs.some(job => (job.step === 'extract' || (job.step === 'angles' && !job.requested)) &&
      job.status === 'running' && job.key === activeClaim?.key && job.attempts === activeClaim.attempts &&
      (job.runMode ?? 'on_device') === (cloudMode ? 'in_cloud' : 'on_device') &&
      snapshot.paragraphs.some(p => p.id === job.paragraphId && p.version === job.paragraphVersion &&
        !isHeadingBlock(p.text)));
  return <section aria-label="Statement views" className="panel check-shortlist">
    {marks.length > 0 && <><h3>Worth checking first</h3><ul>{marks.slice(0, 3).map(({ item, mark, label }) =>
      <li key={item.id}><strong>{angleLabels[mark.angle!]}</strong><blockquote>“{mark.itemQuote}”</blockquote>
        <p className="muted shortlist-label">In: {label.replace(/^Under “(.*?)”: “(.*)”$/u, 'Under $1: $2')
          .replace(/^“(.*)”$/u, '$1')}</p>
        <button disabled={disabled} onClick={() => check(item.id)}>Check this</button></li>)}</ul></>}
    {active && <p role="status">Still looking for things worth checking…</p>}
    <div aria-label="Statement view">
      <button aria-pressed={view === 'checks'} onClick={() => setView('checks')}>See all checks</button>
      <button aria-pressed={view === 'all'} onClick={() => setView('all')}>See all statements</button>
    </div>
  </section>;
}
