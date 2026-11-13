import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { Snapshot, StoredItem } from '../store';
import { NotebookPanel } from './NotebookPanel';

it('shows a changed statement and a removed statement once, with prior wording', () => {
  const base: StoredItem = { id: 'old', paragraphId: 'p', paragraphVersion: 1, kind: 'assumption',
    text: 'Old value', quote: 'old', topics: [], status: 'superseded', promptVersion: 'extract.v2', createdAt: 0 };
  const snapshot: Snapshot = { paragraphs: [{ id: 'p', projectId: 'default', order: 0, text: 'new', version: 2,
    updatedAt: 1 }], profile: [], jobs: [], items: [base, { ...base, id: 'new', paragraphVersion: 2,
    text: 'New value', quote: 'new', status: 'current', lineageId: 'a' },
    { ...base, id: 'removed', text: 'Deleted statement' }], lineages: [
    { lineageId: 'a', version: 2, itemId: 'new', paragraphId: 'p', paragraphVersion: 2, status: 'changed',
      changedFrom: 'old' },
    { lineageId: 'b', version: 2, itemId: 'removed', paragraphId: 'p', paragraphVersion: 2, status: 'removed' },
  ] };
  const html = renderToStaticMarkup(<NotebookPanel text="new" save={() => {}} storageStatus="saved"
    snapshot={snapshot} configured ready />);
  expect(html).toContain('Changed: was “Old value”');
  expect(html).toContain('<s>Deleted statement</s>');
  expect(html.match(/no longer in your plan/g)).toHaveLength(1);
});
