import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { Snapshot } from '../store';
import { NotebookPanel } from './NotebookPanel';

const snapshot: Snapshot = { paragraphs: [], items: [], profile: [], jobs: [] };
const props = { save: () => {}, storageStatus: 'saved' as const, snapshot, configured: true, ready: true,
  trySample: () => {}, removeSample: () => {} };
it('leaves sample loading to the welcome and labels the invented sample', () => {
  const empty = renderToStaticMarkup(<NotebookPanel {...props} text="" />);
  expect(empty).not.toContain('Try a sample plan');
  expect(empty).toContain('<label for="notebook"');
  const existing = renderToStaticMarkup(<NotebookPanel {...props} text="Existing private text" />);
  expect(existing).not.toContain('Try a sample plan');
  const sample = renderToStaticMarkup(<NotebookPanel {...props} text="Invented sample" sampleActive />);
  expect(sample).toContain('Sample plan (invented)');
  expect(sample).toContain('Remove sample');
  for (const html of [empty, existing, sample]) {
    for (const button of html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)) {
      expect(button[1].replace(/<[^>]*>/g, '').trim()).not.toBe('');
    }
  }
});
