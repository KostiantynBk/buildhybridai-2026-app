import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { LocalModelService } from '../ai/localModel';
import type { Snapshot } from '../store';
import { StatusBar } from './StatusBar';
import { OutboxPage } from './OutboxPage';
import { NotebookPanel } from './NotebookPanel';
import { Notices } from './Notices';

it('labels cloud mode and exposes a choice when local inference is unavailable', () => {
  const service = { state: { kind: 'unsupported' }, browserAvailability: 'unsupported', warmLatencyMs: null,
    privacyFaults: 0, preparing: false, retryRequired: false } as LocalModelService;
  const bar = renderToStaticMarkup(<StatusBar service={service} configured foreground cloudMode />);
  expect(bar).toContain('Cloud mode');
  const hidden = renderToStaticMarkup(<StatusBar service={service} configured foreground={false} cloudMode />);
  expect(hidden).toContain('Paused while away');
  const discarded = renderToStaticMarkup(<StatusBar service={service} configured foreground
    cloudMessage="Cloud response discarded because cloud mode was switched off." />);
  expect(discarded).toContain('Cloud response discarded');
  const notice = renderToStaticMarkup(<Notices configured state={service.state} cloudEnabled chooseCloud={() => {}} />);
  expect(notice).toContain('Set up Chrome');
  expect(notice).toContain('Use cloud mode instead');
});
it('shows measured cloud route and timestamp-only processing ledger', () => {
  const job = { paragraphId: 'p', paragraphVersion: 1, status: 'done' as const, attempts: 1, createdAt: 0,
    nextRunAt: 0, measuredSource: 'in_cloud' as const, runMode: 'in_cloud' as const };
  const snapshot: Snapshot = { paragraphs: [], items: [], profile: [], cloudProcessingSends: [1234], jobs: [
    { ...job, key: 'p@1#extract', step: 'extract', promptVersion: 'extract.v2' },
    { ...job, key: 'p@1#angles', step: 'angles', promptVersion: 'angles.v2.1' },
    { ...job, key: 'p@1#angles#question#c', step: 'question', promptVersion: 'question.v2.1', cardId: 'c' },
  ], cards: [{ id: 'c', paragraphId: 'p', paragraphVersion: 1, itemLineageId: 'l', itemVersion: 1,
    itemText: 'text', itemQuote: 'quote', topics: [], angle: 'end-user', sourceAngle: 'end-user',
    concern: 'concern', score: 1, lessonId: null, brief: false, sessionId: 's', questionStatus: 'ready',
    createdAt: 1 }] };
  const card = renderToStaticMarkup(<NotebookPanel text="" save={() => {}} storageStatus="saved" snapshot={snapshot}
    configured ready />);
  expect(card).toContain('Read in the cloud');
  expect(card).not.toContain('Read on this device');
  const outbox = renderToStaticMarkup(<OutboxPage entries={[]} snapshot={snapshot} decide={async () => true}
    remove={async () => {}} />);
  expect(outbox).toContain('1 attempts');
  expect(outbox).toContain('plan text is not listed');
});
