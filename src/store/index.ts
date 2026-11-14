import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { matchParagraphs, type Paragraph } from './matcher';
import { safeErrorName } from '../ai/errorMetadata';
import { calculateStaleness } from './staleness';
import { lineageEligibility } from './eligibility';
import { fingerprintRecords, recordSemantics, type RecordFingerprint } from './fingerprint';
import { validateNeverSend } from '../privacy/terms';
import { filterQuestion } from '../pipeline/leakFilter';
import { eligibleItems, type TriageItem } from '../pipeline/triage';
import { selectConcerns, type Concern, type DisplayAngle, type Pair } from '../pipeline/selectConcerns';
import { containsQuote, type Comparison } from '../pipeline/compare';
import { assignmentsWithConflicts, comparisonBaseline, lineageHeads, type Decision, type PriorLineage }
  from './lineage';
import type { Feedback, FunnelEvent, OutboxEntry, ThoughtCard } from './triageTypes';

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
  key: string; paragraphId: string; paragraphVersion: number;
  step: 'extract' | 'compare' | 'angles' | 'question' | 'whynote';
  promptVersion: 'extract.v1' | 'extract.v2' | 'compare.v1' | 'angles.v1' | 'question.v1' | 'whynote.v1';
  lineageId?: string; cardId?: string;
  status: 'pending' | 'running' | 'done' | 'superseded' | 'failed'; attempts: number; createdAt: number;
  nextRunAt: number; errorName?: string;
  failureReason?: 'interrupted-at-attempt-limit' | 'revalidation-failed';
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
  outbox: { key: string; value: OutboxEntry };
  cards: { key: string; value: ThoughtCard };
  funnel: { key: string; value: FunnelEvent };
  meta: { key: string; value: { key: string; value: boolean } };
  lineageVersions: { key: [string, number]; value: LineageVersion };
  dependencies: { key: [string, string, number]; value: Dependency };
  comparisonBatches: { key: string; value: ComparisonBatch };
  privacy: { key: string; value: { key: string; terms: string[] } };
  anglesConsidered: { key: [string, number]; value: { lineageId: string; version: number; recordedAt: number;
    source: 'adopted' | 'migrated-card' | 'migrated-current' } };
}
export const STORE_VERSION = 4;
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
  lineages?: LineageVersion[]; neverSend?: string[]; cards?: ThoughtCard[]; outbox?: OutboxEntry[];
  dependencies?: Dependency[] };
type LegacyStorage = Pick<Storage, 'getItem' | 'removeItem'>;
function currentTriageItems(paragraph: Paragraph, items: StoredItem[], versions: LineageVersion[]): TriageItem[] {
  const heads = lineageHeads(versions);
  const list = items.filter(item => item.paragraphId === paragraph.id && item.paragraphVersion === paragraph.version &&
    item.status === 'current' && item.lineageId).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) ||
      a.id.localeCompare(b.id)).flatMap(item => {
    const head = heads.find(value => value.lineageId === item.lineageId);
    if (!head || head.itemId !== item.id || head.status === 'removed' || head.unchecked || head.needsConfirmation) {
      return [];
    }
    return [{ lineageId: head.lineageId, version: head.version, kind: item.kind, quote: item.quote,
      text: item.text, topics: item.topics }];
  });
  return eligibleItems(paragraph.text, list);
}
function unconsideredItems(items: TriageItem[], considered: Array<{ lineageId: string; version: number }>) {
  const keys = new Set(considered.map(value => JSON.stringify([value.lineageId, value.version])));
  return items.filter(item => !keys.has(JSON.stringify([item.lineageId, item.version])));
}
function triageFailure(job: StoredJob, card: ThoughtCard | undefined, now: number):
  { card?: ThoughtCard; event: FunnelEvent } {
  const updated = card && job.step === 'question' ? { ...card, questionStatus: 'blocked' as const,
    questionReason: 'local-step-failed' as const }
    : card && job.step === 'whynote' ? { ...card, why: null } : card;
  return { card: updated, event: { id: id(), paragraphId: job.paragraphId, paragraphVersion: job.paragraphVersion,
    event: 'held', at: now, reason: 'local-step-failed', ...(job.cardId ? { cardId: job.cardId } : {}) } };
}
async function invalidateProfileNotes(cards: ThoughtCard[], jobs: StoredJob[], paragraphs: Paragraph[],
  changedIds: Set<string>, putCard: (card: ThoughtCard) => Promise<unknown>,
  putJob: (job: StoredJob) => Promise<unknown>): Promise<void> {
  for (const card of cards) {
    if (!card.why || !card.whyFingerprints?.some(value => changedIds.has(value.id))) continue;
    const pending = jobs.some(job => job.cardId === card.id && job.step === 'whynote' &&
      (job.status === 'pending' || job.status === 'running'));
    const paragraph = paragraphs.find(value => value.id === card.paragraphId);
    const refreshCount = card.whyRefreshCount ?? 0;
    await putCard({ ...card, why: null, whyFingerprints: undefined,
      whyRefreshCount: Math.min(1, refreshCount + 1) });
    if (!pending && !refreshCount && paragraph) {
      const now = Date.now();
      await putJob({ key: `${card.id}#profile-refresh#${crypto.randomUUID()}`, paragraphId: paragraph.id,
        paragraphVersion: paragraph.version, step: 'whynote', promptVersion: 'whynote.v1', cardId: card.id,
        status: 'pending', attempts: 0, createdAt: now, nextRunAt: now });
    }
  }
}
function outboxEvent(card: ThoughtCard, reason: string, now: number): FunnelEvent {
  return { id: id(), paragraphId: card.paragraphId, paragraphVersion: card.paragraphVersion,
    event: 'outbox', at: now, reason, cardId: card.id };
}
async function resolveTerminalDependents(paragraphs: Paragraph[], versions: LineageVersion[], jobs: StoredJob[],
  cards: ThoughtCard[], entries: OutboxEntry[], now: number, putCard: (card: ThoughtCard) => Promise<unknown>,
  putJob: (job: StoredJob) => Promise<unknown>, putEntry: (entry: OutboxEntry) => Promise<unknown>,
  putEvent: (event: FunnelEvent) => Promise<unknown>): Promise<void> {
  for (const card of cards) {
    const paragraph = paragraphs.find(value => value.id === card.paragraphId);
    if (!paragraph || lineageEligibility(card.itemLineageId, card.itemVersion, paragraphs, versions, jobs) !==
        'terminal') continue;
    await putCard({ ...card, recheckFailedVersion: paragraph.version,
      ...(card.questionStatus === 'waiting' ? { questionStatus: 'blocked',
        questionReason: 'revalidation-failed' } : {}) });
    for (const job of jobs) {
      if (job.cardId === card.id && (job.step === 'question' || job.step === 'whynote') &&
          (job.status === 'pending' || job.status === 'running')) {
        await putJob({ ...job, status: 'failed', failureReason: 'revalidation-failed' });
      }
    }
  }
  for (const entry of entries) {
    if ((entry.status !== 'pending' && entry.status !== 'approved') ||
        lineageEligibility(entry.itemLineageId, entry.itemVersion, paragraphs, versions, jobs) !== 'terminal') continue;
    await putEntry({ ...entry, status: 'withdrawn', withdrawReason: 'stale', decidedAt: now });
    const card = cards.find(value => value.id === entry.cardId);
    if (card) await putEvent(outboxEvent(card, 'withdrawn:stale', now));
  }
}
function withdrawForTerms(entries: OutboxEntry[], terms: string[], now: number): OutboxEntry[] {
  return entries.filter(entry => (entry.status === 'pending' || entry.status === 'approved') &&
    [entry.question, ...entry.keptOut].some(text => filterQuestion(text, terms).reasons.includes('listed-term')))
    .map(entry => ({ ...entry, status: 'withdrawn', withdrawReason: 'listed-term', decidedAt: now }));
}

export class LocalStore {
  constructor(private readonly db: IDBPDatabase<Database>) {}
  close() { this.db.close(); }
  async snapshot(): Promise<Snapshot> {
    const tx = this.db.transaction(['paragraphs', 'items', 'profile', 'jobs', 'lineageVersions', 'privacy',
      'cards', 'outbox', 'dependencies'], 'readonly');
    void tx.done.catch(() => undefined);
    try {
      const [paragraphs, items, profile, jobs, lineages, privacy, cards, outbox, dependencies] = await Promise.all([
        tx.objectStore('paragraphs').getAll(), tx.objectStore('items').getAll(),
        tx.objectStore('profile').getAll(), tx.objectStore('jobs').getAll(), tx.objectStore('lineageVersions').getAll(),
        tx.objectStore('privacy').get('never-send'), tx.objectStore('cards').getAll(),
        tx.objectStore('outbox').getAll(), tx.objectStore('dependencies').getAll(),
      ]);
      await tx.done;
      paragraphs.sort((a, b) => a.order - b.order);
      return { paragraphs, items, profile, jobs, lineages, neverSend: privacy?.terms ?? [], cards, outbox,
        dependencies };
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }
  async enqueueAngles(now: number): Promise<void> {
    const tx = this.db.transaction(['paragraphs', 'items', 'jobs', 'lineageVersions', 'comparisonBatches',
      'anglesConsidered'], 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const [paragraphs, items, versions, jobs, considered] = await Promise.all([
        tx.objectStore('paragraphs').getAll(), tx.objectStore('items').getAll(),
        tx.objectStore('lineageVersions').getAll(), tx.objectStore('jobs').getAll(),
        tx.objectStore('anglesConsidered').getAll()]);
      for (const paragraph of paragraphs) {
        const key = `${paragraph.id}@${paragraph.version}#angles`;
        const extract = jobs.find(job => job.key === jobKey(paragraph.id, paragraph.version));
        if (extract?.status !== 'done' || jobs.some(job => job.key === key) ||
            await tx.objectStore('comparisonBatches').get(batchKey(paragraph.id, paragraph.version)) ||
            !unconsideredItems(currentTriageItems(paragraph, items, versions), considered).length) continue;
        await tx.objectStore('jobs').put({ key, paragraphId: paragraph.id, paragraphVersion: paragraph.version,
          step: 'angles', promptVersion: 'angles.v1', status: 'pending', attempts: 0, createdAt: now, nextRunAt: now });
      }
      await tx.done;
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }
  async anglesInput(job: StoredJob): Promise<{ paragraph: string; items: TriageItem[] } | null> {
    const tx = this.db.transaction(['paragraphs', 'items', 'lineageVersions', 'comparisonBatches', 'anglesConsidered'],
      'readonly');
    void tx.done.catch(() => undefined);
    try {
      const [paragraph, items, versions, batch, considered] = await Promise.all([
        tx.objectStore('paragraphs').get(job.paragraphId), tx.objectStore('items').getAll(),
        tx.objectStore('lineageVersions').getAll(),
        tx.objectStore('comparisonBatches').get(batchKey(job.paragraphId, job.paragraphVersion)),
        tx.objectStore('anglesConsidered').getAll(),
      ]);
      await tx.done;
      if (!paragraph || paragraph.version !== job.paragraphVersion || batch) return null;
      const eligible = unconsideredItems(currentTriageItems(paragraph, items, versions), considered);
      return eligible.length ? { paragraph: paragraph.text, items: eligible } : null;
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }
  async completeAngles(job: StoredJob, input: { paragraph: string; items: TriageItem[] }, concerns: Concern[],
    sessionId: string, now = Date.now()): Promise<boolean> {
    const tx = this.db.transaction(['jobs', 'paragraphs', 'items', 'lineageVersions', 'comparisonBatches', 'profile',
      'cards', 'dependencies', 'funnel', 'anglesConsidered'], 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const [current, paragraph, items, versions, batch, profile, cards, considered] = await Promise.all([
        tx.objectStore('jobs').get(job.key), tx.objectStore('paragraphs').get(job.paragraphId),
        tx.objectStore('items').getAll(), tx.objectStore('lineageVersions').getAll(),
        tx.objectStore('comparisonBatches').get(batchKey(job.paragraphId, job.paragraphVersion)),
        tx.objectStore('profile').getAll(), tx.objectStore('cards').getAll(),
        tx.objectStore('anglesConsidered').getAll(),
      ]);
      if (!current || current.step !== 'angles' || current.status !== 'running' || !paragraph || batch ||
          paragraph.version !== job.paragraphVersion || paragraph.text !== input.paragraph ||
          JSON.stringify(unconsideredItems(currentTriageItems(paragraph, items, versions), considered)) !==
            JSON.stringify(input.items)) {
        if (current?.status === 'running') await tx.objectStore('jobs').put({ ...current, status: 'superseded' });
        await tx.done; return false;
      }
      for (const item of input.items) await tx.objectStore('anglesConsidered').put({ lineageId: item.lineageId,
        version: item.version, recordedAt: now, source: 'adopted' });
      const used: Pair[] = cards.map(card => ({ lineageId: card.itemLineageId, version: card.itemVersion,
        angle: card.angle, sourceAngle: card.sourceAngle }));
      const angleCounts: Partial<Record<DisplayAngle, number>> = {};
      for (const card of cards.filter(value => value.sessionId === sessionId)) {
        angleCounts[card.angle] = (angleCounts[card.angle] ?? 0) + 1;
      }
      const heads = lineageHeads(versions);
      const priorLiveCards = cards.filter(card => {
        if (card.paragraphId !== paragraph.id || card.paragraphVersion >= paragraph.version ||
            card.questionStatus === 'waiting' || card.recheckFailedVersion !== undefined) return false;
        const head = heads.find(value => value.lineageId === card.itemLineageId);
        return head && head.version === card.itemVersion && head.paragraphVersion === paragraph.version &&
          head.status !== 'removed' && !head.unchecked && !head.needsConfirmation;
      }).map(card => ({ quote: card.itemQuote, angle: card.angle, sourceAngle: card.sourceAngle }));
      const selection = selectConcerns({ paragraph: input.paragraph, items: input.items, concerns, profile, used,
        priorLiveCards, angleCounts, alreadyShown: cards.filter(card => card.paragraphId === paragraph.id &&
          card.paragraphVersion === paragraph.version).length });
      for (const [modelOrder, concern] of concerns.entries()) {
        await tx.objectStore('funnel').put({ id: id(), paragraphId: paragraph.id, paragraphVersion: paragraph.version,
          event: 'considered', at: now, concern: concern.concern, sourceAngle: concern.angle, modelOrder,
          itemIndex: concern.item, checkable: concern.checkable });
      }
      for (const held of selection.held) {
        await tx.objectStore('funnel').put({ id: id(), paragraphId: paragraph.id, paragraphVersion: paragraph.version,
          event: 'held', at: now, reason: held.reason, concern: held.concern.concern, sourceAngle: held.concern.angle,
          modelOrder: held.modelOrder, itemIndex: held.concern.item });
      }
      for (const pick of selection.picked) {
        const source = input.items.find(value => value.lineageId === pick.item.lineageId &&
          value.version === pick.item.version);
        if (!source) throw new Error('Selected item unavailable.');
        const card: ThoughtCard = { id: id(), paragraphId: paragraph.id, paragraphVersion: paragraph.version,
          itemLineageId: source.lineageId, itemVersion: source.version, itemText: source.text, itemQuote: source.quote,
          topics: source.topics, angle: pick.angle, sourceAngle: pick.concern.angle, concern: pick.concern.concern,
          score: pick.score, lessonId: pick.lessonId, brief: pick.brief, sessionId, questionStatus: 'waiting',
          createdAt: now };
        await tx.objectStore('cards').put(card);
        await tx.objectStore('dependencies').put({ consumerId: card.id, lineageId: card.itemLineageId,
          version: card.itemVersion });
        await tx.objectStore('funnel').put({ id: id(), paragraphId: paragraph.id, paragraphVersion: paragraph.version,
          event: 'picked', at: now, angle: card.angle, sourceAngle: card.sourceAngle, score: card.score,
          modelOrder: pick.modelOrder, itemIndex: pick.concern.item, concern: pick.concern.concern,
          ...(card.lessonId ? { lessonId: card.lessonId } : {}), cardId: card.id, itemLineageId: card.itemLineageId,
          itemVersion: card.itemVersion });
        await tx.objectStore('jobs').put({ key: `${job.key}#question#${card.id}`,
          paragraphId: paragraph.id, paragraphVersion: paragraph.version, step: 'question',
          promptVersion: 'question.v1',
          cardId: card.id, status: 'pending', attempts: 0, createdAt: now, nextRunAt: now });
      }
      await tx.objectStore('jobs').put({ ...current, status: 'done' });
      await tx.done; return true;
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }
  async questionInput(job: StoredJob): Promise<{ card: ThoughtCard; neverSend: string[] } | null> {
    if (!job.cardId) return null;
    const tx = this.db.transaction(['cards', 'privacy', 'paragraphs', 'lineageVersions'], 'readonly');
    void tx.done.catch(() => undefined);
    try {
      const [card, privacy, paragraph, versions] = await Promise.all([tx.objectStore('cards').get(job.cardId),
        tx.objectStore('privacy').get('never-send'), tx.objectStore('paragraphs').get(job.paragraphId),
        tx.objectStore('lineageVersions').getAll()]);
      await tx.done;
      const head = card && lineageHeads(versions).find(value => value.lineageId === card.itemLineageId);
      if (!card || !paragraph || paragraph.version !== job.paragraphVersion || !head ||
          head.version !== card.itemVersion || head.status === 'removed' || head.needsConfirmation || head.unchecked) {
        return null;
      }
      return { card, neverSend: privacy?.terms ?? [] };
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }
  async completeQuestion(job: StoredJob, question: string, keptOut: string[], passedAtGeneration: boolean,
    now = Date.now()): Promise<boolean> {
    const tx = this.db.transaction(['jobs', 'paragraphs', 'cards', 'lineageVersions', 'privacy', 'outbox', 'funnel'],
      'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const [current, paragraph, card, versions, privacy] = await Promise.all([
        tx.objectStore('jobs').get(job.key), tx.objectStore('paragraphs').get(job.paragraphId),
        job.cardId ? tx.objectStore('cards').get(job.cardId) : Promise.resolve(undefined),
        tx.objectStore('lineageVersions').getAll(), tx.objectStore('privacy').get('never-send'),
      ]);
      const head = card && lineageHeads(versions).find(value => value.lineageId === card.itemLineageId);
      if (!current || current.step !== 'question' || current.status !== 'running' || !card || !paragraph ||
          paragraph.version !== job.paragraphVersion || !head || head.version !== card.itemVersion ||
          head.status === 'removed' || head.needsConfirmation || head.unchecked) {
        if (current?.status === 'running') await tx.objectStore('jobs').put({ ...current, status: 'superseded' });
        await tx.done; return false;
      }
      const terms = privacy?.terms ?? [];
      const leak = filterQuestion(question, terms);
      const eventBase = { paragraphId: paragraph.id, paragraphVersion: paragraph.version, at: now, cardId: card.id };
      if (!passedAtGeneration || !leak.passed) {
        await tx.objectStore('cards').put({ ...card, questionStatus: 'blocked', questionReason: 'private detail' });
        await tx.objectStore('funnel').put({ ...eventBase, id: id(), event: 'question', reason: 'private detail' });
      } else {
        const outboxId = id();
        await tx.objectStore('outbox').put({ id: outboxId, question,
          keptOut: keptOut.filter(value => filterQuestion(value, terms).passed), cardId: card.id,
          itemLineageId: card.itemLineageId, itemVersion: card.itemVersion, status: 'pending', createdAt: now });
        await tx.objectStore('cards').put({ ...card, questionStatus: 'ready', outboxId });
        await tx.objectStore('funnel').put({ ...eventBase, id: id(), event: 'question', reason: 'passed' });
        await tx.objectStore('funnel').put({ ...eventBase, id: id(), event: 'outbox', reason: 'pending' });
        if (!card.brief) await tx.objectStore('jobs').put({ key: `${job.key}#whynote`, paragraphId: paragraph.id,
          paragraphVersion: paragraph.version, step: 'whynote', promptVersion: 'whynote.v1', cardId: card.id,
          status: 'pending', attempts: 0, createdAt: now, nextRunAt: now });
      }
      await tx.objectStore('jobs').put({ ...current, status: 'done' });
      await tx.done; return true;
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }
  async whyInput(job: StoredJob): Promise<{ card: ThoughtCard; question: string; profile: ProfileRecord[] } | null> {
    if (!job.cardId) return null;
    const tx = this.db.transaction(['cards', 'profile', 'outbox', 'paragraphs', 'lineageVersions'], 'readonly');
    void tx.done.catch(() => undefined);
    try {
      const [card, profile, paragraph, versions] = await Promise.all([tx.objectStore('cards').get(job.cardId),
        tx.objectStore('profile').getAll(), tx.objectStore('paragraphs').get(job.paragraphId),
        tx.objectStore('lineageVersions').getAll()]);
      const outbox = card?.outboxId ? await tx.objectStore('outbox').get(card.outboxId) : undefined;
      await tx.done;
      const head = card && lineageHeads(versions).find(value => value.lineageId === card.itemLineageId);
      if (!card || !outbox || outbox.status === 'withdrawn' || !paragraph ||
          paragraph.version !== job.paragraphVersion ||
          !head || head.version !== card.itemVersion || head.status === 'removed' || head.needsConfirmation ||
          head.unchecked) return null;
      return { card, question: outbox.question, profile };
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }
  async completeWhy(job: StoredJob, note: ThoughtCard['why'], supplied: ProfileRecord[],
    fingerprints: RecordFingerprint[]): Promise<boolean> {
    const tx = this.db.transaction(['jobs', 'cards', 'paragraphs', 'lineageVersions', 'profile'], 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const [current, card, paragraph, versions] = await Promise.all([tx.objectStore('jobs').get(job.key),
        job.cardId ? tx.objectStore('cards').get(job.cardId) : Promise.resolve(undefined),
        tx.objectStore('paragraphs').get(job.paragraphId), tx.objectStore('lineageVersions').getAll()]);
      const head = card && lineageHeads(versions).find(value => value.lineageId === card.itemLineageId);
      if (!current || current.step !== 'whynote' || current.status !== 'running' || !card || !paragraph ||
          paragraph.version !== job.paragraphVersion || !head || head.version !== card.itemVersion ||
          head.status === 'removed' || head.needsConfirmation || head.unchecked) {
        if (current?.status === 'running') await tx.objectStore('jobs').put({ ...current, status: 'superseded' });
        await tx.done; return false;
      }
      const records = await tx.objectStore('profile').getAll();
      const valid = supplied.every(original => {
        const currentRecord = records.find(record => record.id === original.id);
        return currentRecord && recordSemantics(currentRecord) === recordSemantics(original);
      });
      if (!valid) {
        const refreshCount = card.whyRefreshCount ?? 0;
        await tx.objectStore('cards').put({ ...card, why: null, whyFingerprints: undefined,
          whyRefreshCount: Math.min(1, refreshCount + 1) });
        if (!refreshCount) await tx.objectStore('jobs').put({ ...current, key: `${current.key}#profile-refresh`,
          status: 'pending', attempts: 0, createdAt: Date.now(), nextRunAt: Date.now() });
      } else {
        await tx.objectStore('cards').put({ ...card, why: note ?? null, whyFingerprints: note ? fingerprints : [],
          whyRefreshCount: 0 });
      }
      await tx.objectStore('jobs').put({ ...current, status: 'done' });
      await tx.done; return true;
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }
  async reconcileWhyNotes(): Promise<void> {
    const snapshot = await this.snapshot();
    if (!(snapshot.cards ?? []).some(card => card.why)) return;
    const fingerprints = await fingerprintRecords(snapshot.profile);
    const byId = new Map(fingerprints.map(value => [value.id, value.hash]));
    const invalid = (snapshot.cards ?? []).filter(card => card.why && (!card.whyFingerprints ||
      card.whyFingerprints.some(value => byId.get(value.id) !== value.hash)));
    if (!invalid.length) return;
    const tx = this.db.transaction(['profile', 'cards', 'jobs', 'paragraphs'], 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const currentProfile = await tx.objectStore('profile').getAll();
      const canonical = (records: ProfileRecord[]) => JSON.stringify(records.map(record =>
        [record.id, recordSemantics(record)]).sort((a, b) => a[0].localeCompare(b[0])));
      if (canonical(snapshot.profile) !== canonical(currentProfile)) { await tx.done; return; }
      const cards = await tx.objectStore('cards').getAll();
      const jobs = await tx.objectStore('jobs').getAll();
      const paragraphs = await tx.objectStore('paragraphs').getAll();
      for (const prior of invalid) {
        const card = cards.find(value => value.id === prior.id);
        if (!card || JSON.stringify([card.why, card.whyFingerprints]) !==
            JSON.stringify([prior.why, prior.whyFingerprints])) continue;
        const changed = new Set((card.whyFingerprints ?? []).filter(value => byId.get(value.id) !== value.hash)
          .map(value => value.id));
        if (!card.whyFingerprints) {
          card.whyFingerprints = [{ id: '__legacy_missing_fingerprint__', hash: '' }];
          changed.add('__legacy_missing_fingerprint__');
        }
        await invalidateProfileNotes([card], jobs, paragraphs, changed,
          value => tx.objectStore('cards').put(value), value => tx.objectStore('jobs').put(value));
      }
      await tx.done;
    } catch (error) { try { tx.abort(); } catch { /* Already finished. */ }
      await tx.done.catch(() => undefined); throw error; }
  }
  async funnel(): Promise<FunnelEvent[]> { return this.db.getAll('funnel'); }
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
    const tx = this.db.transaction(['paragraphs', 'paragraphVersions', 'items', 'jobs', 'lineageVersions', 'cards'],
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
          if (job.cardId && (job.step === 'question' || job.step === 'whynote')) {
            const card = await tx.objectStore('cards').get(job.cardId);
            if (current && card) {
              await tx.objectStore('jobs').put({ ...job, key: `${job.key}#retarget@${current.version}`,
                paragraphVersion: current.version, status: 'pending', nextRunAt: now });
            } else if (card && job.step === 'question') {
              await tx.objectStore('cards').put({ ...card, questionStatus: 'blocked', questionReason: 'stale' });
            }
          }
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
    const tx = this.db.transaction(['jobs', 'comparisonBatches', 'cards', 'funnel'], 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      for (const job of await tx.objectStore('jobs').getAll()) {
        if (job.status === 'running') {
          const exhausted = job.attempts >= MAX_ATTEMPTS;
          await tx.objectStore('jobs').put(exhausted
            ? { ...job, status: 'failed', failureReason: 'interrupted-at-attempt-limit' }
            : { ...job, status: 'pending' });
          if (exhausted && ['angles', 'question', 'whynote'].includes(job.step)) {
            const card = job.cardId ? await tx.objectStore('cards').get(job.cardId) : undefined;
            const failed = triageFailure(job, card, Date.now());
            if (failed.card) await tx.objectStore('cards').put(failed.card);
            await tx.objectStore('funnel').put(failed.event);
          }
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
    const tx = this.db.transaction(['jobs', 'paragraphs', 'comparisonBatches', 'cards', 'funnel', 'lineageVersions'],
      'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const jobs = (await tx.objectStore('jobs').getAll()).filter(j => j.status === 'pending' && j.nextRunAt <= now)
        .sort((a, b) => a.createdAt - b.createdAt || a.key.localeCompare(b.key));
      for (const job of jobs) {
        if (job.attempts >= MAX_ATTEMPTS) {
          await tx.objectStore('jobs').put({ ...job, status: 'failed',
            failureReason: 'interrupted-at-attempt-limit' });
          if (['angles', 'question', 'whynote'].includes(job.step)) {
            const card = job.cardId ? await tx.objectStore('cards').get(job.cardId) : undefined;
            const failed = triageFailure(job, card, now);
            if (failed.card) await tx.objectStore('cards').put(failed.card);
            await tx.objectStore('funnel').put(failed.event);
          }
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
        if (job.cardId && (job.step === 'question' || job.step === 'whynote')) {
          const card = await tx.objectStore('cards').get(job.cardId);
          const eligibility = card ? lineageEligibility(card.itemLineageId, card.itemVersion,
            await tx.objectStore('paragraphs').getAll(), await tx.objectStore('lineageVersions').getAll(),
            await tx.objectStore('jobs').getAll()) : 'stale';
          if (eligibility === 'checking' || eligibility === 'terminal') continue;
          if (eligibility === 'stale') {
            await tx.objectStore('jobs').put({ ...job, status: 'superseded' });
            if (card && job.step === 'question') {
              await tx.objectStore('cards').put({ ...card, questionStatus: 'blocked', questionReason: 'stale' });
            }
            continue;
          }
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
    const tx = this.db.transaction(['comparisonBatches', 'paragraphs', 'items', 'lineageVersions', 'cards'],
      'readwrite');
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
      const cards = await tx.objectStore('cards').getAll();
      const retireFailure = async (lineageId: string) => {
        for (const card of cards) {
          if (card.itemLineageId !== lineageId || card.recheckFailedVersion === undefined ||
              card.recheckFailedVersion >= paragraph.version) continue;
          const { recheckFailedVersion: _retired, ...rest } = card;
          await tx.objectStore('cards').put(rest);
        }
      };
      for (const { lineage, item } of batch.old) {
        const decision = batch.decisions[lineage.lineageId];
        const assigned = assignments.get(lineage.lineageId);
        if (decision.status === 'removed') {
          await tx.objectStore('lineageVersions').put({ ...lineage, version: lineage.version + 1,
            status: 'removed', paragraphVersion: paragraph.version, changedFrom: item.id,
            needsConfirmation: false, unchecked: false, uncheckedReason: undefined });
          await retireFailure(lineage.lineageId);
          continue;
        }
        let successor = assigned ? batch.items.find(candidate => candidate.id === assigned) : undefined;
        if (successor) used.add(successor.id);
        else successor = { ...item, id: id(), paragraphVersion: paragraph.version, status: 'current',
          createdAt: Date.now() };
        successor = { ...successor, lineageId: lineage.lineageId };
        await tx.objectStore('items').put(successor);
        const changed = decision.status === 'changed';
        const nextLineage: LineageVersion = { ...lineage, itemId: successor.id,
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
          uncheckedReason: decision.status === 'unchecked' ? decision.reason : undefined };
        await tx.objectStore('lineageVersions').put(nextLineage);
        if (!nextLineage.unchecked && !nextLineage.needsConfirmation) await retireFailure(lineage.lineageId);
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
  async supersedeJob(job: StoredJob): Promise<void> {
    const tx = this.db.transaction('jobs', 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const current = await tx.store.get(job.key);
      if (current?.status === 'running') await tx.store.put({ ...current, status: 'superseded' });
      await tx.done;
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
    const tx = this.db.transaction(['jobs', 'paragraphs', 'comparisonBatches', 'lineageVersions', 'cards', 'funnel',
      'outbox'], 'readwrite');
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
          if (terminal && ['angles', 'question', 'whynote'].includes(current.step)) {
            const card = current.cardId ? await tx.objectStore('cards').get(current.cardId) : undefined;
            const failed = triageFailure(current, card, now);
            if (failed.card) await tx.objectStore('cards').put(failed.card);
            await tx.objectStore('funnel').put(failed.event);
          }
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
          if (terminal && (current.step === 'extract' || current.step === 'compare')) {
            await resolveTerminalDependents(await tx.objectStore('paragraphs').getAll(),
              await tx.objectStore('lineageVersions').getAll(), await tx.objectStore('jobs').getAll(),
              await tx.objectStore('cards').getAll(), await tx.objectStore('outbox').getAll(), now,
              value => tx.objectStore('cards').put(value), value => tx.objectStore('jobs').put(value),
              value => tx.objectStore('outbox').put(value), value => tx.objectStore('funnel').put(value));
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
  async queueOutbox(entry: Omit<OutboxEntry, 'status'>, privateTokens: string[] = []): Promise<boolean> {
    const tx = this.db.transaction(['outbox', 'privacy', 'lineageVersions'], 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const terms = (await tx.objectStore('privacy').get('never-send'))?.terms ?? [];
      const head = lineageHeads(await tx.objectStore('lineageVersions').getAll())
        .find(value => value.lineageId === entry.itemLineageId);
      if (!head || head.version !== entry.itemVersion || head.status === 'removed' || head.needsConfirmation ||
          head.unchecked || !filterQuestion(entry.question, terms, privateTokens).passed) {
        await tx.done; return false;
      }
      const keptOut = entry.keptOut.filter(value => filterQuestion(value, terms, privateTokens).passed);
      await tx.objectStore('outbox').put({ ...entry, keptOut, status: 'pending' });
      await tx.done; return true;
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }
  async decideOutbox(entryId: string, decision: 'approved' | 'rejected'): Promise<boolean> {
    const tx = this.db.transaction(['outbox', 'privacy', 'lineageVersions', 'cards', 'funnel', 'paragraphs', 'jobs'],
      'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const entry = await tx.objectStore('outbox').get(entryId);
      if (!entry || entry.status !== 'pending') { await tx.done; return false; }
      const terms = (await tx.objectStore('privacy').get('never-send'))?.terms ?? [];
      const eligibility = lineageEligibility(entry.itemLineageId, entry.itemVersion,
        await tx.objectStore('paragraphs').getAll(), await tx.objectStore('lineageVersions').getAll(),
        await tx.objectStore('jobs').getAll());
      if (eligibility === 'checking') {
        if (decision === 'approved') { await tx.done; return false; }
        const now = Date.now();
        await tx.objectStore('outbox').put({ ...entry, status: 'rejected', decidedAt: now });
        const card = await tx.objectStore('cards').get(entry.cardId);
        if (card) await tx.objectStore('funnel').put(outboxEvent(card, 'rejected', now));
        await tx.done; return true;
      }
      const stale = eligibility === 'stale' || eligibility === 'terminal';
      const leak = filterQuestion(entry.question, terms);
      const listedMetadata = entry.keptOut.some(text => filterQuestion(text, terms).reasons.includes('listed-term'));
      if (stale || !leak.passed || listedMetadata) {
        const now = Date.now();
        const reason = stale ? 'stale' : leak.reasons.includes('listed-term') || listedMetadata
          ? 'listed-term' : 'private-detail';
        await tx.objectStore('outbox').put({ ...entry, status: 'withdrawn', decidedAt: now, withdrawReason: reason });
        const card = await tx.objectStore('cards').get(entry.cardId);
        if (card) await tx.objectStore('funnel').put(outboxEvent(card, `withdrawn:${reason}`, now));
        await tx.done; return false;
      }
      const now = Date.now();
      await tx.objectStore('outbox').put({ ...entry, status: decision, decidedAt: now });
      const card = await tx.objectStore('cards').get(entry.cardId);
      if (card) await tx.objectStore('funnel').put(outboxEvent(card, decision, now));
      await tx.done; return true;
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }
  // Privacy/staleness eligibility only: this hook does not send or authorize a cloud call in T06.
  async preSendCheck(entryId: string): Promise<{ allowed: boolean; reason: string | null }> {
    const tx = this.db.transaction(['outbox', 'privacy', 'lineageVersions', 'cards', 'funnel', 'paragraphs', 'jobs'],
      'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const entry = await tx.objectStore('outbox').get(entryId);
      if (!entry || entry.status !== 'approved') {
        await tx.done;
        return { allowed: false, reason: entry?.status === 'withdrawn' ? entry.withdrawReason ?? 'withdrawn'
          : 'not-approved' };
      }
      const terms = (await tx.objectStore('privacy').get('never-send'))?.terms ?? [];
      const eligibility = lineageEligibility(entry.itemLineageId, entry.itemVersion,
        await tx.objectStore('paragraphs').getAll(), await tx.objectStore('lineageVersions').getAll(),
        await tx.objectStore('jobs').getAll());
      if (eligibility === 'checking') { await tx.done; return { allowed: false, reason: 'not-eligible-yet' }; }
      const stale = eligibility === 'stale' || eligibility === 'terminal';
      const leak = filterQuestion(entry.question, terms);
      const listedMetadata = entry.keptOut.some(text => filterQuestion(text, terms).reasons.includes('listed-term'));
      if (stale || !leak.passed || listedMetadata) {
        const reason = stale ? 'stale' : leak.reasons.includes('listed-term') || listedMetadata
          ? 'listed-term' : 'private-detail';
        const now = Date.now();
        await tx.objectStore('outbox').put({ ...entry, status: 'withdrawn', withdrawReason: reason, decidedAt: now });
        const card = await tx.objectStore('cards').get(entry.cardId);
        if (card) await tx.objectStore('funnel').put(outboxEvent(card, `withdrawn:${reason}`, now));
        await tx.done; return { allowed: false, reason };
      }
      await tx.done; return { allowed: true, reason: null };
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }
  async reconcileOutbox(): Promise<void> {
    const tx = this.db.transaction(['outbox', 'lineageVersions', 'cards', 'funnel', 'paragraphs', 'jobs'],
      'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const [paragraphs, versions, jobs, cards, entries] = await Promise.all([
        tx.objectStore('paragraphs').getAll(), tx.objectStore('lineageVersions').getAll(),
        tx.objectStore('jobs').getAll(), tx.objectStore('cards').getAll(), tx.objectStore('outbox').getAll(),
      ]);
      const now = Date.now();
      await resolveTerminalDependents(paragraphs, versions, jobs, cards, entries, now,
        value => tx.objectStore('cards').put(value), value => tx.objectStore('jobs').put(value),
        value => tx.objectStore('outbox').put(value), value => tx.objectStore('funnel').put(value));
      for (const entry of entries) {
        if (entry.status !== 'pending' ||
            lineageEligibility(entry.itemLineageId, entry.itemVersion, paragraphs, versions, jobs) !== 'stale') {
          continue;
        }
        await tx.objectStore('outbox').put({ ...entry, status: 'withdrawn', withdrawReason: 'stale', decidedAt: now });
        const card = cards.find(value => value.id === entry.cardId);
        if (card) await tx.objectStore('funnel').put(outboxEvent(card, 'withdrawn:stale', now));
      }
      await tx.done;
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }
  async setFeedback(cardId: string, feedback: Feedback, now = Date.now()): Promise<boolean> {
    const tx = this.db.transaction(['cards', 'funnel'], 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const card = await tx.objectStore('cards').get(cardId);
      if (!card) { await tx.done; return false; }
      await tx.objectStore('cards').put({ ...card, feedback });
      await tx.objectStore('funnel').put({ id: id(), paragraphId: card.paragraphId,
        paragraphVersion: card.paragraphVersion, event: 'feedback', at: now, reason: feedback, cardId });
      await tx.done; return true;
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }
  async deleteOutbox(entryId: string): Promise<void> { await this.db.delete('outbox', entryId); }
  async putProfile(record: ProfileRecord): Promise<void> {
    const tx = this.db.transaction(['profile', 'cards', 'jobs', 'paragraphs'], 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const old = await tx.objectStore('profile').get(record.id);
      await tx.objectStore('profile').put(record);
      if (old && recordSemantics(old) !== recordSemantics(record)) {
        await invalidateProfileNotes(await tx.objectStore('cards').getAll(), await tx.objectStore('jobs').getAll(),
          await tx.objectStore('paragraphs').getAll(), new Set([record.id]),
          card => tx.objectStore('cards').put(card), job => tx.objectStore('jobs').put(job));
      }
      await tx.done;
    } catch (error) { try { tx.abort(); } catch { /* Already finished. */ }
      await tx.done.catch(() => undefined); throw error; }
  }
  async deleteProfile(key: string): Promise<void> {
    const tx = this.db.transaction(['profile', 'cards', 'jobs', 'paragraphs'], 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      await tx.objectStore('profile').delete(key);
      await invalidateProfileNotes(await tx.objectStore('cards').getAll(), await tx.objectStore('jobs').getAll(),
        await tx.objectStore('paragraphs').getAll(), new Set([key]),
        card => tx.objectStore('cards').put(card), job => tx.objectStore('jobs').put(job));
      await tx.done;
    } catch (error) { try { tx.abort(); } catch { /* Already finished. */ }
      await tx.done.catch(() => undefined); throw error; }
  }
  async putNeverSend(terms: string[]): Promise<void> {
    const validated = validateNeverSend(terms);
    const tx = this.db.transaction(['privacy', 'outbox', 'cards', 'funnel'], 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      await tx.objectStore('privacy').put({ key: 'never-send', terms: validated });
      const entries = await tx.objectStore('outbox').getAll();
      const now = Date.now();
      for (const entry of withdrawForTerms(entries, validated, now)) {
        await tx.objectStore('outbox').put(entry);
        const card = await tx.objectStore('cards').get(entry.cardId);
        if (card) await tx.objectStore('funnel').put(outboxEvent(card, 'withdrawn:listed-term', now));
      }
      await tx.done;
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }
  async replaceProfile(records: ProfileRecord[], terms?: string[]): Promise<void> {
    const validated = terms === undefined ? undefined : validateNeverSend(terms);
    const tx = this.db.transaction(['profile', 'privacy', 'outbox', 'cards', 'funnel', 'jobs', 'paragraphs'],
      'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const oldRecords = await tx.objectStore('profile').getAll();
      const changed = new Set(oldRecords.filter(old => {
        const replacement = records.find(record => record.id === old.id);
        return !replacement || recordSemantics(old) !== recordSemantics(replacement);
      }).map(record => record.id));
      await invalidateProfileNotes(await tx.objectStore('cards').getAll(), await tx.objectStore('jobs').getAll(),
        await tx.objectStore('paragraphs').getAll(), changed,
        card => tx.objectStore('cards').put(card), job => tx.objectStore('jobs').put(job));
      await tx.objectStore('profile').clear();
      for (const record of records) await tx.objectStore('profile').put(record);
      if (validated) {
        await tx.objectStore('privacy').put({ key: 'never-send', terms: validated });
        const entries = await tx.objectStore('outbox').getAll();
        const now = Date.now();
        for (const entry of withdrawForTerms(entries, validated, now)) {
          await tx.objectStore('outbox').put(entry);
          const card = await tx.objectStore('cards').get(entry.cardId);
          if (card) await tx.objectStore('funnel').put(outboxEvent(card, 'withdrawn:listed-term', now));
        }
      }
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
      'lineageVersions', 'dependencies', 'comparisonBatches', 'privacy', 'cards', 'funnel', 'anglesConsidered'],
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
export async function openLocalStore(name = 'thoughtpartner', events: {
  onBlocked?: () => void; onVersionChange?: () => void;
} = {}): Promise<LocalStore> {
  let db: IDBPDatabase<Database> | undefined;
  db = await openDB<Database>(name, STORE_VERSION, {
    blocked() { events.onBlocked?.(); },
    blocking() { db?.close(); events.onVersionChange?.(); },
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
      if (oldVersion < 4) {
        database.createObjectStore('anglesConsidered', { keyPath: ['lineageId', 'version'] });
        if (oldVersion === 3) {
          void (async () => {
            const [cards, paragraphs, items, versions, jobs, batches] = await Promise.all([
              tx.objectStore('cards').getAll(), tx.objectStore('paragraphs').getAll(),
              tx.objectStore('items').getAll(), tx.objectStore('lineageVersions').getAll(),
              tx.objectStore('jobs').getAll(), tx.objectStore('comparisonBatches').getAll(),
            ]);
            const considered = tx.objectStore('anglesConsidered');
            for (const card of cards) await considered.put({ lineageId: card.itemLineageId,
              version: card.itemVersion, recordedAt: Date.now(), source: 'migrated-card' });
            for (const paragraph of paragraphs) {
              if (!jobs.some(job => job.step === 'angles' && job.paragraphId === paragraph.id &&
                  job.paragraphVersion === paragraph.version && job.status === 'done') || batches.some(batch =>
                  batch.paragraphId === paragraph.id && batch.paragraphVersion === paragraph.version)) continue;
              for (const item of currentTriageItems(paragraph, items, versions)) {
                await considered.put({ lineageId: item.lineageId, version: item.version, recordedAt: Date.now(),
                  source: 'migrated-current' });
              }
            }
          })().catch(() => { try { tx.abort(); } catch { /* Upgrade has already aborted. */ } });
        }
      }
      if (oldVersion < 3) {
        database.createObjectStore('privacy', { keyPath: 'key' });
        database.createObjectStore('cards', { keyPath: 'id' });
        database.createObjectStore('funnel', { keyPath: 'id' });
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
