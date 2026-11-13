import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { matchParagraphs, type Paragraph } from './matcher';
import { safeErrorName } from '../ai/errorMetadata';
import { calculateStaleness } from './staleness';
import { containsQuote, type Comparison } from '../pipeline/compare';
import { assignmentsWithConflicts, comparisonBaseline, lineageHeads, type Decision, type PriorLineage }
  from './lineage';

export type ProfileType = 'skill' | 'project' | 'lesson' | 'preference';
export type Depth = 'new' | 'some' | 'deep';
export interface ProfileRecord {
  id: string; type: ProfileType; text: string; depth?: Depth; topics: string[]; tags: string[]; updatedAt: number;
}
export interface StoredItem {
  id: string; paragraphId: string; paragraphVersion: number; kind: string; text: string; quote: string;
  topics: string[]; status: 'current' | 'superseded'; promptVersion: string; createdAt: number;
  lineageId?: string; order?: number;
}
export interface LineageVersion {
  lineageId: string; version: number; itemId: string; paragraphId: string; paragraphVersion: number;
  status: 'current' | 'changed' | 'removed'; changedFrom?: string; needsConfirmation?: boolean;
  unchecked?: boolean; uncheckedReason?: string; newQuote?: string; conflictingEvidence?: boolean;
  createdAt?: number; order?: number;
}
export interface Dependency { consumerId: string; lineageId: string; version: number }
export interface StoredJob {
  key: string; paragraphId: string; paragraphVersion: number; step: 'extract' | 'compare';
  promptVersion: 'extract.v1' | 'extract.v2' | 'compare.v1'; lineageId?: string;
  status: 'pending' | 'running' | 'done' | 'superseded' | 'failed'; attempts: number; createdAt: number;
  nextRunAt: number; errorName?: string; failureReason?: 'interrupted-at-attempt-limit';
}
interface ComparisonBatch {
  key: string; paragraphId: string; paragraphVersion: number; old: PriorLineage[]; items: StoredItem[];
  decisions: Record<string, Decision>;
}
interface Database extends DBSchema {
  paragraphs: { key: string; value: Paragraph };
  paragraphVersions: { key: [string, number]; value: Paragraph };
  items: { key: string; value: StoredItem };
  profile: { key: string; value: ProfileRecord };
  jobs: { key: string; value: StoredJob };
  outbox: { key: string; value: { id: string } };
  meta: { key: string; value: { key: string; value: boolean } };
  lineageVersions: { key: [string, number]; value: LineageVersion };
  dependencies: { key: [string, string, number]; value: Dependency };
  comparisonBatches: { key: string; value: ComparisonBatch };
}
export const STORE_VERSION = 2;
export const LEGACY_KEY = 'thoughtpartner-notebook';
export const SETTLE_MS = 4000;
export const MIN_WORDS = 12;
export const MAX_ATTEMPTS = 3;
export const jobKey = (id: string, version: number) => `${id}@${version}#extract`;
export const compareJobKey = (id: string, version: number, lineage: string) => `${id}@${version}#compare#${lineage}`;
const batchKey = (id: string, version: number) => `${id}@${version}`;
export const wordCount = (text: string) => text.trim() ? text.trim().split(/\s+/).length : 0;
const id = () => crypto.randomUUID();
export type Snapshot = { paragraphs: Paragraph[]; items: StoredItem[]; profile: ProfileRecord[]; jobs: StoredJob[];
  lineages?: LineageVersion[] };
type LegacyStorage = Pick<Storage, 'getItem' | 'removeItem'>;

export class LocalStore {
  constructor(private readonly db: IDBPDatabase<Database>) {}
  close() { this.db.close(); }
  async snapshot(): Promise<Snapshot> {
    const tx = this.db.transaction(['paragraphs', 'items', 'profile', 'jobs', 'lineageVersions'], 'readonly');
    void tx.done.catch(() => undefined);
    try {
      const [paragraphs, items, profile, jobs, lineages] = await Promise.all([
        tx.objectStore('paragraphs').getAll(), tx.objectStore('items').getAll(),
        tx.objectStore('profile').getAll(), tx.objectStore('jobs').getAll(), tx.objectStore('lineageVersions').getAll(),
      ]);
      await tx.done;
      paragraphs.sort((a, b) => a.order - b.order);
      return { paragraphs, items, profile, jobs, lineages };
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }
  async versions(): Promise<Paragraph[]> { return this.db.getAll('paragraphVersions'); }
  async lineages(): Promise<LineageVersion[]> { return this.db.getAll('lineageVersions'); }
  async putDependency(dependency: Dependency): Promise<void> { await this.db.put('dependencies', dependency); }
  async staleness(consumerId: string) {
    const tx = this.db.transaction(['dependencies', 'lineageVersions'], 'readonly');
    void tx.done.catch(() => undefined);
    try {
      const [dependencies, versions] = await Promise.all([
        tx.objectStore('dependencies').getAll(), tx.objectStore('lineageVersions').getAll(),
      ]);
      await tx.done;
      return calculateStaleness(consumerId, dependencies, versions);
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }
  async migrate(storage: LegacyStorage): Promise<void> {
    const legacy = storage.getItem(LEGACY_KEY);
    const tx = this.db.transaction(['meta', 'paragraphs', 'paragraphVersions'], 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const marker = await tx.objectStore('meta').get('legacy-migrated');
      if (!marker) {
        const existing = await tx.objectStore('paragraphs').count();
        if (!existing && legacy) {
          for (const p of matchParagraphs([], legacy, Date.now(), id)) {
            await tx.objectStore('paragraphs').put(p);
            await tx.objectStore('paragraphVersions').put(p);
          }
        }
        await tx.objectStore('meta').put({ key: 'legacy-migrated', value: true });
      }
      await tx.done;
      if (legacy !== null) storage.removeItem(LEGACY_KEY);
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }
  async saveNotebook(text: string, now = Date.now()): Promise<Paragraph[]> {
    const tx = this.db.transaction(['paragraphs', 'paragraphVersions', 'items', 'jobs', 'lineageVersions'],
      'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const store = tx.objectStore('paragraphs');
      const before = await store.getAll();
      const after = matchParagraphs(before, text, now, id);
      const byId = new Map(after.map(p => [p.id, p]));
      const deleted = before.filter(p => !byId.has(p.id));
      for (const p of deleted) await store.delete(p.id);
      for (const lineage of lineageHeads(await tx.objectStore('lineageVersions').getAll())) {
        const deletedParagraph = deleted.find(p => p.id === lineage.paragraphId);
        if (deletedParagraph && lineage.status !== 'removed') {
          await tx.objectStore('lineageVersions').put({ ...lineage, version: lineage.version + 1,
            paragraphVersion: deletedParagraph.version + 1, status: 'removed', changedFrom: lineage.itemId,
            needsConfirmation: false, unchecked: false, uncheckedReason: undefined });
        }
      }
      for (const p of after) {
        await store.put(p);
        if (!before.some(old => old.id === p.id && old.version === p.version)) {
          await tx.objectStore('paragraphVersions').put(p);
        }
      }
      for (const job of await tx.objectStore('jobs').getAll()) {
        const current = byId.get(job.paragraphId);
        if ((!current || current.version !== job.paragraphVersion) &&
            (job.status === 'pending' || job.status === 'running')) {
          await tx.objectStore('jobs').put({ ...job, status: 'superseded' });
        }
      }
      for (const item of await tx.objectStore('items').getAll()) {
        if (!byId.has(item.paragraphId) && item.status === 'current') {
          await tx.objectStore('items').put({ ...item, status: 'superseded' });
        }
      }
      await tx.done;
      return after;
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }
  async enqueueSettled(now: number, promptVersion: 'extract.v1' | 'extract.v2'): Promise<void> {
    const tx = this.db.transaction(['paragraphs', 'jobs'], 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      for (const p of await tx.objectStore('paragraphs').getAll()) {
        if (now - p.updatedAt < SETTLE_MS || wordCount(p.text) < MIN_WORDS) continue;
        const key = jobKey(p.id, p.version);
        if (!(await tx.objectStore('jobs').get(key))) {
          await tx.objectStore('jobs').put({ key, paragraphId: p.id, paragraphVersion: p.version,
            step: 'extract', promptVersion, status: 'pending', attempts: 0, createdAt: now, nextRunAt: now });
        }
      }
      await tx.done;
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }
  async resume(): Promise<void> {
    const tx = this.db.transaction(['jobs', 'comparisonBatches'], 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      for (const job of await tx.objectStore('jobs').getAll()) {
        if (job.status === 'running') {
          const exhausted = job.attempts >= MAX_ATTEMPTS;
          await tx.objectStore('jobs').put(exhausted
            ? { ...job, status: 'failed', failureReason: 'interrupted-at-attempt-limit' }
            : { ...job, status: 'pending' });
          if (exhausted && job.step === 'compare' && job.lineageId) {
            const key = batchKey(job.paragraphId, job.paragraphVersion);
            const batch = await tx.objectStore('comparisonBatches').get(key);
            if (batch) {
              batch.decisions[job.lineageId] = { status: 'unchecked', reason: 'interrupted-at-attempt-limit' };
              await tx.objectStore('comparisonBatches').put(batch);
            }
          }
        }
      }
      await tx.done;
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }
  async claim(now: number): Promise<{ job: StoredJob; paragraph: Paragraph } | null> {
    const tx = this.db.transaction(['jobs', 'paragraphs', 'comparisonBatches'], 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const jobs = (await tx.objectStore('jobs').getAll()).filter(j => j.status === 'pending' && j.nextRunAt <= now)
        .sort((a, b) => a.createdAt - b.createdAt || a.key.localeCompare(b.key));
      for (const job of jobs) {
        if (job.attempts >= MAX_ATTEMPTS) {
          await tx.objectStore('jobs').put({ ...job, status: 'failed',
            failureReason: 'interrupted-at-attempt-limit' });
          if (job.step === 'compare' && job.lineageId) {
            const key = batchKey(job.paragraphId, job.paragraphVersion);
            const batch = await tx.objectStore('comparisonBatches').get(key);
            if (batch) {
              batch.decisions[job.lineageId] = { status: 'unchecked', reason: 'interrupted-at-attempt-limit' };
              await tx.objectStore('comparisonBatches').put(batch);
            }
          }
          continue;
        }
        const paragraph = await tx.objectStore('paragraphs').get(job.paragraphId);
        if (!paragraph || paragraph.version !== job.paragraphVersion) {
          await tx.objectStore('jobs').put({ ...job, status: 'superseded' });
          continue;
        }
        const claimed: StoredJob = { ...job, status: 'running', attempts: job.attempts + 1 };
        await tx.objectStore('jobs').put(claimed);
        await tx.done;
        return { job: claimed, paragraph };
      }
      await tx.done;
      return null;
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }
  async complete(job: StoredJob, result: { kind: string; text: string; quote: string; topics: string[] }[],
    now = Date.now()): Promise<boolean> {
    const tx = this.db.transaction(['jobs', 'paragraphs', 'items', 'lineageVersions', 'comparisonBatches'],
      'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const currentJob = await tx.objectStore('jobs').get(job.key);
      const paragraph = await tx.objectStore('paragraphs').get(job.paragraphId);
      if (!currentJob || currentJob.step !== 'extract' || currentJob.status !== 'running' || !paragraph ||
          paragraph.version !== job.paragraphVersion) {
        if (currentJob?.status === 'running') await tx.objectStore('jobs').put({ ...currentJob, status: 'superseded' });
        await tx.done;
        return false;
      }
      const allItems = await tx.objectStore('items').getAll();
      const previous = lineageHeads(await tx.objectStore('lineageVersions').getAll())
        .filter(lineage => lineage.paragraphId === paragraph.id && lineage.status !== 'removed')
        .map(lineage => ({ lineage, item: allItems.find(item => item.id === lineage.itemId) }))
        .filter((value): value is PriorLineage => value.item !== undefined)
        .sort((a, b) => (a.lineage.createdAt ?? a.item.createdAt) - (b.lineage.createdAt ?? b.item.createdAt) ||
          (a.lineage.order ?? 0) - (b.lineage.order ?? 0) || a.lineage.lineageId.localeCompare(b.lineage.lineageId));
      for (const item of allItems) {
        if (item.paragraphId === paragraph.id && item.status === 'current') {
          await tx.objectStore('items').put({ ...item, status: 'superseded' });
        }
      }
      // Extraction already applies the evaluated quote rule; store its accepted items unchanged.
      const items: StoredItem[] = result.map((item, order) => ({ ...item, id: id(), paragraphId: paragraph.id,
        paragraphVersion: paragraph.version, status: 'current', promptVersion: job.promptVersion, createdAt: now,
        order }));
      for (const item of items) await tx.objectStore('items').put(item);
      const decisions: Record<string, Decision> = {};
      for (const prior of previous) {
        const { lineage } = prior;
        if (containsQuote(paragraph.text, comparisonBaseline(prior).quote)) {
          decisions[lineage.lineageId] = { status: 'unchanged', newQuote: '', newQuoteFound: null,
            needsConfirmation: false };
        } else {
          const key = compareJobKey(paragraph.id, paragraph.version, lineage.lineageId);
          await tx.objectStore('jobs').put({ key, paragraphId: paragraph.id, paragraphVersion: paragraph.version,
            step: 'compare', lineageId: lineage.lineageId, promptVersion: 'compare.v1', status: 'pending',
            attempts: 0, createdAt: now, nextRunAt: now });
        }
      }
      await tx.objectStore('comparisonBatches').put({ key: batchKey(paragraph.id, paragraph.version),
        paragraphId: paragraph.id, paragraphVersion: paragraph.version, old: previous, items, decisions });
      await tx.objectStore('jobs').put({ ...currentJob, status: 'done' });
      await tx.done;
      return true;
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }
  async finalizeReady(): Promise<void> {
    for (const batch of await this.db.getAll('comparisonBatches')) await this.finalizeBatch(batch.key);
  }
  private async finalizeBatch(key: string): Promise<boolean> {
    const tx = this.db.transaction(['comparisonBatches', 'paragraphs', 'items', 'lineageVersions'], 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const batch = await tx.objectStore('comparisonBatches').get(key);
      if (!batch) { await tx.done; return false; }
      const paragraph = await tx.objectStore('paragraphs').get(batch.paragraphId);
      if (!paragraph || paragraph.version !== batch.paragraphVersion) {
        await tx.objectStore('comparisonBatches').delete(key);
        await tx.done; return false;
      }
      if (batch.old.some(entry => !batch.decisions[entry.lineage.lineageId])) { await tx.done; return false; }
      const { assignments, conflicts } = assignmentsWithConflicts(paragraph.text, batch.old, batch.items,
        batch.decisions);
      const used = new Set<string>();
      for (const { lineage, item } of batch.old) {
        const decision = batch.decisions[lineage.lineageId];
        const assigned = assignments.get(lineage.lineageId);
        if (decision.status === 'removed') {
          await tx.objectStore('lineageVersions').put({ ...lineage, version: lineage.version + 1,
            status: 'removed', paragraphVersion: paragraph.version, changedFrom: item.id,
            needsConfirmation: false, unchecked: false, uncheckedReason: undefined });
          continue;
        }
        let successor = assigned ? batch.items.find(candidate => candidate.id === assigned) : undefined;
        if (successor) used.add(successor.id);
        else successor = { ...item, id: id(), paragraphVersion: paragraph.version, status: 'current',
          createdAt: Date.now() };
        successor = { ...successor, lineageId: lineage.lineageId };
        await tx.objectStore('items').put(successor);
        const changed = decision.status === 'changed';
        await tx.objectStore('lineageVersions').put({ ...lineage, itemId: successor.id,
          version: lineage.version + (changed ? 1 : 0), paragraphVersion: paragraph.version,
          status: changed ? 'changed' : 'current', changedFrom: changed ? item.id : lineage.changedFrom,
          needsConfirmation: changed ? Boolean(decision.needsConfirmation || !assigned ||
            conflicts.has(lineage.lineageId) || !containsQuote(paragraph.text, decision.newQuote))
            : assigned ? false : lineage.needsConfirmation,
          newQuote: changed && !conflicts.has(lineage.lineageId)
            ? (containsQuote(paragraph.text, decision.newQuote) ? decision.newQuote : undefined) : lineage.newQuote,
          conflictingEvidence: changed ? conflicts.has(lineage.lineageId)
            : assigned ? false : lineage.conflictingEvidence,
          unchecked: decision.status === 'unchecked',
          uncheckedReason: decision.status === 'unchecked' ? decision.reason : undefined });
      }
      for (const item of batch.items) {
        if (used.has(item.id)) continue;
        const lineageId = id();
        await tx.objectStore('items').put({ ...item, lineageId });
        await tx.objectStore('lineageVersions').put({ lineageId, version: 1, itemId: item.id,
          paragraphId: paragraph.id, paragraphVersion: paragraph.version, status: 'current',
          createdAt: item.createdAt, order: item.order });
      }
      await tx.objectStore('comparisonBatches').delete(key);
      await tx.done;
      return true;
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }
  async comparisonInput(job: StoredJob): Promise<{ item: { text: string; quote: string } } | null> {
    if (job.step !== 'compare' || !job.lineageId) return null;
    const batch = await this.db.get('comparisonBatches', batchKey(job.paragraphId, job.paragraphVersion));
    const prior = batch?.old.find(entry => entry.lineage.lineageId === job.lineageId);
    if (!prior) return null;
    return { item: comparisonBaseline(prior) };
  }
  async completeComparison(job: StoredJob, result: Comparison): Promise<boolean> {
    const tx = this.db.transaction(['jobs', 'paragraphs', 'comparisonBatches'], 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const current = await tx.objectStore('jobs').get(job.key);
      const paragraph = await tx.objectStore('paragraphs').get(job.paragraphId);
      const batch = await tx.objectStore('comparisonBatches').get(batchKey(job.paragraphId, job.paragraphVersion));
      if (!current || current.status !== 'running' || current.step !== 'compare' || !current.lineageId ||
          !paragraph || paragraph.version !== job.paragraphVersion || !batch) {
        if (current?.status === 'running') await tx.objectStore('jobs').put({ ...current, status: 'superseded' });
        await tx.done;
        return false;
      }
      batch.decisions[current.lineageId] = { status: result.status, newQuote: result.newQuote,
        newQuoteFound: result.newQuoteFound, needsConfirmation: result.needsConfirmation };
      await tx.objectStore('comparisonBatches').put(batch);
      await tx.objectStore('jobs').put({ ...current, status: 'done' });
      await tx.done;
      return true;
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }
  async fail(job: StoredJob, errorName: string, cancelled: boolean, now = Date.now(), fatal = false,
    dispatched = false): Promise<void> {
    const tx = this.db.transaction(['jobs', 'paragraphs', 'comparisonBatches', 'lineageVersions'], 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const current = await tx.objectStore('jobs').get(job.key);
      const paragraph = await tx.objectStore('paragraphs').get(job.paragraphId);
      if (current?.status === 'running') {
        if (!paragraph || paragraph.version !== job.paragraphVersion) {
          await tx.objectStore('jobs').put({ ...current, status: 'superseded' });
        } else if (cancelled && !dispatched) {
          await tx.objectStore('jobs').put({ ...current, status: 'pending',
            attempts: Math.max(0, current.attempts - 1) });
        } else {
          const terminal = fatal || current.attempts >= MAX_ATTEMPTS;
          const safeName = safeErrorName({ name: errorName });
          await tx.objectStore('jobs').put({ ...current, errorName: safeName,
            status: terminal ? 'failed' : 'pending', nextRunAt: now + 5000 * 2 ** (current.attempts - 1) });
          if (current.step === 'compare' && current.lineageId) {
            const key = batchKey(job.paragraphId, job.paragraphVersion);
            const batch = await tx.objectStore('comparisonBatches').get(key);
            const prior = batch?.old.find(entry => entry.lineage.lineageId === current.lineageId);
            if (prior) {
              const latest = await tx.objectStore('lineageVersions').get([current.lineageId, prior.lineage.version]);
              if (latest) await tx.objectStore('lineageVersions').put({ ...latest, unchecked: true,
                uncheckedReason: safeName });
            }
            if (terminal && batch) {
              batch.decisions[current.lineageId] = { status: 'unchecked', reason: safeName };
              await tx.objectStore('comparisonBatches').put(batch);
            }
          }
        }
      }
      await tx.done;
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }
  async putProfile(record: ProfileRecord): Promise<void> { await this.db.put('profile', record); }
  async deleteProfile(key: string): Promise<void> { await this.db.delete('profile', key); }
  async replaceProfile(records: ProfileRecord[]): Promise<void> {
    const tx = this.db.transaction('profile', 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      await tx.store.clear();
      for (const record of records) await tx.store.put(record);
      await tx.done;
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }
  async clearAll(storage: LegacyStorage): Promise<void> {
    storage.removeItem(LEGACY_KEY);
    const tx = this.db.transaction(['paragraphs', 'paragraphVersions', 'items', 'profile', 'jobs', 'outbox', 'meta',
      'lineageVersions', 'dependencies', 'comparisonBatches'], 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      for (const name of tx.objectStoreNames) await tx.objectStore(name).clear();
      await tx.objectStore('meta').put({ key: 'legacy-migrated', value: true });
      await tx.done;
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }
}
export async function openLocalStore(name = 'thoughtpartner'): Promise<LocalStore> {
  const db = await openDB<Database>(name, STORE_VERSION, {
    upgrade(database, oldVersion, _newVersion, tx) {
      void tx.done.catch(() => undefined);
      if (oldVersion < 1) {
        database.createObjectStore('paragraphs', { keyPath: 'id' });
        database.createObjectStore('paragraphVersions', { keyPath: ['id', 'version'] });
        database.createObjectStore('items', { keyPath: 'id' });
        database.createObjectStore('profile', { keyPath: 'id' });
        database.createObjectStore('jobs', { keyPath: 'key' });
        database.createObjectStore('outbox', { keyPath: 'id' });
        database.createObjectStore('meta', { keyPath: 'key' });
      }
      if (oldVersion < 2) {
        database.createObjectStore('lineageVersions', { keyPath: ['lineageId', 'version'] });
        database.createObjectStore('dependencies', { keyPath: ['consumerId', 'lineageId', 'version'] });
        database.createObjectStore('comparisonBatches', { keyPath: 'key' });
        if (oldVersion === 1) {
          void (async () => {
            let cursor = await tx.objectStore('items').openCursor();
            while (cursor) {
              const item = cursor.value;
              if (item.status === 'current') {
                const lineageId = id();
                await cursor.update({ ...item, lineageId });
                await tx.objectStore('lineageVersions').put({ lineageId, version: 1, itemId: item.id,
                  paragraphId: item.paragraphId, paragraphVersion: item.paragraphVersion, status: 'current',
                  createdAt: item.createdAt, order: item.order });
              }
              cursor = await cursor.continue();
            }
          })().catch(() => { try { tx.abort(); } catch { /* Upgrade has already aborted. */ } });
        }
      }
    },
  });
  return new LocalStore(db);
}
