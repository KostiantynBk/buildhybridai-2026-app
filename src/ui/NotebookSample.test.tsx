import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { Snapshot } from '../store';
import { NotebookPanel } from './NotebookPanel';

const snapshot: Snapshot = { paragraphs: [], items: [], profile: [], jobs: [] };
const props = { save: () => {}, storageStatus: 'saved' as const, snapshot, configured: true, ready: true,
  trySample: () => {}, removeSample: () => {} };
it('offers a sample only when empty and labels an active sample', () => {
  const empty = renderToStaticMarkup(<NotebookPanel {...props} text="" />);
  expect(empty).toContain('Try a sample plan');
  expect(empty).toContain('<label for="notebook"');
  const existing = renderToStaticMarkup(<NotebookPanel {...props} text="Existing private text" />);
  expect(existing).not.toContain('Try a sample plan');
  const sample = renderToStaticMarkup(<NotebookPanel {...props} text="Invented sample" sampleActive />);
  expect(sample).toContain('Sample plan (invented)');
  expect(sample).toContain('Remove sample');
  const activeEmpty = renderToStaticMarkup(<NotebookPanel {...props} text="" sampleActive />);
  expect(activeEmpty).not.toContain('Try a sample plan');
  const stored = { ...snapshot, paragraphs: [{ id: 'p', projectId: 'default', order: 0,
    text: 'Other tab text', version: 1, updatedAt: 1 }] };
  const storedEmpty = renderToStaticMarkup(<NotebookPanel {...props} snapshot={stored} text="" />);
  expect(storedEmpty).not.toContain('Try a sample plan');
  expect(renderToStaticMarkup(<NotebookPanel {...props} text="" storageStatus="saving" />))
    .not.toContain('Try a sample plan');
  for (const html of [empty, existing, sample]) {
    for (const button of html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)) {
      expect(button[1].replace(/<[^>]*>/g, '').trim()).not.toBe('');
    }
  }
});
