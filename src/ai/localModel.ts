import Ajv from 'ajv';
import { hiddenNow, safeErrorName } from './errorMetadata';

export const languageOptions = {
  expectedInputs: [{ type: 'text' as const, languages: ['en'] }],
  expectedOutputs: [{ type: 'text' as const, languages: ['en'] }],
};
export type State =
  | { kind: 'unsupported' | 'unavailable' | 'downloadable' | 'warming' | 'ready' | 'stalled' }
  | { kind: 'downloading'; progress: number }
  | { kind: 'error'; reason: string };
export type FaultCode =
  | 'not-configured'
  | 'unsupported'
  | 'not-ready'
  | 'privacy-fault'
  | 'invalid-output'
  | 'device-error'
  | 'model-quota'
  | 'timeout'
  | 'cancelled';
export interface ErrorDiagnostics {
  source?: string;
  latencyMs?: number;
  errorName?: string;
  availabilityAfter?: string | null;
  elapsedMs?: number | null;
  hidden?: boolean | null;
}
export class LocalError extends Error {
  constructor(
    public readonly code: FaultCode,
    message: string,
    public readonly diagnostics?: ErrorDiagnostics,
  ) {
    super(message);
    this.name = 'LocalError';
  }
}
export interface PromptContext {
  system: string;
  exampleInput?: string;
  exampleOutput?: string;
  additionalExamples?: readonly { input: string; output: string }[];
}
export interface Job<T> {
  prompt: string;
  schema: object;
  instructions?: PromptContext;
  signal?: AbortSignal;
  onDispatch?: () => void;
  requiredMode?: 'on_device' | 'in_cloud';
  validate?: (value: unknown) => value is T;
}
export interface Model {
  prepare(progress: (value: number) => void): Promise<void>;
  generate(
    prompt: string,
    schema: object,
    instructions?: PromptContext,
  ): Promise<{
    source?: string;
    text: () => string;
  }>;
}
export interface Dependencies {
  configured: boolean;
  hasApi(): boolean;
  availability(): Promise<string>;
  createModel(): Model;
  isForeground(): boolean;
  onForeground(callback: () => void): () => void;
  now(): number;
  isHidden?(): boolean;
}
const warmSchema = {
  type: 'object',
  properties: { ready: { type: 'boolean' } },
  required: ['ready'],
  additionalProperties: false,
};
const ajv = new Ajv();
// A single native generation has 180 seconds after dispatch; timeout requires a page reload.
export const LOCAL_GENERATION_TIMEOUT_MS = 180_000;
export const LOCAL_AVAILABILITY_TIMEOUT_MS = 30_000;

export class LocalModelService {
  state: State = { kind: 'unsupported' };
  privacyFaults = 0;
  browserAvailability = 'not checked';
  preparing = false;
  retryRequired = false;
  warmLatencyMs: number | null = null;
  generating = false;
  private stalled = false;
  private probeGeneration = 0;
  private listeners = new Set<() => void>();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly deps: Dependencies) {}
  isGeneratingFor = (mode: 'on_device' | 'in_cloud') => mode === 'on_device' && this.generating;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private isStalled(): boolean { return this.stalled; }
  private isReadyOrPreparing(): boolean { return this.preparing || this.state.kind === 'ready'; }
  private assertNotStalled(): void {
    if (this.stalled) throw new LocalError('timeout', 'Reload before preparing again.');
  }
  private setState(state: State) {
    if (this.stalled && state.kind !== 'stalled') return;
    if (state.kind === 'stalled') this.stalled = true;
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work);
    this.tail = next.catch(() => undefined);
    return next;
  }
  private async waitForeground(): Promise<void> {
    if (this.deps.isForeground()) {
      return;
    }
    await new Promise<void>((resolve) => {
      const unsubscribe = this.deps.onForeground(() => {
        if (this.deps.isForeground()) {
          unsubscribe();
          resolve();
        }
      });
      if (this.deps.isForeground()) {
        unsubscribe();
        resolve();
      }
    });
  }
  private async availability(obsolete: () => boolean = () => false): Promise<string> {
    this.assertNotStalled();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([this.deps.availability(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          if (obsolete()) { reject(new LocalError('cancelled', 'The readiness check was superseded.')); return; }
          this.setState({ kind: 'stalled' });
          reject(new LocalError('timeout', 'The on-device model stopped responding.'));
        }, LOCAL_AVAILABILITY_TIMEOUT_MS);
      })]);
      this.assertNotStalled();
      return value;
    } finally { if (timer) clearTimeout(timer); }
  }
  async probe(signal?: AbortSignal): Promise<void> {
    const generation = ++this.probeGeneration;
    if (signal?.aborted || this.isStalled() || this.isReadyOrPreparing()) return;
    if (!this.deps.hasApi()) {
      this.browserAvailability = 'unsupported';
      this.setState({ kind: 'unsupported' });
      return;
    }
    const observed = this.state;
    const obsolete = () => Boolean(signal?.aborted) || generation !== this.probeGeneration ||
      this.state !== observed || this.isReadyOrPreparing();
    try {
      const value = await this.availability(obsolete);
      if (this.isStalled() || obsolete()) return;
      this.browserAvailability = value;
      if (value === 'unavailable') {
        this.setState({ kind: 'unavailable' });
      } else if (value === 'downloading') {
        this.setState({ kind: 'downloading', progress: 0 });
      } else if (value === 'available' || value === 'downloadable') {
        this.setState({ kind: 'downloadable' });
      } else {
        this.setState({ kind: 'error', reason: 'Unknown model availability.' });
      }
    } catch {
      if (this.isStalled() || obsolete()) return;
      this.browserAvailability = 'check failed';
      this.setState({ kind: 'error', reason: 'Could not check model availability.' });
    }
  }
  private guardConfigAndApi() {
    if (!this.deps.configured) {
      throw new LocalError('not-configured', 'Firebase is not configured.');
    }
    if (!this.deps.hasApi()) {
      this.browserAvailability = 'unsupported';
      this.setState({ kind: 'unsupported' });
      throw new LocalError('unsupported', 'The local model API is unavailable.');
    }
  }
  async prepare(): Promise<void> {
    this.assertNotStalled();
    this.guardConfigAndApi();
    const retry = this.retryRequired || this.state.kind === 'error' || this.state.kind === 'unavailable';
    if (
      this.preparing ||
      (!retry && this.state.kind !== 'downloadable' && this.state.kind !== 'downloading')
    ) {
      throw new LocalError('not-ready', 'The device model cannot be prepared in this state.');
    }
    this.preparing = true;
    this.setState({ kind: 'downloading', progress: 0 });
    try {
      // Construct synchronously in the activation handler, before awaiting model work.
      const model = this.deps.createModel();
      // Start both checks before yielding; the SDK itself rechecks availability before downloading.
      const availability = retry ? this.availability() : Promise.resolve(null);
      const preparation = model.prepare((progress) => {
        if (!this.isStalled()) this.setState({ kind: 'downloading', progress: Math.max(0, Math.min(1, progress)) });
      });
      const [check, prepared] = await Promise.allSettled([availability, preparation]);
      this.assertNotStalled();
      if (prepared.status === 'rejected') {
        throw prepared.reason;
      }
      if (check.status === 'rejected') {
        throw check.reason;
      }
      if (check.value !== null) {
        this.browserAvailability = check.value;
      }
      this.setState({ kind: 'warming' });
      await this.enqueue(async () => {
        this.assertNotStalled();
        while (!this.deps.isForeground()) {
          await this.waitForeground();
          this.assertNotStalled();
        }
        this.assertNotStalled();
        const result = await this.execute(model, {
          prompt: 'Return JSON with ready set to true.',
          schema: warmSchema,
        });
        this.assertNotStalled();
        this.warmLatencyMs = result.latencyMs;
      });
      this.assertNotStalled();
      this.preparing = false;
      this.retryRequired = false;
      this.setState({ kind: 'ready' });
    } catch (error) {
      this.preparing = false;
      this.setState({
        kind: 'error',
        reason: error instanceof LocalError ? error.message : 'Model preparation failed.',
      });
      if (error instanceof LocalError) {
        throw error;
      }
      throw new LocalError('device-error', 'Model preparation failed.');
    }
  }
  async runLocal<T>(
    job: Job<T>,
  ): Promise<{ data: T; latencyMs: number; source: string; raw: string }> {
    this.assertNotStalled();
    this.guardConfigAndApi();
    if (job.signal?.aborted) {
      throw new LocalError('cancelled', 'Local job cancelled before dispatch.');
    }
    if (this.state.kind !== 'ready') {
      throw new LocalError('not-ready', 'Prepare the local model first.');
    }
    return this.enqueue(async () => {
      this.assertNotStalled();
      while (!this.deps.isForeground()) {
        await this.waitForeground();
        this.assertNotStalled();
      }
      this.assertNotStalled();
      if (job.signal?.aborted) {
        throw new LocalError('cancelled', 'Local job cancelled before dispatch.');
      }
      if (this.state.kind !== 'ready') {
        throw new LocalError('not-ready', 'The local model is not ready.');
      }
      this.guardConfigAndApi();
      const dispatchStart = this.deps.now();
      try {
        const model = this.deps.createModel();
        return await this.execute<T>(model, job, true);
      } catch (error) {
        const elapsedMs = Math.max(0, this.deps.now() - dispatchStart);
        const hidden = this.deps.isHidden ? this.deps.isHidden() : hiddenNow();
        const previous = error instanceof LocalError ? error.diagnostics : undefined;
        const errorName = previous?.errorName ?? safeErrorName(error);
        if (error instanceof LocalError && error.code !== 'device-error') {
          throw new LocalError(error.code, error.message, {
            ...previous,
            errorName,
            availabilityAfter: null,
            elapsedMs,
            hidden,
          });
        }
        this.retryRequired = true;
        this.setState({ kind: 'error', reason: 'The on-device model needs preparing again.' });
        throw new LocalError('device-error', 'Local model request failed.', {
          ...previous,
          errorName,
          availabilityAfter: null,
          elapsedMs,
          hidden,
        });
      }
    });
  }
  private async execute<T>(
    model: Model,
    job: Job<T>,
    bounded = false,
  ): Promise<{ data: T; latencyMs: number; source: string; raw: string }> {
    this.assertNotStalled();
    this.guardConfigAndApi();
    const start = this.deps.now();
    job.onDispatch?.();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let response: Awaited<ReturnType<Model['generate']>>;
    try {
      if (bounded) { this.generating = true; this.listeners.forEach(listener => listener()); }
      const generation = model.generate(job.prompt, job.schema, job.instructions);
      response = bounded ? await Promise.race([generation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          this.setState({ kind: 'stalled' });
          reject(new LocalError('timeout', 'The on-device model stopped responding.', { errorName: 'TimeoutError' }));
        }, LOCAL_GENERATION_TIMEOUT_MS);
      })]) : await generation;
    } catch (error) {
      if (error instanceof LocalError) throw error;
      const errorName = safeErrorName(error);
      if (errorName === 'QuotaExceededError') {
        throw new LocalError('model-quota', "The on-device model couldn't process this part.", { errorName });
      }
      throw new LocalError('device-error', 'Local model request failed.', { errorName });
    } finally {
      if (timer) clearTimeout(timer);
      if (bounded) { this.generating = false; this.listeners.forEach(listener => listener()); }
    }
    this.assertNotStalled();
    const latencyMs = this.deps.now() - start;
    if (response.source !== 'on_device') {
      this.privacyFaults++;
      this.listeners.forEach((listener) => listener());
      throw new LocalError(
        'privacy-fault',
        'Local inference source was not verified; output discarded.',
        { source: response.source ?? 'not reported', latencyMs },
      );
    }
    let text: string;
    try {
      text = response.text();
    } catch (error) {
      throw new LocalError('device-error', 'Local model response failed.', {
        source: response.source,
        latencyMs,
        errorName: safeErrorName(error),
        hidden: this.deps.isHidden ? this.deps.isHidden() : hiddenNow(),
      });
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new LocalError('invalid-output', 'Local output was not valid JSON.', {
        source: response.source,
        latencyMs,
        errorName: safeErrorName(error),
      });
    }
    let valid = false;
    try {
      valid = Boolean(ajv.validate(job.schema, data)) && (!job.validate || job.validate(data));
    } catch {
      valid = false;
    }
    if (!valid) {
      throw new LocalError('invalid-output', 'Local output did not match its schema.', {
        source: response.source,
        latencyMs,
      });
    }
    return { data: data as T, latencyMs, source: response.source, raw: text };
  }
}
