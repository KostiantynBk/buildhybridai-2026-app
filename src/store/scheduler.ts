import { LocalError, type Job } from '../ai/localModel';
import { CloudProcessingError } from '../ai/cloudProcessing';
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
  runLocal<T>(job: Job<T>): Promise<{ data: T; latencyMs: number; source: string; raw: string }>;
}
export class Scheduler {
  private stopped = true;
  private busy = false;
  private paused = false;
  private blocked = false;
  private generation = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubscribe: (() => void) | undefined;
  private active: AbortController | undefined;
  private activeJob: { job: StoredJob; paragraph: Paragraph } | undefined;
  private readonly sessionId = crypto.randomUUID();
  constructor(private readonly store: LocalStore, private readonly service: LocalService,
    private readonly version: () => ExtractVersion, private readonly changed: () => void,
    private readonly now: () => number = Date.now, private readonly failed: () => void = () => {}) {}
  async start(): Promise<void> {
    this.stopped = false;
    await this.store.resume();
    if (this.stopped) return;
    this.unsubscribe = this.service.subscribe(() => { void this.tick(); });
    this.timer = setInterval(() => { void this.tick(); }, 1000);
    await this.tick();
  }
  stop(): void {
    this.stopped = true;
    this.generation++;
    this.active?.abort();
    if (this.timer) clearInterval(this.timer);
    this.unsubscribe?.();
  }
  modeChanged(): void { this.generation++; this.blocked = false; this.active?.abort(); }
  edited(nextText?: string, previous?: Paragraph[]): void {
    this.paused = true;
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
    this.paused = false;
    void this.tick();
  }
  async tick(): Promise<void> {
    if (this.busy || this.stopped || this.paused) return;
    this.busy = true;
    const generation = this.generation;
    try {
      const mode = await this.store.cloudModeConsent() ? 'in_cloud' : 'on_device';
      await this.store.finalizeReady();
      await this.store.reconcileOutbox();
      await this.store.reconcileWhyNotes();
      await this.store.enqueueSettled(this.now(), mode === 'in_cloud' ? 'extract.v2' : this.version(), mode);
      await this.store.enqueueAngles(this.now(), mode);
      const ready = this.service.isReadyFor ? await this.service.isReadyFor(mode) : this.service.state.kind === 'ready';
      if (this.stopped || this.paused || this.blocked || !ready || generation !== this.generation) return;
      const claimed = await this.store.claim(this.now(), mode);
      if (!claimed) return;
      if (claimed.job.step === 'extract' && isHeadingBlock(claimed.paragraph.text)) {
        await this.store.supersedeJob(claimed.job);
        return;
      }
      this.changed();
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
      if (this.stopped || generation !== this.generation) controller.abort();
      try {
        const run = <T,>(job: Job<T>) => this.service.runLocal({ ...job, requiredMode: mode });
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
        const cancelled = controller.signal.aborted || (error instanceof LocalError && error.code === 'cancelled') ||
          (error instanceof CloudProcessingError && error.deferred);
        const name = error instanceof LocalError && error.diagnostics?.errorName
          ? safeErrorName({ name: error.diagnostics.errorName }) : safeErrorName(error);
        const fatal = (error instanceof LocalError &&
          ['privacy-fault', 'not-configured', 'unsupported'].includes(error.code)) ||
          (error instanceof CloudProcessingError && !error.deferred);
        if (error instanceof LocalError && error.code === 'privacy-fault') this.blocked = true;
        await this.store.fail(claimed.job, name, cancelled, this.now(), fatal,
          claimed.job.step !== 'extract' && dispatched);
        await this.store.finalizeReady();
        await this.store.reconcileOutbox();
      } finally {
        if (rowBatch && typeof document !== 'undefined') {
          document.removeEventListener?.('visibilitychange', onVisibilityChange);
        }
        if (this.active === controller) { this.active = undefined; this.activeJob = undefined; }
      }
    } catch {
      this.failed();
    } finally {
      this.busy = false;
      this.changed();
    }
  }
}
