import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ProfilePanel } from '../profile/ProfilePanel';
import { emptyReason, NotebookPanel } from './NotebookPanel';
import type { Snapshot } from '../store';

const empty = (): Snapshot => ({ paragraphs: [], items: [], profile: [], jobs: [] });
it('renders an honest saved state and explicit notebook empty states', () => {
  const snapshot = empty();
  const html = renderToStaticMarkup(<NotebookPanel text="" save={() => {}} storageStatus="saving"
    snapshot={snapshot} configured={false} ready={false} />);
  expect(html).toContain('Saving');
  expect(html).not.toContain('Saved in this browser');
  expect(html).toContain('Saving changes before checking');
  expect(emptyReason(snapshot, false, false)).toContain('Start writing');
  snapshot.paragraphs.push({ id: 'p', projectId: 'default', order: 0, text: 'short', version: 1, updatedAt: 0 });
  expect(emptyReason(snapshot, false, false)).toContain('12 words');
  snapshot.paragraphs[0].text = 'one two three four five six seven eight nine ten eleven twelve';
  expect(emptyReason(snapshot, false, false)).toContain('not configured');
  expect(emptyReason(snapshot, true, false)).toContain('model');
  snapshot.jobs.push({ key: 'p@1#extract', paragraphId: 'p', paragraphVersion: 1, step: 'extract',
    promptVersion: 'extract.v2', status: 'done', attempts: 1, createdAt: 0, nextRunAt: 0 });
  expect(emptyReason(snapshot, true, true)).toContain('Nothing found');
});
it('renders the local profile form, import/export and deletion controls', () => {
  const html = renderToStaticMarkup(<ProfilePanel records={[]} save={async () => {}} remove={async () => {}}
    replace={async () => {}} clearAll={async () => {}} />);
  expect(html).toContain('Builder profile');
  expect(html).toContain('Add a record');
  expect(html).toContain('Load demo A');
  expect(html).toContain('Import profile JSON');
  expect(html).toContain('Delete all local data');
});
