import { seedLegacyPending } from '../store/legacyPendingFixture';
import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { stubSafeSuggestionParser } from './testSuggestionParser';
import { openLocalStore } from '../store';
import { researchApproved } from './researchFlow';
import type { CloudAdapter, ResearchResult } from './cloudResearch';

beforeEach(stubSafeSuggestionParser);
afterEach(() => vi.unstubAllGlobals());
const result: ResearchResult = { text: 'UNIQUE_GROUNDED_ANSWER', parts: ['UNIQUE_GROUNDED_ANSWER'],
  sources: [{ uri: 'https://example.com/UNIQUE_SOURCE', title: 'UNIQUE_SOURCE_TITLE' }],
  supports: [{ partIndex: 0, startIndex: 0, endIndex: 22, indices: [0] }],
  suggestions: '<div>UNIQUE_SUGGESTIONS</div>' };
async function fixture() {
  const name = `research-${crypto.randomUUID()}`;
  const store = await openLocalStore(name);
  const text = 'The hosting service permits fifty visitors at once while serving a public catalogue.';
  await store.saveNotebook(text, 0);
  await store.enqueueSettled(4000, 'extract.v2');
  const claimed = await store.claim(4000);
  if (!claimed) throw new Error('Missing extraction');
  await store.complete(claimed.job, [{ kind: 'assumption', text: 'Hosting capacity',
    quote: 'The hosting service permits fifty visitors at once', topics: ['hosting'] }], 4000);
  await store.finalizeReady();
  const lineageId = (await store.snapshot()).items[0].lineageId!;
  await seedLegacyPending(store, { id: 'entry', cardId: 'card', question: 'What are public hosting limits?',
    keptOut: [], itemLineageId: lineageId, itemVersion: 1, createdAt: 10 });
  await store.decideOutbox('entry', 'approved');
  await store.setCloudConsent(true);
  return { store, name };
}
it('keeps every result sentinel out of every IndexedDB store, even across a post-send privacy change', async () => {
  const { store, name } = await fixture();
  try {
    const adapter: CloudAdapter = async () => {
      await store.putNeverSend(['hosting']);
      return { source: 'in_cloud', result };
    };
    const view = await researchApproved(store, adapter, 'entry', 'model');
    expect(view.changedAfterSend).toBe(true);
    expect(view.result).toEqual(result);
    const db = await openDB(name);
    try {
      for (const name of Array.from(db.objectStoreNames)) {
        const all = JSON.stringify(await db.getAll(name));
        expect(all).not.toContain('UNIQUE_GROUNDED_ANSWER');
        expect(all).not.toContain('UNIQUE_SOURCE');
        expect(all).not.toContain('UNIQUE_SUGGESTIONS');
      }
      expect(await db.getAll('research')).toEqual([{ entryId: 'entry', sentAt: view.sentAt, status: 'completed' }]);
    } finally { db.close(); }
  } finally { store.close(); }
});
it('enforces consent, atomic daily budget, and local-day reset', async () => {
  const { store } = await fixture();
  try {
    expect(await store.cloudConsent()).toBe(true);
    await store.setCloudConsent(false);
    const adapter = vi.fn<CloudAdapter>().mockResolvedValue({ source: 'in_cloud', result });
    await expect(researchApproved(store, adapter, 'entry', 'm')).rejects.toThrow('cannot be sent');
    expect(adapter).not.toHaveBeenCalled();
    await store.setCloudConsent(true);
    await expect(researchApproved(store, adapter, 'entry', 'm', { enabled: false, budget: 20 }))
      .rejects.toThrow('disabled');
    await expect(researchApproved(store, adapter, 'entry', 'm', { budget: 0 })).rejects.toThrow('limit reached');
    expect(adapter).not.toHaveBeenCalled();
    const day = new Date(2026, 10, 16, 12).getTime();
    const next = new Date(2026, 10, 17, 12).getTime();
    const reservations = await Promise.all([store.reserveResearch('x', 1, day), store.reserveResearch('y', 1, day)]);
    expect(reservations.filter(value => value !== null)).toHaveLength(1);
    expect(await store.reserveResearch('z', 1, next)).not.toBeNull();
    expect(await store.cloudConsent()).toBe(true);
    await store.setCloudConsent(false);
    expect(await store.cloudConsent()).toBe(false);
  } finally { store.close(); }
});
it.each([
  [{ customData: { status: 403, errorDetails: [{ reason: 'BILLING_DISABLED' }] } }, 'billing is unavailable'],
  [{ message: 'quota exceeded', customData: { status: 429 } }, 'cloud budget is used up'],
  [{ blockReason: 'SAFETY', customData: { status: 400 } }, 'safety'],
])('does not retry billing, quota or safety errors', async (error, expected) => {
  const { store } = await fixture();
  try {
    const adapter = vi.fn<CloudAdapter>().mockRejectedValue(error);
    await expect(researchApproved(store, adapter, 'entry', 'm')).rejects.toThrow(expected);
    expect(adapter).toHaveBeenCalledOnce();
  } finally { store.close(); }
});
it('rejects missing attribution but reports response counts without the result', async () => {
  const { store } = await fixture();
  try {
    const measured = vi.fn();
    const adapter = vi.fn<CloudAdapter>().mockResolvedValue({ source: 'in_cloud',
      result: { ...result, suggestions: '' } });
    await expect(researchApproved(store, adapter, 'entry', 'm', { budget: 20, onResponse: measured }))
      .rejects.toThrow('required Search sources and suggestions');
    expect(adapter).toHaveBeenCalledOnce();
    expect(measured).toHaveBeenCalledWith(expect.objectContaining({ sourceCount: 1, suggestionsPresent: false,
      inCloud: true }));
    expect(JSON.stringify(measured.mock.calls)).not.toContain('UNIQUE_');
    expect((await store.snapshot()).researchReceipts?.[0].status).toBe('failed');
  } finally { store.close(); }
});
it('retries a genuine network error once and counts both attempts', async () => {
  const { store } = await fixture();
  try {
    const adapter = vi.fn<CloudAdapter>().mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ source: 'in_cloud', result });
    const view = await researchApproved(store, adapter, 'entry', 'm');
    expect(view.attempts).toBe(2);
    expect(adapter).toHaveBeenCalledTimes(2);
    expect((await store.snapshot()).researchReceipts?.map(value => value.status)).toEqual(['failed', 'completed']);
  } finally { store.close(); }
});
