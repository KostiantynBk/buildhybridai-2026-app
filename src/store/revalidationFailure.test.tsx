import { seedLegacyPending } from './legacyPendingFixture';
import 'fake-indexeddb/auto';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
// This regression explicitly exercises the pinned v2 path.
vi.mock('../pipeline/triageVersion', async importOriginal => ({
  ...(await importOriginal<typeof import('../pipeline/triageVersion')>()), TRIAGE_PROMPT_SET: 'v2',
}));

import type { Job } from '../ai/localModel';
import { anglesV2 } from '../pipeline/prompts/angles.v2';
import { compareV1 } from '../pipeline/prompts/compare.v1';
import { questionV21 as questionV2 } from '../pipeline/prompts/question.v2.1';
import { checkFirstMark } from './t08Fixtures';
import { whynoteV2 } from '../pipeline/prompts/whynote.v2';
import { NotebookPanel } from '../ui/NotebookPanel';
import { openLocalStore } from './index';
import { Scheduler, type LocalService } from './scheduler';

const paragraph = 'The hosting service supports fifty users at once and provides a simple catalogue for visitors.';
const oldQuote = 'The hosting service supports fifty users at once';
const response = (data: unknown) => ({ data, source: 'on_device', latencyMs: 1, raw: '{}' });

for (const scenario of ['waiting-extraction', 'ready-extraction', 'ready-comparison'] as const) {
  it(`resolves terminal ${scenario}, including reopen and recovery only via new proof`, async () => {
    const name = `terminal-proof-${crypto.randomUUID()}`;
    let store = await openLocalStore(name);
    await store.saveNotebook(paragraph, 0);
    let now = 20000;
    let failing = false;
    let forceExtractionFailure = false;
    let release!: (value: ReturnType<typeof response>) => void;
    let held = false;
    const run = vi.fn(async (job: Job<unknown>) => {
      job.onDispatch?.();
      if (job.instructions === anglesV2) return response({ concerns: [{ item: 1, angle: 'end-user',
        concern: 'Can this be checked?', checkable: true }] });
      if (job.instructions === questionV2) {
        if (scenario === 'waiting-extraction' && !held) {
          held = true; return new Promise<ReturnType<typeof response>>(resolve => { release = resolve; });
        }
        return response({ question: 'What are hosting limits?', keptOut: [] });
      }
      if (job.instructions === whynoteV2) {
        if (scenario !== 'waiting-extraction' && !held) {
          held = true; return new Promise<ReturnType<typeof response>>(resolve => { release = resolve; });
        }
        return response({ seeing: 'You are planning hosting.', why: 'Relevant.', used: [] });
      }
      if (job.instructions === compareV1) {
        if (failing) throw new Error('Synthetic comparison failure');
        return response({ status: 'changed', newQuote: oldQuote.replace('fifty', 'twenty') });
      }
      if ((failing && scenario !== 'ready-comparison') || forceExtractionFailure) {
        throw new Error('Synthetic extraction failure');
      }
      const quote = job.prompt.includes('twenty') ? oldQuote.replace('fifty', 'twenty') : oldQuote;
      return response({ items: [{ kind: 'assumption', text: 'Hosting capacity', quote, topics: ['hosting'] }] });
    });
    const service = { state: { kind: 'ready' }, subscribe: () => () => {}, runLocal: run } as unknown as LocalService;
    let scheduler = new Scheduler(store, service, () => 'extract.v2', () => {}, () => now);
    try {
      await scheduler.start(); await scheduler.tick();
      await checkFirstMark(store);
      if (scenario !== 'waiting-extraction') await scheduler.tick();
      const inflight = scheduler.tick();
      await vi.waitFor(() => expect(held).toBe(true));
      let before = await store.snapshot();
      const card = before.cards![0];
      const approved = scenario !== 'waiting-extraction'
        ? await store.approveDraft(card.id, card.draftQuestion!) : {};
      const originalEntryId = approved.entryId;
      if (scenario !== 'waiting-extraction') expect(originalEntryId).toBeDefined();
      before = await store.snapshot();
      const originalLineage = card.itemLineageId;
      if (scenario !== 'waiting-extraction') {
        const prior = before.outbox![0];
        expect(await seedLegacyPending(store, { ...prior, id: 'history-rejected',
          question: 'What are public limits?' })).toBe(true);
        expect(await store.decideOutbox('history-rejected', 'rejected')).toBe(true);
        expect(await seedLegacyPending(store, { ...prior, id: 'history-withdrawn',
          question: 'What about Private Example?' })).toBe(true);
        await store.putNeverSend(['Private Example']);
        await store.putNeverSend([]);
      }
      const edited = scenario === 'ready-comparison' ? paragraph.replace('fifty', 'twenty') : `${paragraph} Extra.`;
      scheduler.edited(edited, before.paragraphs);
      await store.saveNotebook(edited, 10000);
      failing = true;
      scheduler.saved();
      release(response(scenario === 'waiting-extraction' ? { question: 'Late question?', keptOut: [] }
        : { seeing: 'You are planning.', why: 'Late note.', used: [] }));
      await inflight;
      for (let i = 0; i < 5; i++) { await scheduler.tick(); now += 30000; }
      let snapshot = await store.snapshot();
      const current = snapshot.paragraphs[0];
      const failed = snapshot.cards!.find(value => value.id === card.id)!;
      expect(failed.recheckFailedVersion).toBe(current.version);
      expect(failed.itemLineageId).toBe(originalLineage);
      expect(snapshot.jobs.filter(job => job.cardId === card.id && ['question', 'whynote'].includes(job.step) &&
        ['pending', 'running'].includes(job.status))).toHaveLength(0);
      const failedDependent = snapshot.jobs.find(job => job.cardId === card.id &&
        job.failureReason === 'revalidation-failed');
      expect(failedDependent?.attempts).toBe(1);
      if (scenario !== 'waiting-extraction') {
        expect(snapshot.outbox!.find(entry => entry.id === originalEntryId))
          .toMatchObject({ status: 'withdrawn', withdrawReason: 'stale' });
        expect(snapshot.outbox!.find(entry => entry.id === 'history-rejected')?.status).toBe('rejected');
        expect(snapshot.outbox!.find(entry => entry.id === 'history-withdrawn'))
          .toMatchObject({ status: 'withdrawn', withdrawReason: 'listed-term' });
      }
      const html = renderToStaticMarkup(<NotebookPanel text={edited} save={() => {}} snapshot={snapshot}
        storageStatus="saved" configured ready />);
      expect(html).toContain('We couldn&#x27;t confirm this still matches your plan. Check again.');
      if (scenario !== 'ready-comparison') expect(html).toContain('We could not finish reading this paragraph.');
      scheduler.stop(); store.close();
      store = await openLocalStore(name);
      scheduler = new Scheduler(store, service, () => 'extract.v2', () => {}, () => now);
      const prerequisiteCalls = () => run.mock.calls.filter(call => call[0].instructions === compareV1 ||
        ![anglesV2, questionV2, whynoteV2].includes(call[0].instructions as typeof anglesV2)).length;
      const calls = prerequisiteCalls();
      await scheduler.start(); await scheduler.tick();
      snapshot = await store.snapshot();
      expect(snapshot.cards!.find(value => value.id === card.id)?.recheckFailedVersion).toBe(current.version);
      expect(prerequisiteCalls()).toBe(calls);
      failing = false;
      now += 30000;
      const recoveredText = `${edited} Another unrelated sentence.`;
      scheduler.edited(recoveredText, snapshot.paragraphs);
      await store.saveNotebook(recoveredText, now - 5000);
      const pendingRecovery = await store.snapshot();
      const pendingHtml = renderToStaticMarkup(<NotebookPanel text={recoveredText} save={() => {}}
        snapshot={pendingRecovery} storageStatus="saved" configured ready />);
      expect(pendingHtml).toContain('We couldn&#x27;t confirm this still matches your plan. Check again.');
      scheduler.saved();
      for (let i = 0; i < 7; i++) { await scheduler.tick(); await new Promise(resolve => setTimeout(resolve, 0)); }
      await vi.waitFor(async () => {
        const state = await store.snapshot();
        const paragraphVersion = state.paragraphs[0].version;
        const head = (state.lineages ?? []).filter(value => value.lineageId === originalLineage)
          .sort((a, b) => b.version - a.version)[0];
        expect(head?.paragraphVersion).toBe(paragraphVersion);
        expect(head?.unchecked).not.toBe(true);
      }, { timeout: 5000 });
      snapshot = await store.snapshot();
      const latest = snapshot.paragraphs[0];
      expect(snapshot.jobs.some(job => job.step === 'extract' && job.paragraphVersion === latest.version &&
        job.status === 'done')).toBe(true);
      const recovered = renderToStaticMarkup(<NotebookPanel text={recoveredText} save={() => {}} snapshot={snapshot}
        storageStatus="saved" configured ready />);
      if (scenario !== 'ready-comparison') {
        expect(recovered).not.toContain('<p role="status">We couldn&#x27;t confirm this still matches your plan.');
      }
      expect(recovered).not.toContain('We could not finish reading this paragraph.');
      if (scenario !== 'waiting-extraction') {
        expect(snapshot.outbox!.find(entry => entry.id === originalEntryId)?.status).toBe('withdrawn');
      }
      expect(snapshot.jobs.find(job => job.key === failedDependent?.key)?.attempts).toBe(1);
      expect(snapshot.jobs.every(job => job.attempts <= 3)).toBe(true);
      if (scenario === 'ready-comparison') return;
      const recoveredCard = snapshot.cards!.find(value => value.id === card.id)!;
      expect(recoveredCard.recheckFailedVersion).toBeUndefined();
      expect(recoveredCard.itemLineageId).toBe(card.itemLineageId);
      expect(recoveredCard.itemVersion).toBe(card.itemVersion);
      expect(recoveredCard.questionStatus).toBe(scenario === 'waiting-extraction' ? 'blocked' : 'ready');
      const nextText = `${recoveredText} One more new sentence.`;
      now += 30000;
      scheduler.edited(nextText, snapshot.paragraphs);
      await store.saveNotebook(nextText, now - 5000);
      const pendingNext = await store.snapshot();
      const nextHtml = renderToStaticMarkup(<NotebookPanel text={nextText} save={() => {}} snapshot={pendingNext}
        storageStatus="saved" configured ready />);
      expect(nextHtml).not.toContain('<p role="status">We couldn&#x27;t confirm this still matches your plan.');
      {
        forceExtractionFailure = true;
        scheduler.saved();
        for (let attempt = 1; attempt <= 3; attempt++) {
          await vi.waitFor(async () => {
            await scheduler.tick();
            const state = await store.snapshot();
            const extraction = state.jobs.find(job => job.step === 'extract' &&
              job.paragraphVersion === state.paragraphs[0].version);
            expect(extraction?.attempts).toBeGreaterThanOrEqual(attempt);
            expect(extraction?.status).toBe(attempt === 3 ? 'failed' : 'pending');
          }, { timeout: 5000 });
          now += 30000;
        }
        await vi.waitFor(async () => {
          const state = await store.snapshot();
          expect(state.cards!.find(value => value.id === card.id)?.recheckFailedVersion)
            .toBe(state.paragraphs[0].version);
        }, { timeout: 5000 });
        const terminal = await store.snapshot();
        const terminalHtml = renderToStaticMarkup(<NotebookPanel text={nextText} save={() => {}} snapshot={terminal}
          storageStatus="saved" configured ready />);
        expect(terminalHtml).toContain('We couldn&#x27;t confirm this still matches your plan. Check again.');
        expect(terminal.jobs.find(job => job.key === failedDependent?.key)?.attempts).toBe(1);
        if (scenario === 'ready-extraction') {
          expect(terminal.outbox!.find(entry => entry.id === originalEntryId)?.status).toBe('withdrawn');
        }
      }
    } finally { scheduler.stop(); store.close(); }
  }, 15000);
}
