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
it('backfills only provable v3 card and completed-current-angles evidence', async () => {
  const name = `migration-v3-considered-${crypto.randomUUID()}`;
  const old = await openDB(name, 3, { upgrade(db) {
    for (const [store, keyPath] of [
      ['paragraphs', 'id'], ['paragraphVersions', ['id', 'version']], ['items', 'id'], ['profile', 'id'],
      ['jobs', 'key'], ['outbox', 'id'], ['meta', 'key'], ['lineageVersions', ['lineageId', 'version']],
      ['dependencies', ['consumerId', 'lineageId', 'version']], ['comparisonBatches', 'key'],
      ['privacy', 'key'], ['cards', 'id'], ['funnel', 'id'],
    ] as Array<[string, string | string[]]>) db.createObjectStore(store, { keyPath });
  } });
  for (const [id, status] of [['a', 'done'], ['b', 'failed']] as const) {
    const text = `The ${id} hosting statement has enough exact words for its synthetic quote.`;
    await old.put('paragraphs', { id, projectId: 'default', order: 0, text, version: 1, updatedAt: 0 });
    await old.put('items', { id: `i-${id}`, paragraphId: id, paragraphVersion: 1, kind: 'assumption', text,
      quote: text, topics: ['hosting'], status: 'current', promptVersion: 'extract.v2', createdAt: 0,
      lineageId: `l-${id}` });
    await old.put('lineageVersions', { lineageId: `l-${id}`, version: 1, itemId: `i-${id}`, paragraphId: id,
      paragraphVersion: 1, status: 'current' });
    await old.put('jobs', { key: `${id}@1#angles`, paragraphId: id, paragraphVersion: 1, step: 'angles',
      promptVersion: 'angles.v1', status, attempts: 1, createdAt: 0, nextRunAt: 0 });
  }
  await old.put('cards', { id: 'c', itemLineageId: 'old-card-lineage', itemVersion: 2, createdAt: 5 });
  old.close();
  const store = await openLocalStore(name);
  try {
    const db = await openDB(name, 4);
    try {
      expect(await db.getAllKeys('anglesConsidered')).toEqual([['l-a', 1], ['old-card-lineage', 2]]);
      expect(await db.get('anglesConsidered', ['l-b', 1])).toBeUndefined();
      expect(await db.get('cards', 'c')).toMatchObject({ itemLineageId: 'old-card-lineage' });
    } finally { db.close(); }
  } finally { store.close(); }
});
it('rolls back a failed v3 considered-pair backfill without losing existing cards', async () => {
  const name = `migration-v3-abort-${crypto.randomUUID()}`;
  const old = await openDB(name, 3, { upgrade(db) {
    for (const [store, keyPath] of [
      ['paragraphs', 'id'], ['paragraphVersions', ['id', 'version']], ['items', 'id'], ['profile', 'id'],
      ['jobs', 'key'], ['outbox', 'id'], ['meta', 'key'], ['lineageVersions', ['lineageId', 'version']],
      ['dependencies', ['consumerId', 'lineageId', 'version']], ['comparisonBatches', 'key'],
      ['privacy', 'key'], ['cards', 'id'], ['funnel', 'id'],
    ] as Array<[string, string | string[]]>) db.createObjectStore(store, { keyPath });
  } });
  const card = { id: 'c', itemLineageId: 'old-lineage', itemVersion: 1, createdAt: 5 };
  await old.put('cards', card);
  old.close();
  const originalPut = IDBObjectStore.prototype.put;
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
    if (this.name === 'anglesConsidered') {
      this.transaction.abort();
      throw new DOMException('Synthetic backfill abort', 'AbortError');
    }
    return key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
  });
  try {
    await expect(openLocalStore(name)).rejects.toMatchObject({ name: 'AbortError' });
    spy.mockRestore();
    const reopened = await openDB(name, 3);
    try {
      expect(reopened.objectStoreNames.contains('anglesConsidered')).toBe(false);
      expect(await reopened.get('cards', 'c')).toEqual(card);
    } finally { reopened.close(); }
  } finally { spy.mockRestore(); }
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
      expect(reopened.objectStoreNames.contains('anglesConsidered')).toBe(false);
    } finally { reopened.close(); }
  } finally {
    spy.mockRestore();
    process.off('unhandledRejection', listener);
  }
});
