import 'fake-indexeddb/auto';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { openLocalStore } from '../store';
import { researchIdea, UngroundedIdeaError } from './researchFlow';
import { IdeaPanel } from '../ui/IdeaPanel';
import { OutboxPage } from '../ui/OutboxPage';
import { stubSafeSuggestionParser } from './testSuggestionParser';

const plan = 'Builders use this notebook to plan products and keep assumptions, limits and decisions visible.';
async function setup() {
  const store = await openLocalStore(`grounding-${crypto.randomUUID()}`);
  await store.saveNotebook(plan, 0); await store.enqueueSettled(4000, 'extract.v2');
  const job = await store.claim(4000);
  await store.complete(job!.job, [
    { kind: 'assumption', text: 'Builders plan products', quote: 'Builders use this notebook', topics: [] },
    { kind: 'decision', text: 'Keep decisions visible', quote: 'decisions visible', topics: [] },
    { kind: 'constraint', text: 'Keep limits visible', quote: 'limits and decisions', topics: [] },
  ], 4000, 'on_device');
  await store.finalizeReady();
  const idea = (await store.startIdea(5000)).idea!;
  const describe = (await store.claim(5000))!.job;
  const text = 'A notebook helps builders document their product plans and decisions.';
  await store.finishIdeaDraft(describe, text, ['project name'], 5000);
  const entryId = (await store.approveIdea(idea.id, text, 5000)).entryId!;
  await store.setCloudConsent(true);
  return { store, idea, entryId };
}
afterEach(() => vi.unstubAllGlobals());
it('completes ungrounded idea research without saving or rendering the answer or retrying', async () => {
  const { store, idea, entryId } = await setup();
  try {
    const adapter = vi.fn().mockResolvedValue({ source: 'in_cloud', result: { text: 'UNTRUSTED_FAKE_ANSWER',
      parts: ['UNTRUSTED_FAKE_ANSWER'], sources: [], supports: [], suggestions: '', grounded: false } });
    await expect(researchIdea(store, adapter, idea.id, 'model', { budget: 10 })).rejects.toBeInstanceOf(
      UngroundedIdeaError);
    expect(adapter).toHaveBeenCalledOnce();
    let snapshot = await store.snapshot();
    expect(snapshot.researchReceipts).toMatchObject([{ entryId, status: 'completed', failureCode: 'ungrounded' }]);
    expect(JSON.stringify(snapshot)).not.toContain('UNTRUSTED_FAKE_ANSWER');
    await store.resume(); snapshot = await store.snapshot();
    expect(snapshot.ideas![0].status).toBe('sent');
    const html = renderToStaticMarkup(<IdeaPanel snapshot={snapshot} idea={snapshot.ideas![0]}
      start={async () => {}} send={async () => {}} retry={async () => {}} decline={async () => {}} />);
    expect(html).toContain('No web sources were attached, so the answer isn&#x27;t shown.');
    expect(html).toContain('Research again');
    expect(html).not.toContain('UNTRUSTED_FAKE_ANSWER');
    const unsafeView = { result: { text: 'UNTRUSTED_FAKE_ANSWER', parts: ['UNTRUSTED_FAKE_ANSWER'], sources: [],
      supports: [], suggestions: '', grounded: false }, sentAt: 1, latencyMs: 1, attempts: 1, changedAfterSend: false };
    const guarded = renderToStaticMarkup(<IdeaPanel snapshot={snapshot} idea={snapshot.ideas![0]} view={unsafeView}
      start={async () => {}} send={async () => {}} retry={async () => {}} decline={async () => {}} />);
    expect(guarded).not.toContain('UNTRUSTED_FAKE_ANSWER');
    const outbox = renderToStaticMarkup(<OutboxPage entries={snapshot.outbox!} snapshot={snapshot}
      decide={async () => true} remove={async () => {}} />);
    expect(outbox).toContain('Sent; no web sources were provided.');
    expect(outbox).toContain('Left out of the description');
  } finally { store.close(); }
});
it('keeps a grounded idea result unchanged, including its suggestions', async () => {
  stubSafeSuggestionParser();
  const { store, idea } = await setup();
  try {
    const result = { text: 'FAKE sourced answer', parts: ['FAKE sourced answer'], sources: [], supports: [],
      suggestions: '<a href="https://google.com/search?q=test">Search</a>', grounded: true };
    const adapter = vi.fn().mockResolvedValue({ source: 'in_cloud', result });
    const view = await researchIdea(store, adapter, idea.id, 'model', { budget: 10 });
    expect(view.result).toEqual(result);
    const snapshot = await store.snapshot();
    const html = renderToStaticMarkup(<IdeaPanel snapshot={snapshot} idea={snapshot.ideas![0]} view={view}
      start={async () => {}} send={async () => {}} retry={async () => {}} decline={async () => {}} />);
    expect(html).toContain('FAKE sourced answer');
    expect(html).not.toContain('answer isn&#x27;t shown');
    expect(snapshot.researchReceipts).toMatchObject([{ status: 'completed' }]);
    expect(snapshot.researchReceipts![0].failureCode).toBeUndefined();
  } finally { store.close(); }
});
