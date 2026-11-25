import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { matchParagraphs, type Paragraph } from './matcher';
import { firstParagraph, openingMatches, sentenceBoundedOpening, type OpeningBasis } from './ideaBasis';
import { extractionEligible, isHeadingBlock } from '../structure/planStructure';
import { safeErrorName } from '../ai/errorMetadata';
import { isResearchFailureCode, type ResearchFailureCode } from '../ai/researchFailure';
import { calculateStaleness } from './staleness';
import { lineageEligibility } from './eligibility';
import { fingerprintRecords, recordSemantics, type RecordFingerprint } from './fingerprint';
import { validateNeverSend } from '../privacy/terms';
import { filterQuestion } from '../pipeline/leakFilter';
import { eligibleItems, type TriageItem } from '../pipeline/triage';
import { selectConcerns, type Concern, type DisplayAngle, type Pair } from '../pipeline/selectConcerns';
import { TRIAGE_PROMPT_SET, triagePromptVersions, versionFromPrompt, type TriageVersion }
  from '../pipeline/triageVersion';
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
export type IdeaBasis = { lineageId: string; version: number };
export interface IdeaRecord {
  id: string; status: 'ready' | 'approved' | 'declined' | 'sent' | 'failed' | 'withdrawn';
  draft: string; keptOut: string[]; finalText?: string; edited?: boolean; basis: IdeaBasis[];
  statements: string[]; mode: 'on_device' | 'in_cloud'; describePromptVersion: 'describe.v1' | 'describe.v2';
  openingBasis?: OpeningBasis;
  researchPromptVersion: 'research.idea.v1'; createdAt: number; updatedAt: number; outboxId?: string;
  describeJobKey: string;
}
export interface StoredJob {
  key: string; paragraphId: string; paragraphVersion: number;
  step: 'extract' | 'compare' | 'angles' | 'question' | 'whynote' | 'describe';
  promptVersion: 'extract.v1' | 'extract.v2' | 'compare.v1' | 'angles.v1' | 'angles.v2' | 'angles.v2.1' |
    'question.v1' | 'question.v2' | 'question.v2.1' | 'whynote.v1' | 'whynote.v2' | 'describe.v1' | 'describe.v2';
  lineageId?: string; cardId?: string; ideaId?: string; requested?: boolean;
  status: 'pending' | 'running' | 'done' | 'superseded' | 'failed'; attempts: number; createdAt: number;
  nextRunAt: number; errorName?: string; measuredSource?: 'on_device' | 'in_cloud';
  runMode?: 'on_device' | 'in_cloud'; cloudEligible?: boolean;
  failureReason?: 'interrupted-at-attempt-limit' | 'revalidation-failed' | 'model-input-quota';
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
  research: { key: number; value: ResearchReceipt };
  cloudProcessing: { key: number; value: { sentAt: number } };
  ideas: { key: string; value: IdeaRecord };
}
export type ResearchReceipt = { entryId: string; sentAt: number; status: 'sent' | 'completed' | 'failed';
  failureCode?: ResearchFailureCode };
export const STORE_VERSION = 7;
export const CLOUD_PROCESSING_DAILY_LIMIT = 150;
export const LEGACY_KEY = 'thoughtpartner-notebook';
export const SETTLE_MS = 4000;
export class SampleChangedError extends Error {
  constructor() { super('Your notebook changed, so nothing was removed.'); }
}
export const MIN_WORDS = 12;
export const MAX_ATTEMPTS = 3;
export const jobKey = (id: string, version: number) => `${id}@${version}#extract`;
export const compareJobKey = (id: string, version: number, lineage: string) => `${id}@${version}#compare#${lineage}`;
const batchKey = (id: string, version: number) => `${id}@${version}`;
export const wordCount = (text: string) => text.trim() ? text.trim().split(/\s+/).length : 0;
const id = () => crypto.randomUUID();
export type Snapshot = { paragraphs: Paragraph[]; items: StoredItem[]; profile: ProfileRecord[]; jobs: StoredJob[];
  lineages?: LineageVersion[]; neverSend?: string[]; cards?: ThoughtCard[]; outbox?: OutboxEntry[];
  dependencies?: Dependency[]; researchReceipts?: ResearchReceipt[]; cloudProcessingSends?: number[];
  cloudModeEnabled?: boolean; ideas?: IdeaRecord[] };
type LegacyStorage = Pick<Storage, 'getItem' | 'removeItem'>;
function currentTriageItems(paragraph: Paragraph, items: StoredItem[], versions: LineageVersion[],
  version: TriageVersion = TRIAGE_PROMPT_SET): TriageItem[] {
  if (isHeadingBlock(paragraph.text)) return [];
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
  return eligibleItems(paragraph.text, list, version);
}
function unconsideredItems(items: TriageItem[], considered: Array<{ lineageId: string; version: number }>) {
  const keys = new Set(considered.map(value => JSON.stringify([value.lineageId, value.version])));
  return items.filter(item => !keys.has(JSON.stringify([item.lineageId, item.version])));
}
function triageFailure(job: StoredJob, card: ThoughtCard | undefined, now: number):
  { card?: ThoughtCard; event: FunnelEvent } {
  const updated = card && (job.step === 'question' || (job.step === 'angles' && job.requested))
    ? { ...card, questionStatus: 'blocked' as const,
    questionReason: 'local-step-failed' as const }
    : card && job.step === 'whynote' ? { ...card, why: null } : card;
  return { card: updated, event: { id: id(), paragraphId: job.paragraphId, paragraphVersion: job.paragraphVersion,
    event: 'held', at: now, reason: 'local-step-failed',
    promptVersions: triagePromptVersions(card?.triageVersion ?? versionFromPrompt(job.promptVersion)),
    ...(job.cardId ? { cardId: job.cardId } : {}) } };
}
async function invalidateProfileNotes(cards: ThoughtCard[], jobs: StoredJob[], paragraphs: Paragraph[],
  changedIds: Set<string>, putCard: (card: ThoughtCard) => Promise<unknown>,
  putJob: (job: StoredJob) => Promise<unknown>): Promise<void> {
  for (const card of cards) {
    if (card.triageVersion === 'v2.1' || !card.why ||
        !card.whyFingerprints?.some(value => changedIds.has(value.id))) continue;
    const pending = jobs.some(job => job.cardId === card.id && job.step === 'whynote' &&
      (job.status === 'pending' || job.status === 'running'));
    const paragraph = paragraphs.find(value => value.id === card.paragraphId);
    const refreshCount = card.whyRefreshCount ?? 0;
    await putCard({ ...card, why: null, whyFingerprints: undefined,
      whyRefreshCount: Math.min(1, refreshCount + 1) });
    if (!pending && !refreshCount && paragraph) {
      const now = Date.now();
      const promptVersion = triagePromptVersions(card.triageVersion ?? 'v1').whynote;
      if (!promptVersion) continue;
      await putJob({ key: `${card.id}#profile-refresh#${crypto.randomUUID()}`, paragraphId: paragraph.id,
        paragraphVersion: paragraph.version, step: 'whynote', promptVersion, cardId: card.id,
        status: 'pending', attempts: 0, createdAt: now, nextRunAt: now });
    }
  }
}
function outboxEvent(card: ThoughtCard, reason: string, now: number): FunnelEvent {
  const versions = triagePromptVersions(card.triageVersion ?? 'v1');
  return { id: id(), paragraphId: card.paragraphId, paragraphVersion: card.paragraphVersion,
    event: 'outbox', at: now, reason, cardId: card.id,
    promptVersions: { ...versions,
      question: card.noCheckable ? null : card.questionPromptVersion ?? versions.question } };
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
    if (entry.kind === 'idea' || !entry.itemLineageId || entry.itemVersion === undefined ||
        (entry.status !== 'pending' && entry.status !== 'approved') ||
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
      'cards', 'outbox', 'dependencies', 'research', 'cloudProcessing', 'meta', 'ideas'], 'readonly');
    void tx.done.catch(() => undefined);
    try {
      const [paragraphs, items, profile, jobs, lineages, privacy, cards, outbox, dependencies, researchReceipts,
        cloudSends, cloudMode, ideas] = await Promise.all([
        tx.objectStore('paragraphs').getAll(), tx.objectStore('items').getAll(),
        tx.objectStore('profile').getAll(), tx.objectStore('jobs').getAll(), tx.objectStore('lineageVersions').getAll(),
        tx.objectStore('privacy').get('never-send'), tx.objectStore('cards').getAll(),
        tx.objectStore('outbox').getAll(), tx.objectStore('dependencies').getAll(),
        tx.objectStore('research').getAll(), tx.objectStore('cloudProcessing').getAll(),
        tx.objectStore('meta').get('cloud-mode-consent'), tx.objectStore('ideas').getAll(),
      ]);
      await tx.done;
      paragraphs.sort((a, b) => a.order - b.order);
      return { paragraphs, items, profile, jobs, lineages, neverSend: privacy?.terms ?? [], cards, outbox,
        dependencies, researchReceipts, cloudProcessingSends: cloudSends.map(send => send.sentAt),
        cloudModeEnabled: cloudMode?.value === true, ideas };
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }
  /** Coherent, read-only admission snapshot for optional on-device shortlist ranking. */
  async pickSnapshot(version: 'extract.v1' | 'extract.v2', now: number):
    Promise<{ snapshot: Snapshot; ready: boolean }> {
    const tx = this.db.transaction(['paragraphs', 'items', 'jobs', 'lineageVersions', 'cards', 'anglesConsidered',
      'comparisonBatches', 'meta'], 'readonly');
    void tx.done.catch(() => undefined);
    try {
      const [paragraphs, items, jobs, lineages, cards, considered, batches, mode] = await Promise.all([
        tx.objectStore('paragraphs').getAll(), tx.objectStore('items').getAll(), tx.objectStore('jobs').getAll(),
        tx.objectStore('lineageVersions').getAll(), tx.objectStore('cards').getAll(),
        tx.objectStore('anglesConsidered').getAll(), tx.objectStore('comparisonBatches').getAll(),
        tx.objectStore('meta').get('cloud-mode-consent'),
      ]);
      await tx.done;
      const snapshot: Snapshot = { paragraphs, items, jobs, lineages, cards, profile: [],
        cloudModeEnabled: mode?.value === true };
      const pending = jobs.some(job => (job.runMode ?? 'on_device') === 'on_device' &&
        (job.status === 'pending' || job.status === 'running') && paragraphs.some(p =>
          p.id === job.paragraphId && p.version === job.paragraphVersion));
      const ready = !snapshot.cloudModeEnabled && !pending && paragraphs.every(paragraph => {
        if (!extractionEligible(paragraph.text, 'on_device', version, MIN_WORDS)) return true;
        const extract = jobs.find(job => job.key === jobKey(paragraph.id, paragraph.version));
        const batch = batches.some(value => value.paragraphId === paragraph.id &&
          value.paragraphVersion === paragraph.version);
        const unlinked = items.some(item => item.paragraphId === paragraph.id &&
          item.paragraphVersion === paragraph.version && item.status === 'current' && !item.lineageId);
        return now - paragraph.updatedAt >= SETTLE_MS && extract?.status === 'done' && !batch && !unlinked &&
          unconsideredItems(currentTriageItems(paragraph, items, lineages), considered).length === 0;
      });
      return { snapshot, ready };
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }
  async startIdea(now = Date.now()): Promise<{ idea?: IdeaRecord; created?: boolean; reason?: string }> {
    const tx = this.db.transaction(['ideas', 'paragraphs', 'items', 'lineageVersions', 'jobs', 'meta'], 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const [paragraphs, items, versions, jobs, mode, ideas] = await Promise.all([
        tx.objectStore('paragraphs').getAll(), tx.objectStore('items').getAll(),
        tx.objectStore('lineageVersions').getAll(), tx.objectStore('jobs').getAll(),
        tx.objectStore('meta').get('cloud-mode-consent'), tx.objectStore('ideas').getAll(),
      ]);
      const active = jobs.find(job => job.step === 'describe' &&
        (job.status === 'pending' || job.status === 'running'));
      if (active?.ideaId) {
        const existing = await tx.objectStore('ideas').get(active.ideaId);
        if (existing && openingMatches(existing.openingBasis, paragraphs,
          existing.describePromptVersion === 'describe.v2')) { await tx.done; return { idea: existing }; }
        await tx.objectStore('jobs').put({ ...active, status: 'superseded', errorName: 'PlanChanged' });
      }
      const heads = lineageHeads(versions);
      const current = new Set(paragraphs.filter(paragraph => !isHeadingBlock(paragraph.text))
        .flatMap(paragraph => currentTriageItems(paragraph, items, versions, 'v2.1'))
        .map(item => item.lineageId));
      const kinds = ['assumption', 'decision', 'constraint', 'open-question'];
      const selected = items.filter(item => item.status === 'current' && item.lineageId &&
        current.has(item.lineageId) && kinds.includes(item.kind) &&
        heads.some(head => head.itemId === item.id && head.lineageId === item.lineageId &&
          lineageEligibility(head.lineageId, head.version, paragraphs, versions, jobs) === 'eligible'))
        .sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind) ||
          (paragraphs.find(p => p.id === a.paragraphId)?.order ?? 0) -
            (paragraphs.find(p => p.id === b.paragraphId)?.order ?? 0) ||
          (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id)).slice(0, 10);
      if (selected.length < 3) { await tx.done; return { reason: 'Add at least three current statements first.' }; }
      const opening = firstParagraph(paragraphs);
      if (!opening) { await tx.done; return { reason: 'Add a first paragraph before researching your idea.' }; }
      const ideaId = id();
      const describeJobKey = `idea#${ideaId}#describe`;
      const idea: IdeaRecord = { id: ideaId, status: 'ready', draft: '', keptOut: [], describeJobKey,
        basis: selected.map(item => { const head = heads.find(value => value.itemId === item.id)!;
          return { lineageId: head.lineageId, version: head.version }; }),
        statements: selected.map(item => item.text), mode: mode?.value ? 'in_cloud' : 'on_device',
        openingBasis: { id: opening.id, version: opening.version, order: opening.order },
        describePromptVersion: 'describe.v2', researchPromptVersion: 'research.idea.v1',
        createdAt: Math.max(now, ...ideas.map(value => value.createdAt + 1)), updatedAt: now };
      await tx.objectStore('ideas').put(idea);
      await tx.objectStore('jobs').put({ key: describeJobKey, paragraphId: opening.id,
        paragraphVersion: opening.version, step: 'describe', promptVersion: 'describe.v2', ideaId,
        status: 'pending', attempts: 0, createdAt: now, nextRunAt: now, runMode: idea.mode });
      await tx.done; return { idea, created: true };
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined); throw error;
    }
  }
  async finishIdeaDraft(job: StoredJob, description: string, keptOut: string[], now = Date.now()): Promise<boolean> {
    const tx = this.db.transaction(['ideas', 'jobs', 'paragraphs'], 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const current = await tx.objectStore('jobs').get(job.key);
      const idea = job.ideaId ? await tx.objectStore('ideas').get(job.ideaId) : undefined;
      if (!idea || idea.status !== 'ready' || !current || current.step !== 'describe' ||
          current.status !== 'running' || current.attempts !== job.attempts || idea.describeJobKey !== job.key) {
        await tx.done; return false;
      }
      if (!openingMatches(idea.openingBasis, await tx.objectStore('paragraphs').getAll(),
        idea.describePromptVersion === 'describe.v2')) {
        await tx.objectStore('jobs').put({ ...current, status: 'superseded', errorName: 'PlanChanged' });
        await tx.done; return false;
      }
      const count = wordCount(description);
      await tx.objectStore('ideas').put({ ...idea, draft: count >= 8 && count <= 60 ? description : '',
        keptOut: count >= 8 && count <= 60 ? keptOut : [], updatedAt: now });
      await tx.objectStore('jobs').put({ ...current, status: 'done' });
      await tx.done; return true;
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined); throw error;
    }
  }
  async ideaForJob(job: StoredJob): Promise<(IdeaRecord & { openingText?: string }) | undefined> {
    const tx = this.db.transaction(['ideas', 'jobs', 'paragraphs'], 'readwrite');
    const current = await tx.objectStore('jobs').get(job.key);
    const idea = job.ideaId ? await tx.objectStore('ideas').get(job.ideaId) : undefined;
    const eligible = current?.status === 'running' && current.attempts === job.attempts && idea?.status === 'ready' &&
      idea.describeJobKey === job.key;
    const paragraphs = eligible ? await tx.objectStore('paragraphs').getAll() : [];
    const valid = !eligible || openingMatches(idea.openingBasis, paragraphs,
      idea.describePromptVersion === 'describe.v2');
    if (eligible && !valid) await tx.objectStore('jobs').put({ ...current, status: 'superseded',
      errorName: 'PlanChanged' });
    await tx.done;
    return eligible && valid ? { ...idea, ...(idea.describePromptVersion === 'describe.v2'
      ? { openingText: sentenceBoundedOpening(firstParagraph(paragraphs)!.text) } : {}) } : undefined;
  }
  async cloudModeConsent(): Promise<boolean> {
    return (await this.db.get('meta', 'cloud-mode-consent'))?.value === true;
  }
  async setCloudModeConsent(value: boolean): Promise<void> {
    const tx = this.db.transaction(['meta', 'jobs', 'comparisonBatches', 'cards', 'funnel', 'paragraphs'],
      'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const previous = (await tx.objectStore('meta').get('cloud-mode-consent'))?.value === true;
      await tx.objectStore('meta').put({ key: 'cloud-mode-consent', value });
      if (previous !== value) for (const job of await tx.objectStore('jobs').getAll()) {
        if (job.step === 'describe' && (job.runMode ?? 'on_device') !== (value ? 'in_cloud' : 'on_device') &&
            (job.status === 'pending' || job.status === 'running')) {
          await tx.objectStore('jobs').put({ ...job, status: 'superseded', errorName: 'ModeChanged' });
        }
      }
      if (value) for (const job of await tx.objectStore('jobs').getAll()) {
        if (job.status !== 'pending' || job.step !== 'extract' || job.promptVersion !== 'extract.v2') continue;
        const paragraph = await tx.objectStore('paragraphs').get(job.paragraphId);
        if (paragraph?.version === job.paragraphVersion && wordCount(paragraph.text) < MIN_WORDS) {
          await tx.objectStore('jobs').put({ ...job, runMode: 'on_device', cloudEligible: false });
        } else if (job.runMode === 'on_device' && job.cloudEligible) {
          await tx.objectStore('jobs').put({ ...job, runMode: 'in_cloud' });
        }
      }
      if (!value) for (const job of await tx.objectStore('jobs').getAll()) {
        if (job.runMode !== 'in_cloud' || !['pending', 'running'].includes(job.status)) continue;
        const paragraph = job.step === 'extract' ? await tx.objectStore('paragraphs').get(job.paragraphId) : undefined;
        if (job.status === 'pending' && paragraph?.version === job.paragraphVersion &&
            wordCount(paragraph.text) < MIN_WORDS) {
          await tx.objectStore('jobs').put({ ...job, runMode: 'on_device', cloudEligible: false });
          continue;
        }
        await tx.objectStore('jobs').put({ ...job, status: 'failed', errorName: 'CloudModeRevoked' });
        if (job.step === 'compare' && job.lineageId) {
          const batch = await tx.objectStore('comparisonBatches').get(batchKey(job.paragraphId, job.paragraphVersion));
          if (batch) {
            batch.decisions[job.lineageId] = { status: 'unchecked', reason: 'CloudModeRevoked' };
            await tx.objectStore('comparisonBatches').put(batch);
          }
        }
        if (['angles', 'question', 'whynote'].includes(job.step)) {
          const card = job.cardId ? await tx.objectStore('cards').get(job.cardId) : undefined;
          const failure = triageFailure(job, card, Date.now());
          if (failure.card) await tx.objectStore('cards').put(failure.card);
          await tx.objectStore('funnel').put(failure.event);
        }
      }
      await tx.done;
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }
  async reserveCloudProcessing(now = Date.now()): Promise<number | null> {
    const tx = this.db.transaction(['cloudProcessing', 'meta'], 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const consent = (await tx.objectStore('meta').get('cloud-mode-consent'))?.value === true;
      const start = new Date(now); start.setHours(0, 0, 0, 0);
      const end = new Date(start); end.setDate(end.getDate() + 1);
      const sends = await tx.objectStore('cloudProcessing').getAll();
      if (!consent || sends.filter(send => send.sentAt >= start.getTime() && send.sentAt < end.getTime()).length >=
        CLOUD_PROCESSING_DAILY_LIMIT) { await tx.done; return null; }
      const key = await tx.objectStore('cloudProcessing').add({ sentAt: now });
      await tx.done; return key;
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }
  async cancelCloudProcessingReservation(key: number): Promise<void> { await this.db.delete('cloudProcessing', key); }
  async cloudConsent(): Promise<boolean> {
    return (await this.db.get('meta', 'cloud-consent'))?.value === true;
  }
  async setCloudConsent(value: boolean): Promise<void> {
    await this.db.put('meta', { key: 'cloud-consent', value });
  }
  async reserveResearch(entryId: string, limit: number, now = Date.now()): Promise<number | null> {
    const tx = this.db.transaction('research', 'readwrite');
    const start = new Date(now); start.setHours(0, 0, 0, 0);
    const end = new Date(start); end.setDate(end.getDate() + 1);
    const existing = await tx.store.getAll();
    if (existing.filter(item => item.sentAt >= start.getTime() && item.sentAt < end.getTime()).length >= limit) {
      await tx.done; return null;
    }
    const key = await tx.store.add({ entryId, sentAt: now, status: 'sent' });
    await tx.done; return key;
  }
  async cancelResearch(key: number): Promise<void> { await this.db.delete('research', key); }
  async finishResearch(key: number, status: 'completed' | 'failed', failureCode?: ResearchFailureCode): Promise<void> {
    const tx = this.db.transaction('research', 'readwrite');
    const receipt = await tx.store.get(key);
    if (receipt) await tx.store.put({ ...receipt, status,
      ...(status === 'failed' ? { failureCode: isResearchFailureCode(failureCode) ? failureCode : 'unknown' } :
        failureCode === 'ungrounded' ? { failureCode: 'ungrounded' as const } : {}) }, key);
    await tx.done;
  }
  async enqueueAngles(now: number, _mode: 'on_device' | 'in_cloud' = 'on_device'): Promise<void> {
    const tx = this.db.transaction(['paragraphs', 'items', 'jobs', 'lineageVersions', 'comparisonBatches',
      'anglesConsidered', 'meta'], 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const mode = (await tx.objectStore('meta').get('cloud-mode-consent'))?.value ? 'in_cloud' : 'on_device';
      const [paragraphs, items, versions, jobs, considered] = await Promise.all([
        tx.objectStore('paragraphs').getAll(), tx.objectStore('items').getAll(),
        tx.objectStore('lineageVersions').getAll(), tx.objectStore('jobs').getAll(),
        tx.objectStore('anglesConsidered').getAll()]);
      for (const paragraph of paragraphs) {
        const key = `${paragraph.id}@${paragraph.version}#angles`;
        const extract = jobs.find(job => job.key === jobKey(paragraph.id, paragraph.version));
        if (extract?.status !== 'done' || (extract.runMode ?? 'on_device') !== mode ||
            jobs.some(job => job.key === key) ||
            await tx.objectStore('comparisonBatches').get(batchKey(paragraph.id, paragraph.version)) ||
            !unconsideredItems(currentTriageItems(paragraph, items, versions, TRIAGE_PROMPT_SET), considered).length) {
          continue;
        }
        await tx.objectStore('jobs').put({ key, paragraphId: paragraph.id, paragraphVersion: paragraph.version,
          step: 'angles', promptVersion: triagePromptVersions(TRIAGE_PROMPT_SET).angles, status: 'pending', attempts: 0,
          createdAt: now, nextRunAt: now, runMode: mode });
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
      const version = versionFromPrompt(job.promptVersion);
      const current = currentTriageItems(paragraph, items, versions, version);
      const eligible = job.requested ? current.filter(item => item.lineageId === job.lineageId)
        : unconsideredItems(current, considered);
      return eligible.length ? { paragraph: paragraph.text, items: eligible } : null;
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }
  async completeAngles(job: StoredJob, input: { paragraph: string; items: TriageItem[] }, concerns: Concern[],
    sessionId: string, now = Date.now(), measuredSource?: 'on_device' | 'in_cloud'): Promise<boolean> {
    const tx = this.db.transaction(['jobs', 'paragraphs', 'items', 'lineageVersions', 'comparisonBatches', 'profile',
      'cards', 'dependencies', 'funnel', 'anglesConsidered', 'meta'], 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const [current, paragraph, items, versions, batch, profile, cards, considered] = await Promise.all([
        tx.objectStore('jobs').get(job.key), tx.objectStore('paragraphs').get(job.paragraphId),
        tx.objectStore('items').getAll(), tx.objectStore('lineageVersions').getAll(),
        tx.objectStore('comparisonBatches').get(batchKey(job.paragraphId, job.paragraphVersion)),
        tx.objectStore('profile').getAll(), tx.objectStore('cards').getAll(),
        tx.objectStore('anglesConsidered').getAll(),
      ]);
      if (current && current.attempts !== job.attempts) { await tx.done; return false; }
      const version = versionFromPrompt(job.promptVersion);
      if (job.requested) {
        const card = job.cardId ? cards.find(value => value.id === job.cardId) : undefined;
        const eligible = paragraph && currentTriageItems(paragraph, items, versions, 'v2.1')
          .filter(item => item.lineageId === job.lineageId);
        if (!current || current.status !== 'running' || !card || card.questionStatus !== 'waiting' || !paragraph ||
            batch || paragraph.version !== job.paragraphVersion || paragraph.text !== input.paragraph ||
            JSON.stringify(eligible) !== JSON.stringify(input.items) || input.items.length !== 1 ||
            input.items[0].version !== card.itemVersion) {
          if (current?.status === 'running') {
            await tx.objectStore('jobs').put({ ...current, status: 'superseded' });
            if (card?.questionStatus === 'waiting') await tx.objectStore('cards').put({ ...card,
              questionStatus: 'blocked', questionReason: 'stale' });
          }
          await tx.done; return false;
        }
        const picked = selectConcerns({ paragraph: paragraph.text, items: input.items, concerns, profile,
          used: [], angleCounts: {}, version: 'v2.1' }).picked[0];
        if (!picked) {
          await tx.objectStore('cards').put({ ...card, questionStatus: 'ready', noCheckable: true, draftQuestion: '' });
        } else {
          for (const other of cards) {
            if (other.id !== card.id && other.questionStatus === 'marked' && !other.supersededMark &&
                other.itemLineageId === card.itemLineageId && other.itemVersion === card.itemVersion &&
                (other.angle === picked.angle || other.angle === picked.concern.angle ||
                  other.sourceAngle === picked.concern.angle)) {
              await tx.objectStore('cards').put({ ...other, supersededMark: true });
            }
          }
          await tx.objectStore('cards').put({ ...card, angle: picked.angle, sourceAngle: picked.concern.angle,
            concern: picked.concern.concern, score: picked.score, lessonId: picked.lessonId, brief: false });
          const mode = (await tx.objectStore('meta').get('cloud-mode-consent'))?.value ? 'in_cloud' : 'on_device';
          await tx.objectStore('jobs').put({ key: `${job.key}#question#${card.id}`, paragraphId: paragraph.id,
            paragraphVersion: paragraph.version, step: 'question', promptVersion: 'question.v2.1', cardId: card.id,
            status: 'pending', attempts: 0, createdAt: now, nextRunAt: now, runMode: mode });
        }
        await tx.objectStore('jobs').put({ ...current, status: 'done', measuredSource });
        await tx.done; return true;
      }
      if (!current || current.step !== 'angles' || current.status !== 'running' || !paragraph || batch ||
          paragraph.version !== job.paragraphVersion || paragraph.text !== input.paragraph ||
          JSON.stringify(unconsideredItems(currentTriageItems(paragraph, items, versions, version), considered)) !==
            JSON.stringify(input.items)) {
        if (current?.status === 'running') await tx.objectStore('jobs').put({ ...current, status: 'superseded' });
        await tx.done; return false;
      }
      for (const item of input.items) await tx.objectStore('anglesConsidered').put({ lineageId: item.lineageId,
        version: item.version, recordedAt: now, source: 'adopted' });
      const used: Pair[] = cards.flatMap(card => card.angle && card.sourceAngle ? [{
        lineageId: card.itemLineageId, version: card.itemVersion, angle: card.angle, sourceAngle: card.sourceAngle,
      }] : []);
      const angleCounts: Partial<Record<DisplayAngle, number>> = {};
      for (const card of cards.filter(value => value.sessionId === sessionId)) {
        if (card.angle) angleCounts[card.angle] = (angleCounts[card.angle] ?? 0) + 1;
      }
      const heads = lineageHeads(versions);
      const priorLiveCards = cards.filter(card => {
        if (card.paragraphId !== paragraph.id || card.paragraphVersion >= paragraph.version ||
            card.questionStatus === 'waiting' || card.recheckFailedVersion !== undefined ||
            !card.angle || !card.sourceAngle) return false;
        const head = heads.find(value => value.lineageId === card.itemLineageId);
        return head && head.version === card.itemVersion && head.paragraphVersion === paragraph.version &&
          head.status !== 'removed' && !head.unchecked && !head.needsConfirmation;
      }).flatMap(card => card.angle && card.sourceAngle
        ? [{ quote: card.itemQuote, angle: card.angle, sourceAngle: card.sourceAngle }] : []);
      const selection = selectConcerns({ paragraph: input.paragraph, items: input.items, concerns, profile, used,
        priorLiveCards, version, angleCounts, alreadyShown: cards.filter(card => card.paragraphId === paragraph.id &&
          card.paragraphVersion === paragraph.version).length });
      for (const [modelOrder, concern] of concerns.entries()) {
        await tx.objectStore('funnel').put({ id: id(), paragraphId: paragraph.id, paragraphVersion: paragraph.version,
          event: 'considered', at: now, promptVersions: triagePromptVersions(version),
          concern: concern.concern, sourceAngle: concern.angle, modelOrder,
          itemIndex: concern.item, checkable: concern.checkable });
      }
      for (const held of selection.held) {
        await tx.objectStore('funnel').put({ id: id(), paragraphId: paragraph.id, paragraphVersion: paragraph.version,
          event: 'held', at: now, promptVersions: triagePromptVersions(version),
          reason: held.reason, concern: held.concern.concern, sourceAngle: held.concern.angle,
          modelOrder: held.modelOrder, itemIndex: held.concern.item });
      }
      for (const pick of selection.picked) {
        const source = input.items.find(value => value.lineageId === pick.item.lineageId &&
          value.version === pick.item.version);
        if (!source) throw new Error('Selected item unavailable.');
        const card: ThoughtCard = { id: id(), paragraphId: paragraph.id, paragraphVersion: paragraph.version,
          itemLineageId: source.lineageId, itemVersion: source.version, itemText: source.text, itemQuote: source.quote,
          itemKind: source.kind, triageVersion: version, profileRecordIds: pick.profileRecordIds,
          topics: source.topics, angle: pick.angle,
          sourceAngle: pick.concern.angle, concern: pick.concern.concern,
          score: pick.score, lessonId: pick.lessonId, brief: pick.brief, sessionId, questionStatus: 'marked',
          markAngleJobKey: job.key, createdAt: now };
        await tx.objectStore('cards').put(card);
        await tx.objectStore('dependencies').put({ consumerId: card.id, lineageId: card.itemLineageId,
          version: card.itemVersion });
        await tx.objectStore('funnel').put({ id: id(), paragraphId: paragraph.id, paragraphVersion: paragraph.version,
          event: 'picked', at: now, promptVersions: triagePromptVersions(version),
          angle: card.angle, sourceAngle: card.sourceAngle, score: card.score,
          modelOrder: pick.modelOrder, itemIndex: pick.concern.item, concern: pick.concern.concern,
          ...(card.lessonId ? { lessonId: card.lessonId } : {}), cardId: card.id, itemLineageId: card.itemLineageId,
          itemVersion: card.itemVersion });

      }
      await tx.objectStore('jobs').put({ ...current, status: 'done', measuredSource });
      await tx.done; return true;
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }
  async requestCheck(itemId: string, now = Date.now()): Promise<{ cardId?: string; reason?: string }> {
    const tx = this.db.transaction(['items', 'paragraphs', 'lineageVersions', 'jobs', 'cards', 'dependencies', 'meta'],
      'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const item = await tx.objectStore('items').get(itemId);
      const paragraphs = await tx.objectStore('paragraphs').getAll();
      const versions = await tx.objectStore('lineageVersions').getAll();
      const jobs = await tx.objectStore('jobs').getAll();
      const head = item?.lineageId && lineageHeads(versions).find(value => value.lineageId === item.lineageId);
      const paragraph = item && paragraphs.find(value => value.id === item.paragraphId);
      if (!item || !head || !paragraph || item.status !== 'current' || head.itemId !== item.id ||
          item.paragraphVersion !== paragraph.version ||
          lineageEligibility(head.lineageId, head.version, paragraphs, versions, jobs) !== 'eligible') {
        await tx.done; return { reason: 'Checking your latest change or the statement changed.' };
      }
      const cards = await tx.objectStore('cards').getAll();
      const existing = cards.find(card => card.itemLineageId === head.lineageId && card.itemVersion === head.version &&
        !card.supersededMark && card.questionStatus !== 'marked');
      if (existing) {
        if (existing.questionStatus === 'waiting' && existing.askedDirectly &&
            !jobs.some(job => job.cardId === existing.id && (job.status === 'pending' || job.status === 'running'))) {
          const previous = jobs.filter(job => job.cardId === existing.id && job.requested && job.step === 'angles');
          if (previous.some(job => job.status === 'superseded')) {
            const mode = (await tx.objectStore('meta').get('cloud-mode-consent'))?.value ? 'in_cloud' : 'on_device';
            await tx.objectStore('jobs').put({ ...previous[previous.length - 1], key: `${id()}#requested`,
              paragraphVersion: paragraph.version, status: 'pending',
            attempts: Math.max(...previous.map(j => j.attempts)),
              createdAt: now, nextRunAt: now, runMode: mode });
          }
        }
        await tx.done; return { cardId: existing.id };
      }
      const mark = cards.find(card => card.itemLineageId === head.lineageId && card.itemVersion === head.version &&
        card.questionStatus === 'marked' && !card.supersededMark);
      const validAngles = ['end-user', 'cost-at-scale', 'limits-operations', 'security-privacy', 'alternatives'];
      const fits = mark && typeof mark.concern === 'string' && !!mark.concern.trim() && !!mark.itemText &&
        !!mark.itemQuote && !!mark.sourceAngle && validAngles.includes(mark.sourceAngle) &&
        !(item.kind === 'decision' && mark.sourceAngle === 'alternatives');
      const mode = (await tx.objectStore('meta').get('cloud-mode-consent'))?.value ? 'in_cloud' : 'on_device';
      if (mark && fits) {
        const key = `${mark.markAngleJobKey ?? `${paragraph.id}@${paragraph.version}#check`}#question#${mark.id}`;
        if (!await tx.objectStore('jobs').get(key)) {
          await tx.objectStore('cards').put({ ...mark, questionStatus: 'waiting' });
          await tx.objectStore('jobs').put({ key, paragraphId: paragraph.id, paragraphVersion: paragraph.version,
            step: 'question', promptVersion: 'question.v2.1', cardId: mark.id, status: 'pending', attempts: 0,
            createdAt: now, nextRunAt: now, runMode: mode });
        }
        await tx.done; return { cardId: mark.id };
      }
      if (mark) await tx.objectStore('cards').put({ ...mark, supersededMark: true });
      const eligible = currentTriageItems(paragraph, [item], versions, 'v2.1').length > 0;
      const cardId = id();
      const card: ThoughtCard = { id: cardId, paragraphId: paragraph.id, paragraphVersion: paragraph.version,
        itemLineageId: head.lineageId, itemVersion: head.version, itemText: item.text, itemQuote: item.quote,
        itemKind: item.kind, triageVersion: 'v2.1', topics: item.topics, score: 0, lessonId: null, brief: false,
        sessionId: `requested-${cardId}`, questionStatus: eligible ? 'waiting' : 'ready', askedDirectly: true,
        ...(!eligible ? { noCheckable: true, draftQuestion: '' } : {}), createdAt: now };
      await tx.objectStore('cards').put(card);
      await tx.objectStore('dependencies').put({ consumerId: cardId, lineageId: head.lineageId,
        version: head.version });
      if (eligible) await tx.objectStore('jobs').put({ key: `${paragraph.id}@${paragraph.version}#requested#${cardId}`,
        paragraphId: paragraph.id, paragraphVersion: paragraph.version, step: 'angles', promptVersion: 'angles.v2.1',
        lineageId: head.lineageId, cardId, requested: true, status: 'pending', attempts: 0, createdAt: now,
        nextRunAt: now, runMode: mode });
      await tx.done; return { cardId };
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined); throw error;
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
    now = Date.now(), measuredSource?: 'on_device' | 'in_cloud'): Promise<boolean> {
    const tx = this.db.transaction(['jobs', 'paragraphs', 'cards', 'lineageVersions', 'privacy', 'outbox', 'funnel'],
      'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const [current, paragraph, card, versions, privacy] = await Promise.all([
        tx.objectStore('jobs').get(job.key), tx.objectStore('paragraphs').get(job.paragraphId),
        job.cardId ? tx.objectStore('cards').get(job.cardId) : Promise.resolve(undefined),
        tx.objectStore('lineageVersions').getAll(), tx.objectStore('privacy').get('never-send'),
      ]);
      if (current && current.attempts !== job.attempts) { await tx.done; return false; }
      const head = card && lineageHeads(versions).find(value => value.lineageId === card.itemLineageId);
      if (!current || current.step !== 'question' || current.status !== 'running' || !card || !paragraph ||
          paragraph.version !== job.paragraphVersion || !head || head.version !== card.itemVersion ||
          head.status === 'removed' || head.needsConfirmation || head.unchecked) {
        if (current?.status === 'running') await tx.objectStore('jobs').put({ ...current, status: 'superseded' });
        await tx.done; return false;
      }
      const terms = privacy?.terms ?? [];
      const leak = filterQuestion(question, terms);
      const eventBase = { paragraphId: paragraph.id, paragraphVersion: paragraph.version, at: now, cardId: card.id,
        promptVersions: { ...triagePromptVersions(card.triageVersion ?? 'v1'), question: job.promptVersion } };
      if (!passedAtGeneration || !leak.passed) {
        await tx.objectStore('cards').put({ ...card, questionStatus: 'blocked', questionReason: 'private detail' });
        await tx.objectStore('funnel').put({ ...eventBase, id: id(), event: 'question', reason: 'private detail' });
      } else {
        await tx.objectStore('cards').put({ ...card, questionStatus: 'ready', draftQuestion: question,
          questionPromptVersion: job.promptVersion,
          draftKeptOut: keptOut.filter(value => filterQuestion(value, terms).passed) });
        await tx.objectStore('funnel').put({ ...eventBase, id: id(), event: 'question', reason: 'passed' });
        const whyPromptVersion = triagePromptVersions(card.triageVersion ?? 'v1').whynote;
        if (!card.brief && !card.askedDirectly && whyPromptVersion) await tx.objectStore('jobs').put({
          key: `${job.key}#whynote`, paragraphId: paragraph.id, paragraphVersion: paragraph.version, step: 'whynote',
          promptVersion: whyPromptVersion, cardId: card.id, status: 'pending', attempts: 0, createdAt: now,
          nextRunAt: now, runMode: 'on_device' });
      }
      await tx.objectStore('jobs').put({ ...current, status: 'done', measuredSource });
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
      if (!card || (!card.draftQuestion && !outbox) || outbox?.status === 'withdrawn' || !paragraph ||
          paragraph.version !== job.paragraphVersion ||
          !head || head.version !== card.itemVersion || head.status === 'removed' || head.needsConfirmation ||
          head.unchecked) return null;
      return { card, question: card.draftQuestion ?? outbox!.question, profile };
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }
  async completeWhy(job: StoredJob, note: ThoughtCard['why'], supplied: ProfileRecord[],
    fingerprints: RecordFingerprint[], whyDropped = false): Promise<boolean> {
    const tx = this.db.transaction(['jobs', 'cards', 'paragraphs', 'lineageVersions', 'profile', 'funnel'],
      'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const [current, card, paragraph, versions] = await Promise.all([tx.objectStore('jobs').get(job.key),
        job.cardId ? tx.objectStore('cards').get(job.cardId) : Promise.resolve(undefined),
        tx.objectStore('paragraphs').get(job.paragraphId), tx.objectStore('lineageVersions').getAll()]);
      if (current && current.attempts !== job.attempts) { await tx.done; return false; }
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
        if (whyDropped && note) await tx.objectStore('funnel').put({ id: id(), paragraphId: paragraph.id,
          paragraphVersion: paragraph.version, event: 'why', at: Date.now(), cardId: card.id,
          reason: 'why dropped: unsupported claim', promptVersions: {
            ...triagePromptVersions(card.triageVersion ?? 'v1'),
            question: card.questionPromptVersion ?? triagePromptVersions(card.triageVersion ?? 'v1').question } });
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
  async funnel(): Promise<FunnelEvent[]> {
    return (await this.db.getAll('funnel')).map(event => ({ ...event,
      promptVersions: event.promptVersions ?? triagePromptVersions('v1') }));
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
  async loadSampleIfEmpty(text: string, now = Date.now(),
    capture?: (paragraphs: Paragraph[]) => void): Promise<boolean> {
    const tx = this.db.transaction(['paragraphs', 'paragraphVersions'], 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      if (await tx.objectStore('paragraphs').count()) { await tx.done; return false; }
      const inserted = matchParagraphs([], text, now, id);
      for (const paragraph of inserted) {
        await tx.objectStore('paragraphs').put(paragraph);
        await tx.objectStore('paragraphVersions').put(paragraph);
      }
      await tx.done; capture?.(inserted); return true;
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined); throw error;
    }
  }
  async saveNotebook(text: string, now = Date.now(),
    expected?: ReadonlyArray<Pick<Paragraph, 'id' | 'version'>>): Promise<Paragraph[]> {
    const tx = this.db.transaction(['paragraphs', 'paragraphVersions', 'items', 'jobs', 'lineageVersions', 'cards'],
      'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const store = tx.objectStore('paragraphs');
      const before = await store.getAll();
      if (expected && (before.length !== expected.length || !before.every(paragraph => expected.some(value =>
        value.id === paragraph.id && value.version === paragraph.version)))) throw new SampleChangedError();
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
          if ((!current || isHeadingBlock(current.text)) && job.requested && job.cardId) {
            const card = await tx.objectStore('cards').get(job.cardId);
            if (card?.questionStatus === 'waiting') await tx.objectStore('cards').put({ ...card,
              questionStatus: 'blocked', questionReason: 'stale' });
          }
          if (job.cardId && (job.step === 'question' || job.step === 'whynote')) {
            const card = await tx.objectStore('cards').get(job.cardId);
            if (current && !isHeadingBlock(current.text) && card) {
              await tx.objectStore('jobs').put({ ...job, key: `${job.key}#retarget@${current.version}`,
                paragraphVersion: current.version, status: 'pending', nextRunAt: now });
            } else if (card && job.step === 'question') {
              await tx.objectStore('cards').put({ ...card, questionStatus: 'blocked', questionReason: 'stale' });
            }
          }
        }
      }
      for (const card of await tx.objectStore('cards').getAll()) {
        const paragraph = byId.get(card.paragraphId);
        if (((!paragraph && card.askedDirectly) || (paragraph && isHeadingBlock(paragraph.text))) &&
            card.questionStatus === 'waiting') {
          await tx.objectStore('cards').put({ ...card, questionStatus: 'blocked', questionReason: 'stale' });
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
  async enqueueSettled(now: number, promptVersion: 'extract.v1' | 'extract.v2',
    _mode: 'on_device' | 'in_cloud' = 'on_device'): Promise<void> {
    const tx = this.db.transaction(['paragraphs', 'jobs', 'meta', 'cards'], 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const mode = (await tx.objectStore('meta').get('cloud-mode-consent'))?.value ? 'in_cloud' : 'on_device';
      const actualPrompt = mode === 'in_cloud' ? 'extract.v2' : promptVersion;
      const jobs = await tx.objectStore('jobs').getAll();
      const cards = await tx.objectStore('cards').getAll();
      for (const p of await tx.objectStore('paragraphs').getAll()) {
        if (isHeadingBlock(p.text)) {
          for (const job of jobs) if (job.paragraphId === p.id && job.step !== 'describe' &&
            (job.status === 'pending' || job.status === 'running')) {
            await tx.objectStore('jobs').put({ ...job, status: 'superseded' });
          }
          for (const card of cards) if (card.paragraphId === p.id && card.questionStatus === 'waiting') {
            await tx.objectStore('cards').put({ ...card, questionStatus: 'blocked', questionReason: 'stale' });
          }
          continue;
        }
        if (now - p.updatedAt < SETTLE_MS || !extractionEligible(p.text, mode, actualPrompt, MIN_WORDS)) continue;
        const key = jobKey(p.id, p.version);
        const existing = await tx.objectStore('jobs').get(key);
        if (!existing) {
          await tx.objectStore('jobs').put({ key, paragraphId: p.id, paragraphVersion: p.version,
            step: 'extract', promptVersion: actualPrompt, status: 'pending', attempts: 0, createdAt: now,
            nextRunAt: now, runMode: mode,
            cloudEligible: actualPrompt === 'extract.v2' && TRIAGE_PROMPT_SET === 'v2.1' &&
              wordCount(p.text) >= MIN_WORDS });
        } else if (mode === 'in_cloud' && existing.status === 'pending' && existing.runMode === 'on_device' &&
            existing.cloudEligible && existing.promptVersion === 'extract.v2' && wordCount(p.text) >= MIN_WORDS) {
          await tx.objectStore('jobs').put({ ...existing, runMode: 'in_cloud' });
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
    const tx = this.db.transaction(['jobs', 'comparisonBatches', 'cards', 'funnel', 'ideas', 'outbox', 'research',
      'paragraphs'], 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const receipts = await tx.objectStore('research').getAll();
      for (const idea of await tx.objectStore('ideas').getAll()) {
        const entry = idea.outboxId ? await tx.objectStore('outbox').get(idea.outboxId) : undefined;
        const receipt = entry && receipts.filter(value => value.entryId === entry.id)
          .sort((a, b) => b.sentAt - a.sentAt)[0];
        if (entry?.status === 'approved' && receipt?.status === 'completed' && idea.status !== 'sent') {
          await tx.objectStore('ideas').put({ ...idea, status: 'sent', updatedAt: Date.now() });
        }
      }
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
      const paragraphs = await tx.objectStore('paragraphs').getAll();
      for (const idea of await tx.objectStore('ideas').getAll()) {
        if (idea.describePromptVersion !== 'describe.v2') continue;
        const entry = idea.outboxId ? await tx.objectStore('outbox').get(idea.outboxId) : undefined;
        if (openingMatches(idea.openingBasis, paragraphs, true) &&
            (!entry || openingMatches(entry.openingBasis, paragraphs, true))) continue;
        const job = await tx.objectStore('jobs').get(idea.describeJobKey);
        if (job && (job.status === 'pending' || job.status === 'running')) {
          await tx.objectStore('jobs').put({ ...job, status: 'superseded', errorName: 'PlanChanged' });
        }
        if (entry?.status === 'approved') {
          await tx.objectStore('outbox').put({ ...entry, status: 'withdrawn', withdrawReason: 'stale',
            decidedAt: Date.now() });
          await tx.objectStore('ideas').put({ ...idea, status: 'withdrawn', updatedAt: Date.now() });
        }
      }
      await tx.done;
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }
  async claim(now: number, mode: 'on_device' | 'in_cloud' = 'on_device'):
    Promise<{ job: StoredJob; paragraph: Paragraph } | null> {
    const tx = this.db.transaction(['jobs', 'paragraphs', 'comparisonBatches', 'cards', 'funnel', 'lineageVersions',
      'meta'], 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const storedMode = (await tx.objectStore('meta').get('cloud-mode-consent'))?.value ? 'in_cloud' : 'on_device';
      if (mode !== storedMode) { await tx.done; return null; }
      const paragraphs = await tx.objectStore('paragraphs').getAll();
      const order = new Map(paragraphs.map(paragraph => [paragraph.id, paragraph.order]));
      const priority = (job: StoredJob) => job.requested || job.step === 'question' || job.step === 'describe' ? 0 : 1;
      const jobs = (await tx.objectStore('jobs').getAll()).filter(j => j.status === 'pending' && j.nextRunAt <= now)
        .sort((a, b) => {
          if (mode === 'in_cloud') return a.createdAt - b.createdAt || a.key.localeCompare(b.key);
          const p = priority(a) - priority(b);
          if (p) return p;
          if (priority(a) === 0) return a.createdAt - b.createdAt || a.key.localeCompare(b.key);
          // Selection uses session-wide angle counts, so automatic picks depend on this plan order.
          const paragraphOrder = (order.get(a.paragraphId) ?? Infinity) - (order.get(b.paragraphId) ?? Infinity);
          const step = (job: StoredJob) => job.step === 'extract' ? 0 : job.step === 'compare' ? 1 :
            job.step === 'angles' ? 2 : 3;
          return paragraphOrder || step(a) - step(b) || a.createdAt - b.createdAt || a.key.localeCompare(b.key);
        });
      for (const job of jobs) {
        if ((job.runMode ?? 'on_device') !== mode) continue;
        if (mode === 'in_cloud' && !((job.step === 'extract' && job.promptVersion === 'extract.v2') ||
            (job.step === 'compare' && job.promptVersion === 'compare.v1') ||
            (job.step === 'angles' && job.promptVersion === 'angles.v2.1') ||
            (job.step === 'question' && job.promptVersion === 'question.v2.1') ||
            (job.step === 'describe' && (job.promptVersion === 'describe.v1' ||
              job.promptVersion === 'describe.v2')))) continue;
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
        if (!paragraph || paragraph.version !== job.paragraphVersion ||
            (job.step !== 'describe' && isHeadingBlock(paragraph.text))) {
          await tx.objectStore('jobs').put({ ...job, status: 'superseded' });
          if (paragraph && paragraph.version === job.paragraphVersion && isHeadingBlock(paragraph.text) &&
              (job.step === 'question' || (job.step === 'angles' && job.requested)) && job.cardId) {
            const card = await tx.objectStore('cards').get(job.cardId);
            if (card?.questionStatus === 'waiting') await tx.objectStore('cards').put({ ...card,
              questionStatus: 'blocked', questionReason: 'stale' });
          }
          continue;
        }
        if (mode === 'in_cloud' && job.step === 'extract' && wordCount(paragraph.text) < MIN_WORDS) {
          await tx.objectStore('jobs').put({ ...job, runMode: 'on_device', cloudEligible: false });
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
        const claimed: StoredJob = { ...job, status: 'running', attempts: job.attempts + 1, runMode: mode };
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
    now = Date.now(), measuredSource?: 'on_device' | 'in_cloud'): Promise<boolean> {
    const tx = this.db.transaction(['jobs', 'paragraphs', 'items', 'lineageVersions', 'comparisonBatches'],
      'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const currentJob = await tx.objectStore('jobs').get(job.key);
      const paragraph = await tx.objectStore('paragraphs').get(job.paragraphId);
      if (currentJob && currentJob.attempts !== job.attempts) { await tx.done; return false; }
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
            attempts: 0, createdAt: now, nextRunAt: now, runMode: job.runMode ?? 'on_device' });
        }
      }
      await tx.objectStore('comparisonBatches').put({ key: batchKey(paragraph.id, paragraph.version),
        paragraphId: paragraph.id, paragraphVersion: paragraph.version, old: previous, items, decisions });
      await tx.objectStore('jobs').put({ ...currentJob, status: 'done', measuredSource });
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
    const tx = this.db.transaction(['comparisonBatches', 'paragraphs', 'items', 'lineageVersions', 'cards',
      'jobs', 'meta'], 'readwrite');
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
      const versions = await tx.objectStore('lineageVersions').getAll();
      const jobs = await tx.objectStore('jobs').getAll();
      const mode = (await tx.objectStore('meta').get('cloud-mode-consent'))?.value ? 'in_cloud' : 'on_device';
      for (const card of cards.filter(value => value.paragraphId === paragraph.id && value.askedDirectly &&
        value.questionStatus === 'waiting')) {
        const previous = jobs.filter(job => job.cardId === card.id && job.requested && job.step === 'angles');
        if (!previous.some(job => job.status === 'superseded') || jobs.some(job => job.cardId === card.id &&
            (job.status === 'pending' || job.status === 'running'))) continue;
        const eligibility = lineageEligibility(card.itemLineageId, card.itemVersion, [paragraph], versions, jobs);
        if (eligibility === 'stale' || eligibility === 'terminal') {
          await tx.objectStore('cards').put({ ...card, questionStatus: 'blocked', questionReason: 'stale' });
        } else if (eligibility === 'eligible') {
          const now = Date.now();
          await tx.objectStore('jobs').put({ ...previous[previous.length - 1], key: `${id()}#requested`,
            paragraphVersion: paragraph.version, status: 'pending',
            attempts: Math.max(...previous.map(j => j.attempts)),
            createdAt: now, nextRunAt: now, runMode: mode });
        }
      }
      await tx.done;
      return true;
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }
  async supersedeJob(job: StoredJob): Promise<void> {
    const tx = this.db.transaction(['jobs', 'cards'], 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const current = await tx.objectStore('jobs').get(job.key);
      if (current?.status === 'running' && current.attempts === job.attempts) {
        await tx.objectStore('jobs').put({ ...current, status: 'superseded' });
        if (current.requested && current.cardId) {
          const card = await tx.objectStore('cards').get(current.cardId);
          if (card?.questionStatus === 'waiting') await tx.objectStore('cards').put({ ...card,
            questionStatus: 'blocked', questionReason: 'stale' });
        }
      }
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
      if (current && current.attempts !== job.attempts) { await tx.done; return false; }
      if (!current || current.status !== 'running' || current.step !== 'compare' || !current.lineageId ||
          !paragraph || paragraph.version !== job.paragraphVersion || !batch) {
        if (current?.status === 'running') await tx.objectStore('jobs').put({ ...current, status: 'superseded' });
        await tx.done;
        return false;
      }
      batch.decisions[current.lineageId] = { status: result.status, newQuote: result.newQuote,
        newQuoteFound: result.newQuoteFound, needsConfirmation: result.needsConfirmation };
      await tx.objectStore('comparisonBatches').put(batch);
      await tx.objectStore('jobs').put({ ...current, status: 'done',
        ...(result.source === 'code' ? {} : { measuredSource: result.source }) });
      await tx.done;
      return true;
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }
  async fail(job: StoredJob, errorName: string, cancelled: boolean, now = Date.now(), fatal = false,
    dispatched = false, modelQuota = false): Promise<void> {
    const tx = this.db.transaction(['jobs', 'paragraphs', 'comparisonBatches', 'lineageVersions', 'cards', 'funnel',
      'outbox'], 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const current = await tx.objectStore('jobs').get(job.key);
      const paragraph = await tx.objectStore('paragraphs').get(job.paragraphId);
      if (current?.status === 'running' && current.attempts === job.attempts) {
        if (!paragraph || paragraph.version !== job.paragraphVersion) {
          await tx.objectStore('jobs').put({ ...current, status: 'superseded' });
        } else if (cancelled && !dispatched) {
          await tx.objectStore('jobs').put({ ...current, status: 'pending',
            attempts: Math.max(0, current.attempts - 1) });
        } else {
          const terminal = fatal || current.attempts >= MAX_ATTEMPTS;
          const safeName = safeErrorName({ name: errorName });
          await tx.objectStore('jobs').put({ ...current, errorName: safeName,
            ...(modelQuota ? { failureReason: 'model-input-quota' as const } : {}),
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
  async approveIdea(ideaId: string, finalText: string, now = Date.now()):
    Promise<{ entryId?: string; reason?: string }> {
    const tx = this.db.transaction(['ideas', 'outbox', 'privacy', 'lineageVersions', 'paragraphs', 'jobs'],
      'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const idea = await tx.objectStore('ideas').get(ideaId);
      if (!idea || idea.status !== 'ready' || idea.outboxId || !Array.isArray(idea.basis) ||
          idea.basis.length < 3 || idea.basis.length > 12 ||
          (await tx.objectStore('jobs').get(idea.describeJobKey))?.status !== 'done') {
        await tx.done; return { reason: 'This idea was already approved or is not ready.' };
      }
      const [paragraphs, versions, jobs, privacy] = await Promise.all([tx.objectStore('paragraphs').getAll(),
        tx.objectStore('lineageVersions').getAll(), tx.objectStore('jobs').getAll(),
        tx.objectStore('privacy').get('never-send')]);
      const statuses = idea.basis.map(value => lineageEligibility(value.lineageId, value.version,
        paragraphs, versions, jobs));
      if (!openingMatches(idea.openingBasis, paragraphs, idea.describePromptVersion === 'describe.v2')) {
        await tx.done; return { reason: 'Your plan changed. Draft again.' };
      }
      if (statuses.some(status => status !== 'eligible')) {
        await tx.done; return { reason: statuses.some(status => status === 'stale' || status === 'terminal')
          ? 'Your plan changed. Draft again.' : 'Checking your latest change…' };
      }
      if (!finalText.trim()) { await tx.done; return { reason: 'Write a description before sending.' }; }
      const terms = privacy?.terms ?? [];
      const leak = filterQuestion(finalText, terms);
      if (!leak.passed) {
        const names = { currency: 'money amount', email: 'email address', url: 'web address',
          'listed-term': 'never-send term', 'private-token': 'private token' };
        await tx.done;
        return { reason: `Description held back: ${leak.reasons.map(reason => names[reason]).join(', ')}.` };
      }
      const entryId = id();
      const keptOut = idea.keptOut.filter(value => filterQuestion(value, terms).passed);
      const edited = finalText !== idea.draft;
      await tx.objectStore('outbox').put({ id: entryId, kind: 'idea', ideaId, question: finalText, keptOut,
        basis: idea.basis, ...(idea.openingBasis ? { openingBasis: idea.openingBasis } : {}),
        status: 'approved', createdAt: now, decidedAt: now, edited,
        describePromptVersion: idea.describePromptVersion, researchPromptVersion: idea.researchPromptVersion });
      await tx.objectStore('ideas').put({ ...idea, status: 'approved', finalText, edited, keptOut,
        outboxId: entryId, updatedAt: now });
      await tx.done; return { entryId };
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined); throw error;
    }
  }
  async finishIdeaResearch(ideaId: string, status: 'sent' | 'failed', now = Date.now()): Promise<void> {
    const tx = this.db.transaction(['ideas', 'outbox'], 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const idea = await tx.objectStore('ideas').get(ideaId);
      const entry = idea?.outboxId ? await tx.objectStore('outbox').get(idea.outboxId) : undefined;
      if (idea && entry?.status === 'approved') {
        await tx.objectStore('ideas').put({ ...idea, status, updatedAt: now });
      }
      await tx.done;
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined); throw error;
    }
  }
  async declineIdea(ideaId: string, now = Date.now()): Promise<boolean> {
    const tx = this.db.transaction(['ideas', 'funnel', 'jobs'], 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const idea = await tx.objectStore('ideas').get(ideaId);
      if (!idea || idea.status !== 'ready' ||
          (await tx.objectStore('jobs').get(idea.describeJobKey))?.status !== 'done') {
        await tx.done; return false;
      }
      await tx.objectStore('ideas').put({ ...idea, status: 'declined', updatedAt: now });
      await tx.objectStore('funnel').put({ id: id(), paragraphId: 'idea', paragraphVersion: 0,
        event: 'outbox', at: now, reason: 'idea-rejected' });
      await tx.done; return true;
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined); throw error;
    }
  }
  async preSendIdeaCheck(ideaId: string, grant?: { entryId: string; text: string }):
    Promise<{ allowed: boolean; reason: string | null }> {
    const tx = this.db.transaction(['ideas', 'outbox', 'privacy', 'meta', 'lineageVersions', 'paragraphs', 'jobs'],
      'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const idea = await tx.objectStore('ideas').get(ideaId);
      const entry = idea?.outboxId ? await tx.objectStore('outbox').get(idea.outboxId) : undefined;
      if (!idea || !['approved', 'sent', 'failed'].includes(idea.status) || !Array.isArray(idea.basis) ||
          idea.basis.length < 3 || idea.basis.length > 12 || !entry || entry.kind !== 'idea' ||
          entry.status !== 'approved' || (grant && (entry.id !== grant.entryId || entry.question !== grant.text ||
            idea.finalText !== grant.text))) {
        await tx.done; return { allowed: false, reason: 'not-approved' };
      }
      const [paragraphs, versions, jobs, terms, consent] = await Promise.all([tx.objectStore('paragraphs').getAll(),
        tx.objectStore('lineageVersions').getAll(), tx.objectStore('jobs').getAll(),
        tx.objectStore('privacy').get('never-send'), tx.objectStore('meta').get('cloud-consent')]);
      const statuses = idea.basis.map(value => lineageEligibility(value.lineageId, value.version,
        paragraphs, versions, jobs));
      const stale = !openingMatches(idea.openingBasis, paragraphs, idea.describePromptVersion === 'describe.v2') ||
        !openingMatches(entry.openingBasis, paragraphs, idea.describePromptVersion === 'describe.v2') ||
        statuses.some(status => status === 'stale' || status === 'terminal');
      if (!stale && statuses.some(status => status === 'checking')) {
        await tx.done; return { allowed: false, reason: 'not-eligible-yet' };
      }
      const checks = [entry.question, ...entry.keptOut].map(value => filterQuestion(value, terms?.terms ?? []));
      const unsafe = checks.some(value => !value.passed);
      if (stale || unsafe) {
        const reason = stale ? 'stale' : checks.some(value => value.reasons.includes('listed-term'))
          ? 'listed-term' : 'private-detail';
        await tx.objectStore('outbox').put({ ...entry, status: 'withdrawn', withdrawReason: reason,
          decidedAt: Date.now() });
        await tx.objectStore('ideas').put({ ...idea, status: 'withdrawn', updatedAt: Date.now() });
        await tx.done; return { allowed: false, reason };
      }
      if (grant) await tx.objectStore('meta').put({ key: 'cloud-consent', value: true });
      await tx.done;
      return { allowed: !!grant || consent?.value === true, reason: grant || consent?.value ? null : 'no-consent' };
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined); throw error;
    }
  }
  async approveDraft(cardId: string, finalText: string, privateTokens: string[] = [], now = Date.now()):
    Promise<{ entryId?: string; reason?: string }> {
    const tx = this.db.transaction(['cards', 'outbox', 'privacy', 'lineageVersions', 'paragraphs', 'jobs', 'funnel'],
      'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const card = await tx.objectStore('cards').get(cardId);
      if (!card || card.questionStatus !== 'ready' || card.outboxId) {
        await tx.done; return { reason: 'This card was already approved or is not ready.' };
      }
      const status = lineageEligibility(card.itemLineageId, card.itemVersion,
        await tx.objectStore('paragraphs').getAll(), await tx.objectStore('lineageVersions').getAll(),
        await tx.objectStore('jobs').getAll());
      if (status !== 'eligible') {
        await tx.done; return { reason: status === 'checking' ? 'Checking your latest change…'
          : 'Your plan changed. Check again.' };
      }
      if (!finalText.trim()) { await tx.done; return { reason: 'Write a question before sending.' }; }
      const terms = (await tx.objectStore('privacy').get('never-send'))?.terms ?? [];
      const leak = filterQuestion(finalText, terms, privateTokens);
      if (!leak.passed) {
        const names = { currency: 'money amount', email: 'email address', url: 'web address',
          'listed-term': 'never-send term', 'private-token': 'private token' };
        await tx.done;
        return { reason: `Question held back: ${leak.reasons.map(reason => names[reason]).join(', ')}.` };
      }
      const entryId = id();
      const keptOut = (card.draftKeptOut ?? []).filter(value => filterQuestion(value, terms, privateTokens).passed);
      await tx.objectStore('outbox').put({ id: entryId, question: finalText, keptOut, cardId: card.id,
        itemLineageId: card.itemLineageId, itemVersion: card.itemVersion, status: 'approved', createdAt: now,
        decidedAt: now, edited: finalText !== (card.draftQuestion ?? ''), triageVersion: card.triageVersion,
        questionPromptVersion: card.questionPromptVersion, questionOrigin: card.noCheckable ? 'manual' : 'model' });
      await tx.objectStore('cards').put({ ...card, outboxId: entryId });
      await tx.objectStore('funnel').put(outboxEvent(card, 'approved', now));
      await tx.done; return { entryId };
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined); throw error;
    }
  }
  async declineDraft(cardId: string, now = Date.now()): Promise<boolean> {
    const tx = this.db.transaction(['cards', 'funnel'], 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const card = await tx.objectStore('cards').get(cardId);
      if (!card || card.questionStatus !== 'ready' || card.outboxId) { await tx.done; return false; }
      await tx.objectStore('cards').put({ ...card, questionStatus: 'declined' });
      await tx.objectStore('funnel').put(outboxEvent(card, 'rejected', now));
      await tx.done; return true;
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined); throw error;
    }
  }
  async reopenDraft(cardId: string): Promise<boolean> {
    const tx = this.db.transaction('cards', 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const card = await tx.store.get(cardId);
      if (!card || card.questionStatus !== 'declined' || card.outboxId) { await tx.done; return false; }
      await tx.store.put({ ...card, questionStatus: 'ready' });
      await tx.done; return true;
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished or aborted. */ }
      await tx.done.catch(() => undefined); throw error;
    }
  }
  async decideOutbox(entryId: string, decision: 'approved' | 'rejected'): Promise<boolean> {
    const tx = this.db.transaction(['outbox', 'privacy', 'lineageVersions', 'cards', 'funnel', 'paragraphs', 'jobs'],
      'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const entry = await tx.objectStore('outbox').get(entryId);
      if (!entry || entry.kind === 'idea' || !entry.cardId || !entry.itemLineageId || entry.itemVersion === undefined ||
          entry.status !== 'pending') { await tx.done; return false; }
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
  async preSendCheck(entryId: string, grantText?: string): Promise<{ allowed: boolean; reason: string | null }> {
    const tx = this.db.transaction(['outbox', 'privacy', 'lineageVersions', 'cards', 'funnel', 'paragraphs', 'jobs',
      'meta'], 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const entry = await tx.objectStore('outbox').get(entryId);
      if (!entry || entry.kind === 'idea' || !entry.cardId || !entry.itemLineageId || entry.itemVersion === undefined ||
          entry.status !== 'approved' || (grantText !== undefined && entry.question !== grantText)) {
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
      if (grantText !== undefined) await tx.objectStore('meta').put({ key: 'cloud-consent', value: true });
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
        if (entry.kind === 'idea' || !entry.itemLineageId || entry.itemVersion === undefined ||
            entry.status !== 'pending' ||
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
        paragraphVersion: card.paragraphVersion, event: 'feedback', at: now, reason: feedback, cardId,
        promptVersions: triagePromptVersions(card.triageVersion ?? 'v1') });
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
        const card = entry.cardId ? await tx.objectStore('cards').get(entry.cardId) : undefined;
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
          const card = entry.cardId ? await tx.objectStore('cards').get(entry.cardId) : undefined;
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
      'lineageVersions', 'dependencies', 'comparisonBatches', 'privacy', 'cards', 'funnel', 'anglesConsidered',
      'research', 'cloudProcessing', 'ideas'],
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
      if (oldVersion < 7) database.createObjectStore('ideas', { keyPath: 'id' });
      if (oldVersion < 6) database.createObjectStore('cloudProcessing', { autoIncrement: true });
      if (oldVersion < 5) database.createObjectStore('research', { autoIncrement: true });
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
              for (const item of currentTriageItems(paragraph, items, versions, 'v1')) {
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
