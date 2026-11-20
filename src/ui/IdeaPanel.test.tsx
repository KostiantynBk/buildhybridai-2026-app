import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { IdeaRecord, Snapshot } from '../store';
import { IdeaPanel } from './IdeaPanel';

const idea: IdeaRecord = { id: 'idea', status: 'sent', draft: 'Public description', keptOut: [],
  statements: ['First', 'Second', 'Third'], basis: [{ lineageId: 'lineage', version: 1 }], mode: 'on_device',
  describePromptVersion: 'describe.v1', researchPromptVersion: 'research.idea.v1', describeJobKey: 'job',
  createdAt: 1, updatedAt: 1 };
const snapshot: Snapshot = { paragraphs: [], items: [], profile: [], jobs: [], lineages: [
  { lineageId: 'lineage', version: 1, itemId: 'i', paragraphId: 'p', paragraphVersion: 1, status: 'current' },
] };
const view = { result: { text: 'Public result', parts: ['Public result'], sources: [], supports: [],
  suggestions: '<a href="https://google.com/search?q=test">Search</a>', grounded: true },
  sentAt: 1, latencyMs: 1, attempts: 1, changedAfterSend: false };
const callbacks = { start: async () => {}, send: async () => {}, retry: async () => {}, decline: async () => {} };
function render(data: Snapshot) {
  return renderToStaticMarkup(<IdeaPanel snapshot={data} idea={idea} view={view} {...callbacks} />);
}
it('explains that a mode-switched draft must be drafted again', () => {
  const data = { ...snapshot, jobs: [{ key: 'job', paragraphId: 'p', paragraphVersion: 1, step: 'describe',
    promptVersion: 'describe.v1', status: 'superseded', attempts: 0, createdAt: 1, nextRunAt: 1,
    errorName: 'ModeChanged' }] } as Snapshot;
  const html = renderToStaticMarkup(<IdeaPanel snapshot={data} idea={{ ...idea, status: 'ready' }} {...callbacks} />);
  expect(html).toContain('Mode changed, draft again.');
  expect(html).toContain('Draft again');
  expect(html).not.toContain('Preparing your description');
});
it('labels the editable description and names its actions', () => {
  const data = { ...snapshot, jobs: [{ key: 'job', paragraphId: 'p', paragraphVersion: 1, step: 'describe',
    promptVersion: 'describe.v1', status: 'done', attempts: 1, createdAt: 1, nextRunAt: 1 }] } as Snapshot;
  const html = renderToStaticMarkup(<IdeaPanel snapshot={data} idea={{ ...idea, status: 'ready' }} {...callbacks} />);
  expect(html).toContain('<label>Public description <textarea');
  expect(html).toContain('role="status"');
  for (const button of html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)) {
    expect(button[1].replace(/<[^>]*>/g, '').trim()).not.toBe('');
  }
});
it('fails closed if either v2 opening copy is missing or mismatched in a retained result', () => {
  const first = { id: 'p', projectId: 'default', order: 0, version: 1, updatedAt: 1, text: 'A fictional plan.' };
  const openingBasis = { id: 'p', version: 1, order: 0 };
  const v2 = { ...idea, describePromptVersion: 'describe.v2' as const, openingBasis, outboxId: 'e' };
  const entry = { id: 'e', kind: 'idea' as const, ideaId: idea.id, question: 'Fake description', keptOut: [],
    status: 'approved' as const, createdAt: 1, openingBasis };
  const base = { ...snapshot, paragraphs: [first], outbox: [entry] };
  for (const side of ['idea', 'entry'] as const) for (const bad of [undefined, { ...openingBasis, id: 'missing' },
    { ...openingBasis, version: 2 }, { ...openingBasis, order: 1 }]) {
    const candidate = side === 'idea' ? { ...v2, openingBasis: bad } : v2;
    const data = side === 'entry' ? { ...base, outbox: [{ ...entry, openingBasis: bad }] } : base;
    const html = renderToStaticMarkup(<IdeaPanel snapshot={data} idea={candidate} view={view} {...callbacks} />);
    expect(html).toContain('Your plan changed since this was checked.');
    expect(html).toContain('Public result');
  }
});
it('warns when a basis version advances, but not when unrelated lineages are added', () => {
  const added = { ...snapshot, lineages: [...snapshot.lineages!, { lineageId: 'new', version: 1, itemId: 'new',
    paragraphId: 'q', paragraphVersion: 1, status: 'current' as const }] };
  expect(render(added)).not.toContain('Your plan changed since this was checked');
  const afterUnrelatedEdit = renderToStaticMarkup(<IdeaPanel snapshot={added} idea={idea}
    view={{ ...view, changedAfterSend: true }} {...callbacks} />);
  expect(afterUnrelatedEdit).not.toContain('Your plan changed since this was checked');
  const changed = { ...snapshot, lineages: [...snapshot.lineages!, { ...snapshot.lineages![0], version: 2,
    status: 'changed' as const }] };
  const html = render(changed);
  expect(html).toContain('Your plan changed since this was checked');
  expect(html).toContain('Combinations are the model&#x27;s suggestions; check their sources.');
  expect(html).not.toContain('This answer used no web sources.');
  const uncertain = { ...snapshot, lineages: [...snapshot.lineages!, { ...snapshot.lineages![0], version: 2,
    status: 'changed' as const, needsConfirmation: true }] };
  const uncertainHtml = render(uncertain);
  expect(uncertainHtml).toContain('We couldn&#x27;t confirm this still matches your plan');
  expect(uncertainHtml).not.toContain('Your plan changed since this was checked');
});
