import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { Snapshot } from '../store';
import { NotebookPanel } from './NotebookPanel';

it('hides old heading-derived items and labels the actual paragraph by its nearest heading', () => {
  const snapshot: Snapshot = { paragraphs: [
    { id: 'h1', projectId: 'default', order: 0, version: 1, updatedAt: 0, text: '# Plan' },
    { id: 'h2', projectId: 'default', order: 1, version: 1, updatedAt: 0, text: '## 4. How it works' },
    { id: 'p', projectId: 'default', order: 2, version: 1, updatedAt: 0,
      text: 'Heartbeat processing runs after each edit while the planning tab remains open.' },
  ], profile: [], jobs: [], items: [
    { id: 'i1', paragraphId: 'h1', paragraphVersion: 1, kind: 'assumption', text: 'FAKE heading statement',
      quote: 'Plan', topics: [], status: 'current', promptVersion: 'extract.v2', createdAt: 0 },
    { id: 'i2', paragraphId: 'p', paragraphVersion: 1, kind: 'assumption', text: 'FAKE prose statement',
      quote: 'Heartbeat processing', topics: [], status: 'current', promptVersion: 'extract.v2', createdAt: 0 },
  ] };
  const html = renderToStaticMarkup(<NotebookPanel text="plan" save={() => {}} snapshot={snapshot}
    storageStatus="saved" configured ready />);
  expect(html).not.toContain('FAKE heading statement');
  expect(html).toContain('FAKE prose statement');
  expect(html).toContain('Under “4. How it works”: “Heartbeat processing runs after each edit while the…”');
  expect(html).not.toContain('Paragraph 3');
});
