import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { matchParagraphs, type Paragraph } from './matcher';
import { safeErrorName } from '../ai/errorMetadata';

export type ProfileType = 'skill' | 'project' | 'lesson' | 'preference';
export type Depth = 'new' | 'some' | 'deep';
export interface ProfileRecord {
  id: string; type: ProfileType; text: string; depth?: Depth; topics: string[]; tags: string[]; updatedAt: number;
}
export interface StoredItem {
  id: string; paragraphId: string; paragraphVersion: number; kind: string; text: string; quote: string;
  topics: string[]; status: 'current' | 'superseded'; promptVersion: string; createdAt: number;
}
export interface StoredJob {
  key: string; paragraphId: string; paragraphVersion: number; step: 'extract';
  promptVersion: 'extract.v1' | 'extract.v2';
  status: 'pending' | 'running' | 'done' | 'superseded' | 'failed'; attempts: number; createdAt: number;
  nextRunAt: number; errorName?: string; failureReason?: 'interrupted-at-attempt-limit';
}
interface Database extends DBSchema {
  paragraphs: { key: string; value: Paragraph };
  paragraphVersions: { key: [string, number]; value: Paragraph };
  items: { key: string; value: StoredItem };
  profile: { key: string; value: ProfileRecord };
  jobs: { key: string; value: StoredJob };
  outbox: { key: string; value: { id: string } };
  meta: { key: string; value: { key: string; value: boolean } };
}
export const STORE_VERSION = 1;
export const LEGACY_KEY = 'thoughtpartner-notebook';
export const SETTLE_MS = 4000;
export const MIN_WORDS = 12;
export const MAX_ATTEMPTS = 3;
export const jobKey = (id: string, version: number) => `${id}@${version}#extract`;
export const wordCount = (text: string) => text.trim() ? text.trim().split(/\s+/).length : 0;
const id = () => crypto.randomUUID();
export type Snapshot = { paragraphs: Paragraph[]; items: StoredItem[]; profile: ProfileRecord[]; jobs: StoredJob[] };
type LegacyStorage = Pick<Storage, 'getItem' | 'removeItem'>;

export class LocalStore {
  constructor(private readonly db: IDBPDatabase<Database>) {}
  close() { this.db.close(); }
  async snapshot(): Promise<Snapshot> {
    const tx = this.db.transaction(['paragraphs', 'items', 'profile', 'jobs'], 'readonly');
    void tx.done.catch(() => undefined);
    try {
      const [paragraphs, items, profile, jobs] = await Promise.all([
        tx.objectStore('paragraphs').getAll(), tx.objectStore('items').getAll(),
        tx.objectStore('profile').getAll(), tx.objectStore('jobs').getAll(),
      ]);
      await tx.done;
      paragraphs.sort((a, b) => a.order - b.order);
      return { paragraphs, items, profile, jobs };
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }
  async versions(): Promise<Paragraph[]> { return this.db.getAll('paragraphVersions'); }
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
    const tx = this.db.transaction(['paragraphs', 'paragraphVersions', 'items', 'jobs'], 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const store = tx.objectStore('paragraphs');
      const before = await store.getAll();
      const after = matchParagraphs(before, text, now, id);
      const byId = new Map(after.map(p => [p.id, p]));
      for (const p of before) if (!byId.has(p.id)) await store.delete(p.id);
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
  async enqueueSettled(now: number, promptVersion: StoredJob['promptVersion']): Promise<void> {
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
    const tx = this.db.transaction('jobs', 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      for (const job of await tx.store.getAll()) {
        if (job.status === 'running') {
          await tx.store.put(job.attempts >= MAX_ATTEMPTS
            ? { ...job, status: 'failed', failureReason: 'interrupted-at-attempt-limit' }
            : { ...job, status: 'pending' });
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
    const tx = this.db.transaction(['jobs', 'paragraphs'], 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const jobs = (await tx.objectStore('jobs').getAll()).filter(j => j.status === 'pending' && j.nextRunAt <= now)
        .sort((a, b) => a.createdAt - b.createdAt || a.key.localeCompare(b.key));
      for (const job of jobs) {
        if (job.attempts >= MAX_ATTEMPTS) {
          await tx.objectStore('jobs').put({ ...job, status: 'failed',
            failureReason: 'interrupted-at-attempt-limit' });
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
    const tx = this.db.transaction(['jobs', 'paragraphs', 'items'], 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const currentJob = await tx.objectStore('jobs').get(job.key);
      const paragraph = await tx.objectStore('paragraphs').get(job.paragraphId);
      if (!currentJob || currentJob.status !== 'running' || !paragraph || paragraph.version !== job.paragraphVersion) {
        if (currentJob?.status === 'running') await tx.objectStore('jobs').put({ ...currentJob, status: 'superseded' });
        await tx.done;
        return false;
      }
      for (const item of await tx.objectStore('items').getAll()) {
        if (item.paragraphId === paragraph.id && item.status === 'current') {
          await tx.objectStore('items').put({ ...item, status: 'superseded' });
        }
      }
      // The extraction pipeline already checks quotes with its evaluated normalization rule.
      for (const item of result) {
        await tx.objectStore('items').put({ ...item, id: id(), paragraphId: paragraph.id,
          paragraphVersion: paragraph.version, status: 'current', promptVersion: job.promptVersion, createdAt: now });
      }
      await tx.objectStore('jobs').put({ ...currentJob, status: 'done' });
      await tx.done;
      return true;
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }
  async fail(job: StoredJob, errorName: string, cancelled: boolean, now = Date.now(), fatal = false): Promise<void> {
    const tx = this.db.transaction(['jobs', 'paragraphs'], 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const current = await tx.objectStore('jobs').get(job.key);
      const paragraph = await tx.objectStore('paragraphs').get(job.paragraphId);
      if (current?.status === 'running') {
        if (!paragraph || paragraph.version !== job.paragraphVersion) {
          await tx.objectStore('jobs').put({ ...current, status: 'superseded' });
        } else if (cancelled) {
          await tx.objectStore('jobs').put({ ...current, status: 'pending',
            attempts: Math.max(0, current.attempts - 1) });
        } else {
          await tx.objectStore('jobs').put({ ...current, errorName: safeErrorName({ name: errorName }),
            status: fatal || current.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
            nextRunAt: now + 5000 * 2 ** (current.attempts - 1) });
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
    const tx = this.db.transaction(['paragraphs', 'paragraphVersions', 'items', 'profile', 'jobs', 'outbox', 'meta'],
      'readwrite');
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
    upgrade(database, oldVersion) {
      if (oldVersion < 1) {
        database.createObjectStore('paragraphs', { keyPath: 'id' });
        database.createObjectStore('paragraphVersions', { keyPath: ['id', 'version'] });
        database.createObjectStore('items', { keyPath: 'id' });
        database.createObjectStore('profile', { keyPath: 'id' });
        database.createObjectStore('jobs', { keyPath: 'key' });
        database.createObjectStore('outbox', { keyPath: 'id' });
        database.createObjectStore('meta', { keyPath: 'key' });
      }
    },
  });
  return new LocalStore(db);
}
