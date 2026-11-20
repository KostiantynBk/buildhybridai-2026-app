import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { stubSafeSuggestionParser } from './testSuggestionParser';
import { ResearchBlock } from '../ui/ResearchBlock';
import { NotebookPanel } from '../ui/NotebookPanel';
import type { Snapshot } from '../store';
import { researchApproved } from './researchFlow';
import type { CloudAdapter, ResearchResult } from './cloudResearch';

beforeEach(stubSafeSuggestionParser);
afterEach(() => vi.unstubAllGlobals());
const result: ResearchResult = {
  text: 'Answer: Café prices.\nCheck yourself: check official terms.',
  parts: ['Answer: Café prices.\nCheck yourself: check official terms.'],
  sources: [{ uri: 'https://example.com/', title: 'Example' }],
  supports: [{ partIndex: 0, startIndex: 0, endIndex: 21, indices: [0] }],
  suggestions: '<style>.google {color: red}</style><a href="https://google.com/search?q=test">Search</a>',
};
const entry = { id: 'e', question: 'What are hosting limits?', keptOut: ['SECRET'], cardId: 'c',
  itemLineageId: 'l', itemVersion: 1, status: 'approved' as const, createdAt: 1 };
it('sends only the stored approved question through a mock and renders its unmodified answer and sources', async () => {
  const checks = vi.fn().mockResolvedValue({ allowed: true, reason: null });
  const store = { snapshot: vi.fn().mockResolvedValue({ outbox: [entry], profile: ['PRIVATE'],
    paragraphs: ['NOTEBOOK'] }), preSendCheck: checks, reserveResearch: vi.fn().mockResolvedValue(1),
    finishResearch: vi.fn().mockResolvedValue(undefined), cancelResearch: vi.fn(),
    cloudConsent: vi.fn().mockResolvedValue(true) };
  const adapter = vi.fn<CloudAdapter>().mockResolvedValue({ source: 'in_cloud', result });
  const view = await researchApproved(store, adapter, 'e', 'model');
  expect(adapter).toHaveBeenCalledWith(entry.question, 'model');
  expect(checks).toHaveBeenCalledTimes(2);
  const markup = renderToStaticMarkup(<ResearchBlock result={view.result} />);
  expect(markup).toContain('Café prices.');
  expect(markup).toContain('Check yourself: check official terms.');
  expect(markup).toContain('https://example.com/');
  const snapshot: Snapshot = { paragraphs: [], items: [], jobs: [], profile: [], outbox: [entry], cards: [{
    id: 'c', paragraphId: 'p', paragraphVersion: 1, itemLineageId: 'l', itemVersion: 1,
    itemText: 'text', itemQuote: 'quote', topics: [], angle: 'cost-at-scale', sourceAngle: 'cost-at-scale',
    concern: 'concern',
    score: 1, lessonId: null, brief: false, sessionId: 's', questionStatus: 'ready', outboxId: 'e', createdAt: 1,
  }] };
  const card = renderToStaticMarkup(<NotebookPanel text="" save={() => {}} storageStatus="saved" snapshot={snapshot}
    configured ready research={{ e: view }} />);
  expect(card).toContain('What the research found');
  expect(card).toContain('Café prices.');
  expect(card).toContain('Question approved by you · Researched in the cloud');
  expect(card).not.toContain('Read on this device');
  const ungrounded = { ...view, result: { ...view.result, grounded: false, sources: [], supports: [],
    suggestions: '' } };
  const ungroundedCard = renderToStaticMarkup(<NotebookPanel text="" save={() => {}} storageStatus="saved"
    snapshot={snapshot} configured ready research={{ e: ungrounded }} />);
  expect(ungroundedCard.indexOf('This answer used no web sources.'))
    .toBeLessThan(ungroundedCard.indexOf('class="research-result"'));
  const job = { paragraphId: 'p', paragraphVersion: 1, status: 'done' as const, attempts: 1, createdAt: 0,
    nextRunAt: 0, measuredSource: 'on_device' as const };
  const measured: Snapshot = { ...snapshot, jobs: [
    { ...job, key: 'p@1#extract', step: 'extract', promptVersion: 'extract.v2' },
    { ...job, key: 'p@1#angles', step: 'angles', promptVersion: 'angles.v2.1' },
    { ...job, key: 'p@1#angles#question#c', step: 'question', promptVersion: 'question.v2.1', cardId: 'c' },
  ] };
  const measuredCard = renderToStaticMarkup(<NotebookPanel text="" save={() => {}} storageStatus="saved"
    snapshot={measured} configured ready research={{ e: view }} />);
  expect(measuredCard).toContain('Read on this device · Question approved by you · Researched in the cloud');
  const stale: Snapshot = { ...snapshot, dependencies: [{ consumerId: 'c', lineageId: 'l', version: 1 }],
    lineages: [{ lineageId: 'l', version: 2, itemId: 'i', paragraphId: 'p', paragraphVersion: 2,
      status: 'changed' }] };
  const staleCard = renderToStaticMarkup(<NotebookPanel text="" save={() => {}} storageStatus="saved"
    snapshot={stale} configured ready research={{ e: view }} />);
  expect(staleCard.indexOf('Your plan changed since this was checked.'))
    .toBeLessThan(staleCard.indexOf('class="research-result"'));
  expect(staleCard).toContain('Café prices.');
  const held = renderToStaticMarkup(<NotebookPanel text="" save={() => {}} storageStatus="saved" snapshot={stale}
    configured ready research={{ e: view }} searching={{ e: true }} />);
  const article = held.match(/<article class="item-card">([\s\S]*?)<\/article>/)?.[0] ?? '';
  expect((article.match(/role="status"/g) ?? [])).toHaveLength(1);
  expect(article).toContain('Your plan changed since this was checked.');
  expect(article).toContain('Searching the web');
  const uncertain: Snapshot = { ...stale, lineages: [{ ...stale.lineages![0], needsConfirmation: true }] };
  const uncertainCard = renderToStaticMarkup(<NotebookPanel text="" save={() => {}} storageStatus="saved"
    snapshot={uncertain} configured ready research={{ e: view }} />);
  expect(uncertainCard).toContain('We couldn&#x27;t confirm this still matches your plan.');
  expect(uncertainCard).not.toContain('Your plan changed since this was checked.');
  expect(uncertainCard).toContain('Café prices.');
  expect((uncertainCard.match(/We couldn&#x27;t confirm this still matches your plan\./g) ?? [])).toHaveLength(1);
  const changed = renderToStaticMarkup(<NotebookPanel text="" save={() => {}} storageStatus="saved"
    snapshot={snapshot} configured ready research={{ e: { ...view, changedAfterSend: true } }} />);
  expect(changed).toContain('Your privacy settings');
  expect(view.changedAfterSend).toBe(false);
});
it('rejects a non-cloud result and never displays it', async () => {
  const store = { snapshot: vi.fn().mockResolvedValue({ outbox: [entry] }),
    preSendCheck: vi.fn().mockResolvedValue({ allowed: true }), reserveResearch: vi.fn().mockResolvedValue(1),
    finishResearch: vi.fn().mockResolvedValue(undefined), cancelResearch: vi.fn(),
    cloudConsent: vi.fn().mockResolvedValue(true) };
  await expect(researchApproved(store, vi.fn().mockResolvedValue({ source: 'on_device', result }), 'e', 'm'))
    .rejects.toThrow('did not run in the cloud');
});
