import type { IDBPDatabase } from 'idb';
import { filterQuestion } from '../pipeline/leakFilter';
import { lineageHeads } from './lineage';
import type { LocalStore } from './index';
import type { OutboxEntry } from './triageTypes';

// Test-only helper: emulate entries that existed before T08, never imported by application code.
export async function seedLegacyPending(store: LocalStore, entry: Omit<OutboxEntry, 'status'>,
  privateTokens: string[] = []): Promise<boolean> {
  const snapshot = await store.snapshot();
  const head = lineageHeads(snapshot.lineages ?? []).find(value => value.lineageId === entry.itemLineageId);
  const terms = snapshot.neverSend ?? [];
  if (!head || head.version !== entry.itemVersion || head.status === 'removed' || head.needsConfirmation ||
      head.unchecked || !filterQuestion(entry.question, terms, privateTokens).passed) return false;
  const keptOut = entry.keptOut.filter(value => filterQuestion(value, terms, privateTokens).passed);
  const db = (store as unknown as { db: IDBPDatabase }).db;
  await db.put('outbox', { ...entry, keptOut, status: 'pending' });
  return true;
}
