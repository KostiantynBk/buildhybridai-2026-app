import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { Snapshot } from '../store';
import { NotebookPanel } from './NotebookPanel';

it('shows current marks beside statements and hides them when the lineage changes', () => {
  const paragraph = { id: 'p', projectId: 'default', order: 0, text: 'Hosting supports fifty users', version: 1,
    updatedAt: 1 };
  const snapshot: Snapshot = { paragraphs: [paragraph], profile: [], items: [{ id: 'i', paragraphId: 'p',
    paragraphVersion: 1, kind: 'assumption', text: 'Hosting supports fifty users', quote: paragraph.text,
    topics: ['hosting'], status: 'current', promptVersion: 'extract.v2', createdAt: 1, lineageId: 'l' }],
  lineages: [{ lineageId: 'l', version: 1, itemId: 'i', paragraphId: 'p', paragraphVersion: 1, status: 'current' }],
  jobs: [{ key: 'p@1#extract', paragraphId: 'p', paragraphVersion: 1, step: 'extract', promptVersion: 'extract.v2',
    status: 'done', attempts: 1, createdAt: 1, nextRunAt: 1 }],
  cards: [{ id: 'c', paragraphId: 'p', paragraphVersion: 1, itemLineageId: 'l', itemVersion: 1,
    itemText: 'Hosting supports fifty users', itemQuote: paragraph.text, topics: ['hosting'], angle: 'end-user',
    sourceAngle: 'end-user', concern: 'What are the hosting limits?', score: 1, lessonId: null, brief: false,
    sessionId: 's', questionStatus: 'marked', createdAt: 1 }] };
  const render = (data: Snapshot) => renderToStaticMarkup(<NotebookPanel text={paragraph.text} save={() => {}}
    storageStatus="saved" snapshot={data} configured ready checkThis={async () => {}} />);
  const current = render(snapshot);
  expect(current).toContain('Worth checking');
  expect(current).toContain('Check this');
  expect(current).not.toContain('What are the hosting limits?');
  const changed = render({ ...snapshot, lineages: [...snapshot.lineages!, { ...snapshot.lineages![0], version: 2,
    status: 'changed' }] });
  expect(changed).not.toContain('Worth checking');
});
