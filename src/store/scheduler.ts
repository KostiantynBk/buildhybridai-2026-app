import { LocalError, type Job } from '../ai/localModel';
import { CloudProcessingError, StorageQuotaError } from '../ai/cloudProcessing';
import { safeErrorName } from '../ai/errorMetadata';
import { extractStructured, type ExtractVersion } from '../pipeline/extract';
import { extractionUnits, isHeadingBlock } from '../structure/planStructure';
import { compare } from '../pipeline/compare';
import { describeIdea } from '../pipeline/describeIdea';
import { chooseProfileRecords, runAngles, runQuestion, runWhyNote } from '../pipeline/triage';
import { fingerprintRecords } from './fingerprint';
import { versionFromPrompt } from '../pipeline/triageVersion';
import { type LocalStore, type StoredJob } from './index';
import { matchParagraphs, type Paragraph } from './matcher';

export interface LocalService {
  state: { kind: string };
  subscribe(listener: () => void): () => void;
  isReadyFor?(mode: 'on_device' | 'in_cloud'): Promise<boolean>;
  isGeneratingFor?(mode: 'on_device' | 'in_cloud'): boolean;
  runLocal<T>(job: Job<T>): Promise<{ data: T; latencyMs: number; source: string; raw: string }>;
}
export class Scheduler {
  private stopped = true;
  private busy = false;
  private paused = false;
  private blocked = false;
  private storageBlocked = false;
  private resumeNeeded = false;
  private storageRecovery?: { job: StoredJob; name: string; cancelled: boolean; fatal: boolean;
    dispatched: boolean; modelQuota: boolean };
  private generation = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubscribe: (() => void) | undefined;
  private active: AbortController | undefined;
  private activeJob: { job: StoredJob; paragraph: Paragraph } | undefined;
  private idleController: AbortController | undefined;
  private wakeAfterBusy = false;
  private readonly sessionId = crypto.randomUUID();
  constructor(private readonly store: LocalStore, private readonly service: LocalService,
    private readonly version: () => ExtractVersion, private readonly changed: () => void,
    private readonly now: () => number = Date.now, private readonly failed: (error?: unknown) => void = () => {},
    private readonly idle?: (store: LocalStore, service: LocalService, signal: AbortSignal,
      version: () => ExtractVersion, now: () => number) => Promise<void>) {}
  async start(): Promise<void> {
    this.stopped = false;
    try {
      await this.store.resume();
    } catch (error) {
      if (safeErrorName(error) !== 'QuotaExceededError') throw error;
      this.resumeNeeded = true;
      this.storageFailure(error);
    } finally {
      if (!this.stopped) {
        this.unsubscribe = this.service.subscribe(() => { void this.tick(); });
        this.timer = setInterval(() => { void this.tick(); }, 1000);
      }
    }
    if (!this.stopped) await this.tick();
  }
  storagePaused(): boolean { return this.storageBlocked; }
  private storageFailure(error: unknown): void {
    this.storageBlocked = true;
    this.failed(error);
  }
  ownedClaim(): StoredJob | undefined {
    return !this.stopped && !this.active?.signal.aborted ? this.activeJob?.job : undefined;
  }
  activeClaim(): StoredJob | undefined {
    const job = this.ownedClaim();
    return job && (this.service.isGeneratingFor?.(job.runMode ?? 'on_device') ?? true) ? job : undefined;
  }
  stop(): void {
    this.stopped = true;
    this.generation++;
    this.active?.abort(); this.idleController?.abort();
    if (this.timer) clearInterval(this.timer);
    this.unsubscribe?.();
  }
  modeChanged(): void { this.generation++; this.blocked = false; this.active?.abort(); this.interruptIdle(); }
  interruptIdle(): void { this.idleController?.abort(); }
  private async resumeClaimsAfterIdle(): Promise<void> {
    if (this.stopped) return;
    try {
      const snapshot = await this.store.snapshot();
      if (this.stopped || !snapshot.jobs.some(job => job.status === 'pending' && job.nextRunAt <= this.now())) return;
      if (this.busy) this.wakeAfterBusy = true;
      else void this.tick();
    } catch (error) { if (!this.stopped) this.failed(error); }
  }
  edited(nextText?: string, previous?: Paragraph[]): void {
    this.paused = true;
    this.interruptIdle();
    let unchangedCompare = false;
    if (nextText !== undefined && previous && this.activeJob?.job.step === 'compare') {
      const { job, paragraph } = this.activeJob;
      const original = previous.find(value => value.id === job.paragraphId);
      if (original?.version === job.paragraphVersion && original.text === paragraph.text) {
        let sequence = 0;
        const matched = matchParagraphs(previous, nextText, 0, () => `__unsaved_new_${sequence++}`)
          .find(value => value.id === job.paragraphId);
        unchangedCompare = matched?.version === job.paragraphVersion && matched.text === paragraph.text;
      }
    }
    if (!unchangedCompare) {
      this.generation++;
      this.active?.abort();
    }
  }
  saved(): void {
    this.storageBlocked = false;
    this.paused = false;
    void this.tick();
  }
  async tick(): Promise<void> {
    if (this.busy || this.stopped || this.paused || this.storageBlocked) return;
    this.busy = true;
    const generation = this.generation;
    try {
      if (this.resumeNeeded) {
        await this.store.resume();
        this.resumeNeeded = false;
      }
      if (this.storageRecovery) {
        const retry = this.storageRecovery;
        await this.store.fail(retry.job, retry.name, retry.cancelled, this.now(), retry.fatal,
          retry.dispatched, retry.modelQuota);
        this.storageRecovery = undefined;
      }
      const mode = await this.store.cloudModeConsent() ? 'in_cloud' : 'on_device';
      await this.store.finalizeReady();
      await this.store.reconcileOutbox();
      await this.store.reconcileWhyNotes();
      await this.store.enqueueSettled(this.now(), mode === 'in_cloud' ? 'extract.v2' : this.version(), mode);
      await this.store.enqueueAngles(this.now(), mode);
      const ready = this.service.isReadyFor ? await this.service.isReadyFor(mode) : this.service.state.kind === 'ready';
      if (this.stopped || this.paused || this.blocked || !ready || generation !== this.generation) return;
      // A pick retains the claim slot: durable jobs may enqueue but cannot accrue attempts behind it.
      if (this.idleController) return;
      const claimed = await this.store.claim(this.now(), mode);
      if (!claimed) {
        const foreground = typeof document === 'undefined' || document.visibilityState === 'visible';
        if (mode === 'on_device' && this.idle && !this.idleController && foreground &&
            !this.stopped && !this.paused && generation === this.generation) {
          const controller = new AbortController();
          this.idleController = controller;
          void this.idle(this.store, this.service, controller.signal, this.version, this.now).catch(() => undefined)
            .finally(() => {
              if (this.idleController === controller) this.idleController = undefined;
              this.changed();
              void this.resumeClaimsAfterIdle();
            });
        }
        return;
      }
      this.interruptIdle();
      if (claimed.job.step === 'extract' && isHeadingBlock(claimed.paragraph.text)) {
        await this.store.supersedeJob(claimed.job);
        return;
      }
      const controller = new AbortController();
      const rowBatch = mode === 'on_device' && claimed.job.step === 'extract' &&
        claimed.job.promptVersion === 'extract.v2' && extractionUnits(claimed.paragraph.text).length > 1;
      const onVisibilityChange = () => {
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') controller.abort();
      };
      if (rowBatch && typeof document !== 'undefined') {
        document.addEventListener?.('visibilitychange', onVisibilityChange);
        onVisibilityChange();
      }
      let dispatched = false;
      this.active = controller;
      this.activeJob = claimed;
      this.changed();
      if (this.stopped || generation !== this.generation) controller.abort();
      let inferenceError: unknown;
      try {
        const run = async <T,>(job: Job<T>) => {
          try { return await this.service.runLocal({ ...job, requiredMode: mode }); }
          catch (error) { inferenceError = error; throw error; }
        };
        if (controller.signal.aborted) throw new LocalError('cancelled', 'Cancelled before dispatch.');
        if (claimed.job.step === 'extract') {
          if (claimed.job.promptVersion !== 'extract.v1' && claimed.job.promptVersion !== 'extract.v2') {
            throw new Error('Invalid extract prompt version.');
          }
          const result = await extractStructured(run, 'My plan', claimed.paragraph.text,
            controller.signal, claimed.job.promptVersion, mode === 'on_device');
          if (rowBatch) onVisibilityChange();
          if (this.stopped || controller.signal.aborted || generation !== this.generation) {
            await this.store.fail(claimed.job, 'AbortError', true, this.now());
          } else {
            await this.store.complete(claimed.job, result.items, this.now(),
              result.source === mode ? mode : undefined);
          }
        } else if (claimed.job.step === 'compare') {
          const prior = await this.store.comparisonInput(claimed.job);
          if (!prior) throw new Error('Comparison input unavailable.');
          if (controller.signal.aborted || generation !== this.generation) {
            throw new LocalError('cancelled', 'Cancelled before dispatch.');
          }
          const result = await compare(run, prior.item, claimed.paragraph.text,
            controller.signal, () => { dispatched = true; }, mode);
          if (this.stopped || controller.signal.aborted || generation !== this.generation) {
            await this.store.fail(claimed.job, 'AbortError', true, this.now(), false, dispatched);
          } else {
            await this.store.completeComparison(claimed.job, result);
          }
        } else if (claimed.job.step === 'angles') {
          const input = await this.store.anglesInput(claimed.job);
          if (!input) { await this.store.supersedeJob(claimed.job); return; }
          const result = await runAngles(run, input.paragraph, input.items,
            controller.signal, () => { dispatched = true; }, versionFromPrompt(claimed.job.promptVersion), mode);
          if (this.stopped || controller.signal.aborted || generation !== this.generation) {
            await this.store.fail(claimed.job, 'AbortError', true, this.now(), false, dispatched);
          } else {
            await this.store.completeAngles(claimed.job, input, result.concerns, this.sessionId, this.now(),
              result.source === mode ? mode : undefined);
          }
        } else if (claimed.job.step === 'question') {
          const input = await this.store.questionInput(claimed.job);
          if (!input) { await this.store.supersedeJob(claimed.job); return; }
          const card = input.card;
          if (!card.sourceAngle || !card.concern) throw new Error('Question concern is unavailable.');
          const result = await runQuestion(run,
            { text: card.itemText, quote: card.itemQuote }, card.sourceAngle, card.concern, input.neverSend, [],
            controller.signal, () => { dispatched = true; }, versionFromPrompt(claimed.job.promptVersion), mode);
          if (this.stopped || controller.signal.aborted || generation !== this.generation) {
            await this.store.fail(claimed.job, 'AbortError', true, this.now(), false, dispatched);
          } else {
            await this.store.completeQuestion(claimed.job, result.question, result.keptOut, result.leak.passed,
              this.now(), result.source === mode ? mode : undefined);
          }
        } else if (claimed.job.step === 'describe') {
          const idea = await this.store.ideaForJob(claimed.job);
          if (!idea) return;
          const result = await describeIdea(run, idea.statements, mode, controller.signal,
            () => { dispatched = true; }, idea.openingText, idea.describePromptVersion);
          if (this.stopped || controller.signal.aborted || generation !== this.generation) {
            await this.store.fail(claimed.job, 'AbortError', true, this.now(), false, dispatched);
          } else {
            await this.store.finishIdeaDraft(claimed.job, result.description, result.keptOut, this.now());
          }
        } else if (claimed.job.step === 'whynote') {
          const input = await this.store.whyInput(claimed.job);
          if (!input) { await this.store.supersedeJob(claimed.job); return; }
          const card = input.card;
          if (!card.angle || !card.concern) throw new Error('Legacy why-note concern is unavailable.');
          const supplied = chooseProfileRecords(card.topics, input.profile,
            card.angle === 'track-record' ? card.lessonId : undefined);
          const fingerprints = await fingerprintRecords(supplied);
          const result = await runWhyNote(run, card.itemQuote, card.angle,
            card.concern, input.question, card.topics, supplied, controller.signal, card.lessonId,
            () => { dispatched = true; }, card.itemKind ?? 'assumption',
            versionFromPrompt(claimed.job.promptVersion));
          if (this.stopped || controller.signal.aborted || generation !== this.generation) {
            await this.store.fail(claimed.job, 'AbortError', true, this.now(), false, dispatched);
          } else {
            await this.store.completeWhy(claimed.job, result.note, supplied, fingerprints, result.whyDropped);
          }
        } else {
          throw new Error('Unsupported job step.');
        }
        await this.store.finalizeReady();
        await this.store.reconcileOutbox();
      } catch (error) {
        const timeout = error instanceof LocalError && error.code === 'timeout';
        const cancelled = !timeout && (controller.signal.aborted ||
          (error instanceof LocalError && error.code === 'cancelled') ||
          (error instanceof CloudProcessingError && error.deferred));
        const name = error instanceof LocalError && error.diagnostics?.errorName
          ? safeErrorName({ name: error.diagnostics.errorName }) : safeErrorName(error);
        const modelQuota = mode === 'on_device' && error === inferenceError &&
          error instanceof LocalError && error.code === 'model-quota';
        const fatal = modelQuota || (error instanceof LocalError &&
          ['privacy-fault', 'not-configured', 'unsupported'].includes(error.code)) ||
          (error instanceof CloudProcessingError && !error.deferred);
        if (error instanceof LocalError && error.code === 'privacy-fault') this.blocked = true;
        if (error instanceof StorageQuotaError || (error !== inferenceError && !(error instanceof LocalError) &&
            safeErrorName(error) === 'QuotaExceededError')) {
          this.storageFailure(error);
        }
        const wasDispatched = claimed.job.step !== 'extract' && dispatched;
        this.storageRecovery = { job: claimed.job, name, cancelled, fatal, dispatched: wasDispatched, modelQuota };
        await this.store.fail(claimed.job, name, cancelled, this.now(), fatal, wasDispatched, modelQuota);
        this.storageRecovery = undefined;
        if (!this.storageBlocked) {
          await this.store.finalizeReady();
          await this.store.reconcileOutbox();
        }
      } finally {
        if (rowBatch && typeof document !== 'undefined') {
          document.removeEventListener?.('visibilitychange', onVisibilityChange);
        }
        if (this.active === controller) { this.active = undefined; this.activeJob = undefined; }
      }
    } catch (error) {
      if (safeErrorName(error) === 'QuotaExceededError') this.storageFailure(error);
      else this.failed(error);
    } finally {
      this.busy = false;
      this.changed();
      if (this.wakeAfterBusy) { this.wakeAfterBusy = false; queueMicrotask(() => { void this.tick(); }); }
    }
  }
}
