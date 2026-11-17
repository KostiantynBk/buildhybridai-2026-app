import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { expect, it } from 'vitest';
import { CLOUD_PROCESSING_DAILY_LIMIT, openLocalStore, STORE_VERSION } from './index';

it('migrates v5 without inventing consent or changing research receipts', async () => {
  const name = `cloud-v5-${crypto.randomUUID()}`;
  const old = await openDB(name, 5, { upgrade(db) {
    for (const [store, keyPath] of [
      ['paragraphs', 'id'], ['paragraphVersions', ['id', 'version']], ['items', 'id'], ['profile', 'id'],
      ['jobs', 'key'], ['outbox', 'id'], ['meta', 'key'], ['lineageVersions', ['lineageId', 'version']],
      ['dependencies', ['consumerId', 'lineageId', 'version']], ['comparisonBatches', 'key'],
      ['privacy', 'key'], ['cards', 'id'], ['funnel', 'id'], ['anglesConsidered', ['lineageId', 'version']],
    ] as Array<[string, string | string[]]>) db.createObjectStore(store, { keyPath });
    db.createObjectStore('research', { autoIncrement: true });
  } });
  await old.add('research', { entryId: 'earlier', sentAt: 123, status: 'completed' });
  old.close();
  const store = await openLocalStore(name);
  try {
    expect(await store.cloudModeConsent()).toBe(false);
    const snapshot = await store.snapshot();
    expect(snapshot.researchReceipts).toEqual([{ entryId: 'earlier', sentAt: 123, status: 'completed' }]);
    expect(snapshot.cloudProcessingSends).toEqual([]);
  } finally { store.close(); }
});
it('defaults to local-only and keeps cloud processing budget separate, atomic and local-day bounded', async () => {
  const name = `cloud-mode-${crypto.randomUUID()}`;
  const store = await openLocalStore(name);
  const second = await openLocalStore(name);
  try {
    expect(await store.cloudModeConsent()).toBe(false);
    expect(await store.reserveCloudProcessing()).toBeNull();
    await store.setCloudModeConsent(true);
    const day = new Date(2026, 10, 16, 12).getTime();
    const calls = await Promise.all(Array.from({ length: 160 }, (_, index) =>
      (index % 2 ? store : second).reserveCloudProcessing(day)));
    expect(calls.filter(value => value !== null)).toHaveLength(CLOUD_PROCESSING_DAILY_LIMIT);
    expect(await store.reserveCloudProcessing(day)).toBeNull();
    expect(await store.reserveResearch('different-budget', 1, day)).not.toBeNull();
    expect(await store.reserveCloudProcessing(new Date(2026, 10, 17, 12).getTime())).not.toBeNull();
    expect((await store.snapshot()).cloudProcessingSends).toHaveLength(151);
  } finally { store.close(); second.close(); }
});
it('moves a new eligible waiting extraction only on explicit opt-in, leaving legacy work local', async () => {
  const name = `cloud-opt-in-${crypto.randomUUID()}`;
  const store = await openLocalStore(name);
  try {
    await store.saveNotebook('This existing paragraph contains enough words for a queued extraction to be created.', 0);
    await store.enqueueSettled(4000, 'extract.v2');
    expect((await store.snapshot()).jobs[0].runMode).toBe('on_device');
    await store.setCloudModeConsent(true);
    expect((await store.snapshot()).jobs[0].runMode).toBe('in_cloud');
    expect((await store.claim(4000, 'in_cloud'))?.job.runMode).toBe('in_cloud');
  } finally { store.close(); }
});
it('revoking consent cancels queued/running cloud jobs and their late output cannot be adopted', async () => {
  const name = `cloud-revoke-${crypto.randomUUID()}`;
  const store = await openLocalStore(name);
  try {
    await store.setCloudModeConsent(true);
    await store.saveNotebook('This paragraph has many words so the local scheduler will schedule an extraction job.',
      0);
    await store.enqueueSettled(4000, 'extract.v2', 'in_cloud');
    const job = await store.claim(4000, 'in_cloud');
    expect(job?.job.runMode).toBe('in_cloud');
    await store.setCloudModeConsent(false);
    expect((await store.snapshot()).jobs[0].status).toBe('failed');
    expect(await store.complete(job!.job, [{ kind: 'assumption', text: 'Late', quote: 'paragraph', topics: ['other'] }],
      5000, 'in_cloud')).toBe(false);
    expect((await store.snapshot()).items).toEqual([]);
    expect(await store.claim(5000, 'in_cloud')).toBeNull();
  } finally { store.close(); }
});
it('never claims legacy why-note jobs in cloud mode', async () => {
  const name = `cloud-legacy-${crypto.randomUUID()}`;
  const store = await openLocalStore(name);
  try {
    await store.setCloudModeConsent(true);
    await store.saveNotebook('This paragraph has many words to make sure a persisted job has a valid current ' +
      'paragraph.', 0);
    const paragraph = (await store.snapshot()).paragraphs[0];
    const db = await openDB(name, STORE_VERSION);
    try {
      await db.put('jobs', { key: 'legacy', paragraphId: paragraph.id, paragraphVersion: paragraph.version,
        step: 'whynote', promptVersion: 'whynote.v2', status: 'pending', runMode: 'in_cloud',
        cardId: 'card', attempts: 0, createdAt: 1, nextRunAt: 1 });
    } finally { db.close(); }
    expect(await store.claim(10, 'in_cloud')).toBeNull();
    expect((await store.snapshot()).jobs.find(job => job.key === 'legacy')?.status).toBe('pending');
  } finally { store.close(); }
});
