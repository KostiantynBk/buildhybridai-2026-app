import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { expect, it } from 'vitest';
import { openLocalStore } from './index';

it('upgrades v6 to v7 without losing existing cards, Outbox and research receipts', async () => {
  const name = `idea-v6-${crypto.randomUUID()}`;
  const old = await openDB(name, 6, { upgrade(db) {
    for (const [store, keyPath] of [
      ['paragraphs', 'id'], ['paragraphVersions', ['id', 'version']], ['items', 'id'], ['profile', 'id'],
      ['jobs', 'key'], ['outbox', 'id'], ['meta', 'key'], ['lineageVersions', ['lineageId', 'version']],
      ['dependencies', ['consumerId', 'lineageId', 'version']], ['comparisonBatches', 'key'],
      ['privacy', 'key'], ['cards', 'id'], ['funnel', 'id'], ['anglesConsidered', ['lineageId', 'version']],
    ] as Array<[string, string | string[]]>) db.createObjectStore(store, { keyPath });
    db.createObjectStore('research', { autoIncrement: true });
    db.createObjectStore('cloudProcessing', { autoIncrement: true });
  } });
  const card = { id: 'card', itemLineageId: 'lineage', itemVersion: 1, createdAt: 1 };
  const entry = { id: 'entry', cardId: 'card', status: 'approved', question: 'Question?', keptOut: [] };
  const receipt = { entryId: 'entry', sentAt: 10, status: 'completed' };
  await old.put('cards', card); await old.put('outbox', entry); await old.add('research', receipt); old.close();
  const store = await openLocalStore(name);
  try {
    const snapshot = await store.snapshot();
    expect(snapshot.cards).toEqual([card]);
    expect(snapshot.outbox).toEqual([entry]);
    expect(snapshot.researchReceipts).toEqual([receipt]);
    expect(snapshot.ideas).toEqual([]);
  } finally { store.close(); }
});
