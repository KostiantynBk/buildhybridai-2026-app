import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { Snapshot } from '../store';
import { NotebookPanel } from './NotebookPanel';

it('shows uncertain change and verified replacement while keeping the old content', () => {
  const snapshot: Snapshot = { paragraphs: [{ id: 'p', projectId: 'default', order: 0,
    text: 'Twenty visitors may come.', version: 2, updatedAt: 1 }], profile: [], jobs: [], items: [{
    id: 'old-copy', paragraphId: 'p', paragraphVersion: 2, kind: 'assumption', text: 'Fifty visitors',
    quote: 'Fifty visitors', topics: [], status: 'current', promptVersion: 'extract.v2', createdAt: 0, lineageId: 'a',
  }], lineages: [{ lineageId: 'a', version: 2, itemId: 'old-copy', paragraphId: 'p', paragraphVersion: 2,
    status: 'changed', needsConfirmation: true, newQuote: 'Twenty visitors' }] };
  const html = renderToStaticMarkup(<NotebookPanel text="Twenty visitors may come." save={() => {}}
    storageStatus="saved" snapshot={snapshot} configured ready />);
  expect(html).toContain('Fifty visitors');
  expect(html).toContain('We couldn&#x27;t confirm this still matches your plan. Please check.');
  expect(html).toContain('Now: “Twenty visitors”');
  expect(html).not.toContain('Changed: was');
});
