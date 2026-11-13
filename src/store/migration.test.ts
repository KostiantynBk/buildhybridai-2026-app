import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { expect, it, vi } from 'vitest';
import { openLocalStore } from './index';

it('upgrades a v1 database and migrates only current items into independent v1 lineages', async () => {
  const name = `migration-${crypto.randomUUID()}`;
  const old = await openDB(name, 1, { upgrade(db) {
    db.createObjectStore('paragraphs', { keyPath: 'id' });
    db.createObjectStore('paragraphVersions', { keyPath: ['id', 'version'] });
    db.createObjectStore('items', { keyPath: 'id' });
    db.createObjectStore('profile', { keyPath: 'id' });
    db.createObjectStore('jobs', { keyPath: 'key' });
    db.createObjectStore('outbox', { keyPath: 'id' });
    db.createObjectStore('meta', { keyPath: 'key' });
  } });
  const item = { id: 'i1', paragraphId: 'p1', paragraphVersion: 1, kind: 'assumption', text: 'test',
    quote: 'test', topics: ['other'], status: 'current', promptVersion: 'extract.v2', createdAt: 0 };
  const paragraph = { id: 'p1', projectId: 'default', order: 0, text: 'test', version: 1, updatedAt: 0 };
  await old.put('paragraphs', paragraph);
  await old.put('paragraphVersions', paragraph);
  await old.put('items', item);
  await old.put('items', { ...item, id: 'i2', status: 'superseded' });
  await old.put('items', { ...item, id: 'i3' });
  old.close();
  const store = await openLocalStore(name);
  try {
    const versions = await store.lineages();
    expect(versions).toHaveLength(2);
    expect(new Set(versions.map(version => version.lineageId)).size).toBe(2);
    expect(versions.every(version => version.version === 1 && version.status === 'current')).toBe(true);
    const snapshot = await store.snapshot();
    expect(snapshot.paragraphs).toEqual([paragraph]);
    expect(await store.versions()).toEqual([paragraph]);
    expect(snapshot.items.find(value => value.id === 'i1')?.lineageId).toBeTruthy();
    expect(snapshot.items.find(value => value.id === 'i2')?.lineageId).toBeUndefined();
  } finally { store.close(); }
});

it('upgrades a v2 database without losing prior data and persists the new privacy list', async () => {
  const name = `migration-v2-${crypto.randomUUID()}`;
  const old = await openDB(name, 2, { upgrade(db) {
    db.createObjectStore('paragraphs', { keyPath: 'id' });
    db.createObjectStore('paragraphVersions', { keyPath: ['id', 'version'] });
    db.createObjectStore('items', { keyPath: 'id' });
    db.createObjectStore('profile', { keyPath: 'id' });
    db.createObjectStore('jobs', { keyPath: 'key' });
    db.createObjectStore('outbox', { keyPath: 'id' });
    db.createObjectStore('meta', { keyPath: 'key' });
    db.createObjectStore('lineageVersions', { keyPath: ['lineageId', 'version'] });
    db.createObjectStore('dependencies', { keyPath: ['consumerId', 'lineageId', 'version'] });
    db.createObjectStore('comparisonBatches', { keyPath: 'key' });
  } });
  const record = { id: 'p1', type: 'project', text: 'Local project', topics: [], tags: [], updatedAt: 1 };
  await old.put('profile', record);
  old.close();
  const store = await openLocalStore(name);
  try {
    expect((await store.snapshot()).profile).toEqual([record]);
    expect((await store.snapshot()).neverSend).toEqual([]);
    await store.putNeverSend(['  Acme  ', 'acme']);
    expect((await store.snapshot()).neverSend).toEqual(['Acme']);
    await store.clearAll({ getItem: () => null, removeItem: () => {} });
    expect((await store.snapshot()).neverSend).toEqual([]);
  } finally { store.close(); }
});
it('rolls back an aborted upgrade without an unhandled completion rejection', async () => {
  const name = `migration-abort-${crypto.randomUUID()}`;
  const old = await openDB(name, 1, { upgrade(db) {
    db.createObjectStore('paragraphs', { keyPath: 'id' });
    db.createObjectStore('paragraphVersions', { keyPath: ['id', 'version'] });
    db.createObjectStore('items', { keyPath: 'id' });
    db.createObjectStore('profile', { keyPath: 'id' });
    db.createObjectStore('jobs', { keyPath: 'key' });
    db.createObjectStore('outbox', { keyPath: 'id' });
    db.createObjectStore('meta', { keyPath: 'key' });
  } });
  const item = { id: 'i1', paragraphId: 'p1', paragraphVersion: 1, kind: 'assumption', text: 'test',
    quote: 'test', topics: ['other'], status: 'current', promptVersion: 'extract.v2', createdAt: 0 };
  await old.put('items', item);
  old.close();
  const unhandled: unknown[] = [];
  const listener = (error: unknown) => { unhandled.push(error); };
  process.on('unhandledRejection', listener);
  const spy = vi.spyOn(IDBCursor.prototype, 'update').mockImplementation(function (this: IDBCursor) {
    (this.source as IDBObjectStore).transaction.abort();
    throw new DOMException('Injected upgrade abort', 'AbortError');
  });
  try {
    await expect(openLocalStore(name)).rejects.toMatchObject({ name: 'AbortError' });
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    expect(unhandled).toEqual([]);
    spy.mockRestore();
    const reopened = await openDB(name, 1);
    try {
      expect(reopened.version).toBe(1);
      expect(await reopened.get('items', 'i1')).toEqual(item);
      expect(reopened.objectStoreNames.contains('lineageVersions')).toBe(false);
    } finally { reopened.close(); }
  } finally {
    spy.mockRestore();
    process.off('unhandledRejection', listener);
  }
});
