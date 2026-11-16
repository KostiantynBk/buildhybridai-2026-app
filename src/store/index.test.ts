import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEGACY_KEY, LocalStore, MIN_WORDS, openLocalStore, SETTLE_MS, wordCount } from './index';

const long = 'one two three four five six seven eight nine ten eleven twelve thirteen';
let store: LocalStore;
const data = new Map<string, string>();
const legacy = { getItem: (key: string) => data.get(key) ?? null, removeItem: (key: string) => { data.delete(key); } };
beforeEach(async () => { data.clear(); store = await openLocalStore(`test-${crypto.randomUUID()}`); });
afterEach(() => store.close());

describe('local store', () => {
  it('creates an empty schema and migrates legacy text once after commit', async () => {
    expect(await store.snapshot()).toEqual({ paragraphs: [], items: [], profile: [], jobs: [], lineages: [],
      neverSend: [], cards: [], outbox: [],
      dependencies: [], researchReceipts: [] });
    data.set(LEGACY_KEY, `${long}\n\nanother paragraph`);
    await store.migrate(legacy);
    expect(data.has(LEGACY_KEY)).toBe(false);
    expect((await store.snapshot()).paragraphs.map(p => p.text)).toEqual([long, 'another paragraph']);
    expect(await store.versions()).toHaveLength(2);
    data.set(LEGACY_KEY, 'new legacy text must not overwrite');
    await store.migrate(legacy);
    expect((await store.snapshot()).paragraphs[0].text).toBe(long);
    expect(data.has(LEGACY_KEY)).toBe(false);
  });
  it('does not duplicate a committed migration if legacy-key removal failed', async () => {
    data.set(LEGACY_KEY, long);
    await expect(store.migrate({ ...legacy, removeItem: () => { throw new Error('blocked'); } })).rejects.toThrow();
    await store.migrate(legacy);
    expect((await store.snapshot()).paragraphs).toHaveLength(1);
    expect(await store.versions()).toHaveLength(1);
  });
  it('rolls back an aborted migration without losing the legacy text or emitting an unhandled rejection', async () => {
    data.set(LEGACY_KEY, long);
    const unhandled: unknown[] = [];
    const listener = (error: unknown) => { unhandled.push(error); };
    process.on('unhandledRejection', listener);
    const original = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore, value, key,
    ) {
      if (this.name === 'paragraphVersions') {
        this.transaction.abort();
        throw new DOMException('Injected abort', 'AbortError');
      }
      return key === undefined ? original.call(this, value) : original.call(this, value, key);
    });
    try {
      await expect(store.migrate(legacy)).rejects.toMatchObject({ name: 'AbortError' });
      await new Promise<void>(resolve => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
      expect(data.get(LEGACY_KEY)).toBe(long);
      expect((await store.snapshot()).paragraphs).toEqual([]);
      spy.mockRestore();
      await store.migrate(legacy);
      expect((await store.snapshot()).paragraphs).toHaveLength(1);
    } finally {
      spy.mockRestore();
      process.off('unhandledRejection', listener);
    }
  });
  it('records versions, applies settle and minimum-words gates, and deduplicates jobs', async () => {
    const [first] = await store.saveNotebook(long, 1000);
    expect(wordCount(long)).toBeGreaterThanOrEqual(MIN_WORDS);
    await store.enqueueSettled(1000 + SETTLE_MS - 1, 'extract.v2');
    expect((await store.snapshot()).jobs).toHaveLength(0);
    await store.enqueueSettled(1000 + SETTLE_MS, 'extract.v2');
    await store.enqueueSettled(1000 + SETTLE_MS + 1, 'extract.v1');
    expect((await store.snapshot()).jobs).toHaveLength(1);
    expect((await store.snapshot()).jobs[0].promptVersion).toBe('extract.v2');
    await store.saveNotebook(`${long} fourteen`, 9000);
    expect((await store.snapshot()).jobs[0].status).toBe('superseded');
    expect((await store.versions()).map(p => p.version)).toEqual([1, 2]);
    await store.saveNotebook('too short', 10000);
    await store.enqueueSettled(10000 + SETTLE_MS, 'extract.v2');
    expect((await store.snapshot()).jobs.filter(j => j.paragraphId !== first.id)).toHaveLength(0);
  });
  it('atomically discards old results, links new items and supersedes earlier items', async () => {
    const [first] = await store.saveNotebook(long, 0);
    await store.enqueueSettled(SETTLE_MS, 'extract.v2');
    const old = await store.claim(SETTLE_MS);
    if (!old) throw new Error('job missing');
    await store.saveNotebook(`${long} fourteen`, 5000);
    expect(await store.complete(old.job, [{ kind: 'assumption', text: 'old', quote: 'one', topics: [] }])).toBe(false);
    await store.enqueueSettled(9000, 'extract.v2');
    const current = await store.claim(9000);
    if (!current) throw new Error('job missing');
    expect(await store.complete(current.job, [{ kind: 'decision', text: 'new', quote: 'one two', topics: [] },
      { kind: 'assumption', text: 'not exact', quote: 'ONE TWO', topics: [] }], 10000)).toBe(true);
    let snapshot = await store.snapshot();
    expect(snapshot.items).toHaveLength(2);
    expect(snapshot.items[0]).toMatchObject({ paragraphId: first.id, paragraphVersion: 2, status: 'current' });
    expect(snapshot.items.some(item => item.quote === 'ONE TWO')).toBe(true);
    await store.saveNotebook(`${long} fourteen fifteen`, 11000);
    await store.enqueueSettled(15000, 'extract.v1');
    const next = await store.claim(15000);
    if (!next) throw new Error('job missing');
    await store.complete(next.job, [{ kind: 'decision', text: 'latest', quote: 'one', topics: [] }]);
    snapshot = await store.snapshot();
    expect(snapshot.items.map(item => item.status).sort()).toEqual(['current', 'superseded', 'superseded']);
    expect(snapshot.items.find(item => item.status === 'current')?.paragraphVersion).toBe(3);
  });
  it('counts interrupted attempts across reloads and never claims a fourth attempt', async () => {
    await store.saveNotebook(long, 0);
    await store.enqueueSettled(4000, 'extract.v2');
    const first = await store.claim(4000);
    if (!first) throw new Error('missing first claim');
    await store.fail(first.job, 'Error', false, 4000);
    expect(await store.claim(8999)).toBeNull();
    expect((await store.claim(9000))?.job.attempts).toBe(2);
    await store.resume();
    expect((await store.snapshot()).jobs[0]).toMatchObject({ status: 'pending', attempts: 2, nextRunAt: 9000 });
    expect((await store.claim(9000))?.job).toMatchObject({ status: 'running', attempts: 3 });
    await store.resume();
    expect((await store.snapshot()).jobs[0]).toMatchObject({ status: 'failed', attempts: 3,
      failureReason: 'interrupted-at-attempt-limit' });
    for (let i = 0; i < 4; i++) {
      await store.resume();
      expect(await store.claim(100000)).toBeNull();
    }
  });
  it('counts each interrupted dispatch on consecutive reloads', async () => {
    await store.saveNotebook(long, 0);
    await store.enqueueSettled(4000, 'extract.v2');
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect((await store.claim(4000))?.job.attempts).toBe(attempt);
      await store.resume();
    }
    expect(await store.claim(4000)).toBeNull();
    expect((await store.snapshot()).jobs[0]).toMatchObject({ status: 'failed', attempts: 3 });
  });
  it('persists CRUD, resumes running work and clears every application store', async () => {
    const profile = { id: 'profile1', type: 'skill' as const, depth: 'some' as const, text: 'React',
      topics: ['frontend'], tags: [], updatedAt: 1 };
    await store.putProfile(profile);
    await store.putProfile({ ...profile, text: 'TypeScript' });
    expect((await store.snapshot()).profile[0].text).toBe('TypeScript');
    await store.deleteProfile(profile.id);
    expect((await store.snapshot()).profile).toHaveLength(0);
    await store.replaceProfile([profile], ['secret']);
    await expect(store.replaceProfile([], ['x'.repeat(101)])).rejects.toThrow();
    expect((await store.snapshot()).profile).toEqual([profile]);
    expect((await store.snapshot()).neverSend).toEqual(['secret']);
    await store.saveNotebook(long, 0);
    await store.enqueueSettled(SETTLE_MS, 'extract.v2');
    await store.claim(SETTLE_MS);
    await store.resume();
    expect((await store.snapshot()).jobs[0].status).toBe('pending');
    data.set(LEGACY_KEY, 'also remove this');
    await store.clearAll(legacy);
    expect(await store.snapshot()).toEqual({ paragraphs: [], items: [], profile: [], jobs: [], lineages: [],
      neverSend: [], cards: [], outbox: [],
      dependencies: [], researchReceipts: [] });
    expect(await store.versions()).toEqual([]);
    expect(data.has(LEGACY_KEY)).toBe(false);
    await store.saveNotebook(long);
    expect((await store.snapshot()).paragraphs).toHaveLength(1);
  });
});
