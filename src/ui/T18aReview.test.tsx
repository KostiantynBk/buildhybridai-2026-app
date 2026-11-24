import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { Snapshot } from '../store';
import { CheckShortlist } from './CheckShortlist';
import { NotebookPanel } from './NotebookPanel';
import { hasCurrentStatements } from './marks';

function state(): Snapshot {
  return { paragraphs: [{ id: 'p', projectId: 'default', order: 0, version: 2, updatedAt: 1,
    text: '# Converted heading' }], profile: [], jobs: [],
  items: [{ id: 'i', paragraphId: 'p', paragraphVersion: 1, kind: 'assumption', text: 'Former statement',
    quote: 'Former quote', topics: [], status: 'current', promptVersion: 'extract.v2', createdAt: 1, lineageId: 'l' }],
  lineages: [{ lineageId: 'l', itemId: 'i', version: 1, paragraphId: 'p', paragraphVersion: 1, status: 'current' }],
  cards: [{ id: 'c', paragraphId: 'p', paragraphVersion: 1, itemLineageId: 'l', itemVersion: 1,
    itemText: 'Former statement', itemQuote: 'Former quote', topics: [], score: 0, lessonId: null, brief: true,
    sessionId: 's', questionStatus: 'ready', draftQuestion: 'Edited question?', askedDirectly: true, createdAt: 1 }] };
}
it('keeps the editor in checks view and moves a same-ID heading conversion to Earlier checks', () => {
  const snapshot = state();
  const html = renderToStaticMarkup(<NotebookPanel text="# Converted heading" save={() => {}} storageStatus="saved"
    snapshot={snapshot} configured ready checksOnly trySample={() => {}} />);
  expect(html).toContain('id="notebook"');
  expect(html).toContain('Earlier checks');
  expect(html.match(/id="check-card-[^"]+-c"/g)).toHaveLength(1);
  expect(html).toContain('Edited question?');
  expect(html).toContain('You asked for this check');
  expect(html).not.toContain('Why this is here');
  expect(hasCurrentStatements(snapshot)).toBe(false);
});
it('keeps non-check history out of checks view and shows Earlier checks last in all', () => {
  const snapshot = state();
  snapshot.items.push({ ...snapshot.items[0], id: 'removed', text: 'Removed unchecked', lineageId: 'removed-l' });
  snapshot.lineages!.push({ lineageId: 'removed-l', itemId: 'removed', version: 1, paragraphId: 'gone',
    paragraphVersion: 1, status: 'removed' });
  const render = (checksOnly: boolean) => renderToStaticMarkup(<NotebookPanel text="plan" save={() => {}}
    storageStatus="saved" snapshot={snapshot} configured ready checksOnly={checksOnly} />);
  expect(render(true)).not.toContain('Removed unchecked');
  expect(render(false).indexOf('Removed unchecked')).toBeLessThan(render(false).indexOf('Earlier checks'));
});
it('shows active progress only for a ready foreground owned matching-mode job', () => {
  const snapshot = state(); snapshot.paragraphs[0].text = 'A current paragraph for testing';
  const job = { key: 'p@2', paragraphId: 'p', paragraphVersion: 2, status: 'running' as const, attempts: 1,
    createdAt: 0, nextRunAt: 0, step: 'extract' as const, promptVersion: 'extract.v2' as const };
  snapshot.jobs = [job];
  const render = (props: Partial<Parameters<typeof CheckShortlist>[0]>) => renderToStaticMarkup(
    <CheckShortlist snapshot={snapshot} view="all" setView={() => {}} check={() => {}} ready activeClaim={job}
      {...props} />);
  expect(render({})).toContain('Still looking');
  for (const props of [{ stalled: true }, { paused: true }, { ready: false }, { foreground: false },
    { cloudMode: true }, { retryRequired: true }, { disabled: true }, { activeClaim: undefined }]) {
    expect(render(props)).not.toContain('Still looking');
  }
});
