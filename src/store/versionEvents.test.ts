import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { expect, it, vi } from 'vitest';
import { openLocalStore } from './index';

it('reports an upgrade blocked by a v3 connection and proceeds after it closes', async () => {
  const name = `version-blocked-${crypto.randomUUID()}`;
  const old = await openDB(name, 3, { upgrade(db) {
    for (const [store, keyPath] of [
      ['paragraphs', 'id'], ['paragraphVersions', ['id', 'version']], ['items', 'id'], ['profile', 'id'],
      ['jobs', 'key'], ['outbox', 'id'], ['meta', 'key'], ['lineageVersions', ['lineageId', 'version']],
      ['dependencies', ['consumerId', 'lineageId', 'version']], ['comparisonBatches', 'key'],
      ['privacy', 'key'], ['cards', 'id'], ['funnel', 'id'],
    ] as Array<[string, string | string[]]>) db.createObjectStore(store, { keyPath });
  } });
  const onBlocked = vi.fn();
  const pending = openLocalStore(name, { onBlocked });
  try {
    await vi.waitFor(() => expect(onBlocked).toHaveBeenCalledOnce());
    old.close();
    const upgraded = await pending;
    try { expect((await upgraded.snapshot()).paragraphs).toEqual([]); } finally { upgraded.close(); }
  } finally { old.close(); }
});
it('closes an open v5 connection and reports versionchange to the outdated tab', async () => {
  const name = `version-change-${crypto.randomUUID()}`;
  const onVersionChange = vi.fn();
  const store = await openLocalStore(name, { onVersionChange });
  try {
    const upgraded = await openDB(name, 6, { upgrade(db) { db.createObjectStore('future'); } });
    try {
      expect(onVersionChange).toHaveBeenCalledOnce();
      await expect(store.snapshot()).rejects.toBeDefined();
      expect(upgraded.version).toBe(6);
    } finally { upgraded.close(); }
  } finally { store.close(); }
});
