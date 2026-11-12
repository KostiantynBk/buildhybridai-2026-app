import Ajv from 'ajv';
import { hiddenNow, safeAvailability, safeErrorName } from './errorMetadata';

export const languageOptions = {
  expectedInputs: [{ type: 'text' as const, languages: ['en'] }],
  expectedOutputs: [{ type: 'text' as const, languages: ['en'] }],
};
export type State =
  | { kind: 'unsupported' | 'unavailable' | 'downloadable' | 'warming' | 'ready' }
  | { kind: 'downloading'; progress: number }
  | { kind: 'error'; reason: string };
export type FaultCode =
  | 'not-configured'
  | 'unsupported'
  | 'not-ready'
  | 'privacy-fault'
  | 'invalid-output'
  | 'device-error'
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
  exampleInput: string;
  exampleOutput: string;
}
export interface Job<T> {
  prompt: string;
  schema: object;
  instructions?: PromptContext;
  signal?: AbortSignal;
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

export class LocalModelService {
  state: State = { kind: 'unsupported' };
  privacyFaults = 0;
  browserAvailability = 'not checked';
  preparing = false;
  warmLatencyMs: number | null = null;
  private listeners = new Set<() => void>();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly deps: Dependencies) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private setState(state: State) {
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
  async probe(): Promise<void> {
    if (!this.deps.hasApi()) {
      this.browserAvailability = 'unsupported';
      this.setState({ kind: 'unsupported' });
      return;
    }
    try {
      const value = await this.deps.availability();
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
    this.guardConfigAndApi();
    const retry = this.state.kind === 'error' || this.state.kind === 'unavailable';
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
      const availability = retry ? this.deps.availability() : Promise.resolve(null);
      const preparation = model.prepare((progress) =>
        this.setState({ kind: 'downloading', progress: Math.max(0, Math.min(1, progress)) }),
      );
      const [check, prepared] = await Promise.allSettled([availability, preparation]);
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
        while (!this.deps.isForeground()) {
          await this.waitForeground();
        }
        const result = await this.execute(model, {
          prompt: 'Return JSON with ready set to true.',
          schema: warmSchema,
        });
        this.warmLatencyMs = result.latencyMs;
      });
      this.preparing = false;
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
    this.guardConfigAndApi();
    if (job.signal?.aborted) {
      throw new LocalError('cancelled', 'Local job cancelled before dispatch.');
    }
    if (this.state.kind !== 'ready') {
      throw new LocalError('not-ready', 'Prepare the local model first.');
    }
    return this.enqueue(async () => {
      while (!this.deps.isForeground()) {
        await this.waitForeground();
      }
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
        return await this.execute<T>(model, job);
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
        await this.probe();
        throw new LocalError('device-error', 'Local model request failed.', {
          ...previous,
          errorName,
          availabilityAfter: safeAvailability(this.browserAvailability),
          elapsedMs,
          hidden,
        });
      }
    });
  }
  private async execute<T>(
    model: Model,
    job: Job<T>,
  ): Promise<{ data: T; latencyMs: number; source: string; raw: string }> {
    this.guardConfigAndApi();
    const start = this.deps.now();
    const response = await model.generate(job.prompt, job.schema, job.instructions);
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
