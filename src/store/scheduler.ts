import { LocalError, type Job } from '../ai/localModel';
import { safeErrorName } from '../ai/errorMetadata';
import { extract, type ExtractVersion } from '../pipeline/extract';
import { type LocalStore } from './index';

export interface LocalService {
  state: { kind: string };
  subscribe(listener: () => void): () => void;
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
  edited(): void {
    this.paused = true;
    this.generation++;
    this.active?.abort();
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
      await this.store.enqueueSettled(this.now(), this.version());
      if (this.stopped || this.paused || this.blocked || this.service.state.kind !== 'ready' ||
          generation !== this.generation) return;
      const claimed = await this.store.claim(this.now());
      if (!claimed) return;
      const controller = new AbortController();
      this.active = controller;
      if (this.stopped || generation !== this.generation) controller.abort();
      try {
        if (controller.signal.aborted) throw new LocalError('cancelled', 'Cancelled before dispatch.');
        const result = await extract(job => this.service.runLocal(job), 'My plan', claimed.paragraph.text,
          controller.signal, claimed.job.promptVersion);
        if (this.stopped || controller.signal.aborted || generation !== this.generation) {
          await this.store.fail(claimed.job, 'AbortError', true, this.now());
        } else {
          await this.store.complete(claimed.job, result.items, this.now());
        }
      } catch (error) {
        const cancelled = controller.signal.aborted || (error instanceof LocalError && error.code === 'cancelled');
        const name = error instanceof LocalError && error.diagnostics?.errorName
          ? safeErrorName({ name: error.diagnostics.errorName }) : safeErrorName(error);
        const fatal = error instanceof LocalError &&
          ['privacy-fault', 'not-configured', 'unsupported'].includes(error.code);
        if (error instanceof LocalError && error.code === 'privacy-fault') this.blocked = true;
        await this.store.fail(claimed.job, name, cancelled, this.now(), fatal);
      } finally {
        if (this.active === controller) this.active = undefined;
      }
    } catch {
      this.failed();
    } finally {
      this.busy = false;
      this.changed();
    }
  }
}
