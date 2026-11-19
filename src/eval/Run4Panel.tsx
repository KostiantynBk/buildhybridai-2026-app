import { useState } from 'react';
import type { ResearchView } from '../ai/researchFlow';
import type { Run4Provenance } from './run4Provenance';
import { builtInSettings } from '../settings/defaults';

type Rating = { answers: string; datedFact: string; alsoWorthKnowing: string };
export type ResearchMetric = { id: string; questionId: string; latencyMs: number | null; sourceCount: number | null;
  suggestionsPresent: boolean | null; inCloud: boolean | null; grounded: boolean | null; displayed: boolean;
  provenance: Run4Provenance };
export function run4Export(metrics: ResearchMetric[], ratings: Record<string, Rating>) {
  const versions = [...new Set(metrics.map(metric => metric.provenance.promptVersion))];
  return { run: 4, promptVersion: versions.length === 1 ? versions[0] : versions.length ? 'mixed' : 'research.v2',
    sends: metrics.length, rows: metrics.map(({ id, ...row }) => ({
    ...row, ratings: row.displayed ? ratings[id] ?? null : null,
  })) };
}
export function Run4Panel({ research, metrics }: {
  research: Record<string, ResearchView>; metrics: ResearchMetric[];
}) {
  const [ratings, setRatings] = useState<Record<string, Rating>>({});
  const update = (id: string, key: keyof Rating, value: string) => setRatings(current => ({ ...current,
    [id]: { ...(current[id] ?? { answers: '', datedFact: '', alsoWorthKnowing: '' }), [key]: value } }));
  return <section className="panel"><h2>Run 4 · session-only research metrics</h2>
    <p>Requests sent: {metrics.length}. Ratings and results are cleared on reload.
      The export contains no result text.</p>
    <h3>Attempt settings and model</h3>
    <p>Built-in scored baseline:</p><pre>{JSON.stringify(builtInSettings().values, null, 2)}</pre>
    {!metrics.length && <p>No attempts yet. Each attempt records its effective settings and source map.</p>}
    {metrics.map((metric, index) => <details key={metric.id}><summary>Attempt {index + 1} · {metric.questionId}
      {' · '}{metric.provenance.model} · {metric.provenance.promptVersion}</summary>
      <pre>{JSON.stringify(metric.provenance, null, 2)}</pre></details>)}
    {(['research.v2', 'research.idea.v1'] as const).map(version => <section key={version}>
      <h3>{version === 'research.v2' ? 'Fact questions' : 'Idea descriptions'}</h3>
      {Object.entries(research).filter(([id]) => metrics.some(metric => metric.questionId === id &&
        metric.provenance.promptVersion === version)).map(([id, view]) => {
      const metricId = [...metrics].reverse().find(metric => metric.questionId === id && metric.displayed)?.id;
      return <fieldset key={id}><legend>{version === 'research.v2' ? 'Question' : 'Idea'} ID: {id}</legend>
      <p>{view.latencyMs} ms · {view.result.sources.filter(Boolean).length} sources · Suggestions
        {view.result.suggestions ? ' present' : ' absent'}</p>
      {(version === 'research.v2' ? ([['answers', 'Answers the question', ['yes', 'partly', 'no']],
        ['datedFact', 'Specific fact with a date', ['yes', 'no']],
        ['alsoWorthKnowing', 'Also worth knowing was useful', ['yes', 'no']]] as const) :
        ([['answers', 'Similar work useful', ['yes', 'partly', 'no']],
          ['datedFact', 'Difference useful', ['yes', 'no']], ['alsoWorthKnowing', 'Combinations useful',
            ['yes', 'no']]] as const)).map(([key, label, values]) =>
        <label key={key}>{label} <select value={metricId ? ratings[metricId]?.[key] ?? '' : ''} disabled={!metricId}
          onChange={event => { if (metricId) update(metricId, key, event.target.value); }}>
          <option value="">Not rated</option>
          {values.map(value => <option key={value} value={value}>{value}</option>)}</select></label>)}
    </fieldset>; })}</section>)}
    <button disabled={!metrics.length} onClick={() => {
      const data = JSON.stringify(run4Export(metrics, ratings), null, 2);
      const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = 'thoughtpartner-run4.json';
      link.click(); URL.revokeObjectURL(url);
    }}>Export Run 4 metrics</button>
  </section>;
}
