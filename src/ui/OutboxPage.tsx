import { useState } from 'react';
import type { OutboxEntry } from '../store/triageTypes';
import type { Snapshot } from '../store';
import { lineageEligibility } from '../store/eligibility';

export function OutboxPage({ entries, decide, remove, snapshot, saving = false }: { entries: OutboxEntry[];
  snapshot?: Snapshot; saving?: boolean;
  decide(id: string, value: 'approved' | 'rejected'): Promise<boolean>; remove(id: string): Promise<void> }) {
  const [error, setError] = useState('');
  const respond = (id: string, value: 'approved' | 'rejected') => {
    void decide(id, value).then(ok => setError(ok ? '' : 'This question can no longer be approved or rejected.'))
      .catch(() => setError('Could not update the local Outbox.'));
  };
  return <section className="panel placeholder">
    <span className="eyebrow">Local review</span><h2>Outbox</h2>
    <p>Nothing is sent in this version. Approved questions will be researched once cloud research is enabled.</p>
    {entries.length === 0 && <p>No questions are waiting.</p>}
    {error && <p role="alert">{error}</p>}
    {[...entries].sort((a, b) => b.createdAt - a.createdAt).map(entry => <article className="item-card" key={entry.id}>
      <p>{entry.question}</p>
      <p>{entry.status === 'withdrawn' ? entry.withdrawReason === 'listed-term'
        ? 'Withdrawn: contains a term on your never-send list.'
        : entry.withdrawReason === 'stale' ? 'Withdrawn: the statement changed or needs checking.'
          : 'Withdrawn: the question did not pass the privacy filter.'
        : `Status: ${entry.status}`}</p>
      {entry.keptOut.length > 0 && <p>Kept out: {entry.keptOut.join(', ')}</p>}
      {entry.status === 'pending' && (() => {
        const eligibility = saving ? 'checking' : snapshot ? lineageEligibility(entry.itemLineageId, entry.itemVersion,
          snapshot.paragraphs, snapshot.lineages ?? [], snapshot.jobs) : 'checking';
        return <div>
          {eligibility === 'checking' && <p>Checking your edit.</p>}
          <button disabled={eligibility !== 'eligible'} onClick={() => respond(entry.id, 'approved')}>
            Approve</button>{' '}
          <button onClick={() => respond(entry.id, 'rejected')}>Reject</button>
        </div>;
      })()}
      <button onClick={() => {
        if (window.confirm('Delete this local Outbox entry?')) {
          void remove(entry.id).catch(() => setError('Could not delete the local Outbox entry.'));
        }
      }}>Delete</button>
    </article>)}
  </section>;
}
