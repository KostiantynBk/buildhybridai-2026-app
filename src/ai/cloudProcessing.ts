import Ajv from 'ajv';
import { getGenerativeModel, InferenceMode } from 'firebase/ai';
import type { AppConfig } from '../config';
import type { LocalStore } from '../store';
import { firebaseAI } from './firebase';
import { LocalError, type Job } from './localModel';
import { researchError } from './researchFlow';
import { extractV2 } from '../pipeline/prompts/extract.v2';
import { compareV1 } from '../pipeline/prompts/compare.v1';
import { anglesV21 } from '../pipeline/prompts/angles.v2.1';
import { questionV21 } from '../pipeline/prompts/question.v2.1';

export class CloudProcessingError extends Error {
  constructor(message: string, public readonly deferred = false) { super(message); this.name = 'CloudProcessingError'; }
}
export type CloudProcessingAdapter = (job: Job<unknown>, model: string) => Promise<{ source?: string; text: string }>;
export function createProcessingAdapter(config: AppConfig): CloudProcessingAdapter {
  return async (job, model) => {
    const instructions = job.instructions;
    if (!instructions) throw new CloudProcessingError('Cloud processing requires the frozen prompt instruction.');
    const cloudModel = getGenerativeModel(firebaseAI(config), { mode: InferenceMode.ONLY_IN_CLOUD,
      inCloudParams: { model, systemInstruction: instructions.system,
        generationConfig: { responseMimeType: 'application/json',
          responseJsonSchema: job.schema as Record<string, unknown> } } });
    const examples = [{ input: instructions.exampleInput, output: instructions.exampleOutput },
      ...(instructions.additionalExamples ?? [])];
    const contents = examples.flatMap(example => [
      { role: 'user' as const, parts: [{ type: 'text' as const, text: example.input }] },
      { role: 'model' as const, parts: [{ type: 'text' as const, text: example.output }] },
    ]);
    contents.push({ role: 'user', parts: [{ type: 'text', text: job.prompt }] });
    const response = (await cloudModel.generateContent({ contents })).response;
    return { source: response.inferenceSource, text: response.text() };
  };
}
type ProcessingStore = Pick<LocalStore, 'cloudModeConsent' | 'reserveCloudProcessing' |
  'cancelCloudProcessingReservation'>;
const ajv = new Ajv();
export class CloudProcessingService {
  private listeners = new Set<() => void>();
  message = '';
  constructor(private readonly store: ProcessingStore, private readonly adapter: CloudProcessingAdapter,
    private readonly enabled: () => boolean, private readonly model: () => string,
    private readonly changed: () => void, private readonly now: () => number = Date.now,
    private readonly visible: () => boolean = () => true) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private notify(message: string) { this.message = message; this.listeners.forEach(listener => listener()); }
  async runLocal<T>(job: Job<T>): Promise<{ data: T; latencyMs: number; source: string; raw: string }> {
    const allowed = [extractV2, compareV1, anglesV21, questionV21].some(prompt =>
      job.instructions === prompt && job.schema === prompt.schema);
    if (!allowed) throw new CloudProcessingError('This legacy or unrecognized prompt cannot use cloud mode.');
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.visible()) throw new CloudProcessingError('Cloud processing is paused while away.', true);
      if (!this.enabled() || !await this.store.cloudModeConsent() || job.signal?.aborted) {
        throw new CloudProcessingError('Cloud mode is disabled or consent was revoked.', true);
      }
      const sentAt = this.now();
      const reservation = await this.store.reserveCloudProcessing(sentAt);
      if (reservation === null) {
        const message = await this.store.cloudModeConsent() ? 'Cloud mode daily limit reached. Resets tomorrow.'
          : 'Cloud mode consent was revoked.';
        this.notify(message); throw new CloudProcessingError(message, true);
      }
      let dispatched = false;
      let preserveReservation = false;
      try {
        if (!this.enabled() || !await this.store.cloudModeConsent() || job.signal?.aborted) {
          throw new CloudProcessingError('Cloud mode is disabled or consent was revoked.', true);
        }
        if (!this.visible()) {
          preserveReservation = true;
          throw new CloudProcessingError('Cloud processing is paused while away.', true);
        }
        dispatched = true;
        job.onDispatch?.();
        this.changed();
        const result = await this.adapter(job, this.model());
        if (!this.enabled() || !await this.store.cloudModeConsent() || job.signal?.aborted) {
          this.notify('Cloud response discarded because cloud mode or permission changed.');
          throw new CloudProcessingError('Cloud response discarded because cloud mode or permission changed.', true);
        }
        if (result.source !== 'in_cloud') {
          this.notify('Cloud processing source was not verified; output discarded.');
          throw new LocalError('privacy-fault', 'Cloud processing source was not verified; output discarded.');
        }
        let data: unknown;
        try { data = JSON.parse(result.text); } catch { throw new LocalError('invalid-output', 'Invalid cloud JSON.'); }
        if (!ajv.validate(job.schema, data) || (job.validate && !job.validate(data))) {
          throw new LocalError('invalid-output', 'Cloud output did not match the schema.');
        }
        this.notify('');
        return { data: data as T, latencyMs: Math.max(0, this.now() - sentAt),
          source: result.source, raw: result.text };
      } catch (error) {
        if (!dispatched && !preserveReservation) {
          await this.store.cancelCloudProcessingReservation(reservation).catch(() => undefined);
        }
        if (error instanceof LocalError || error instanceof CloudProcessingError) throw error;
        const classified = researchError(error);
        if (classified.network && attempt === 0) continue;
        const message = classified.message.replace('Search research', 'Cloud processing')
          .replace('Research quota', 'Cloud processing quota').replace('Research was', 'Cloud processing was')
          .replace('while researching', 'during cloud processing').replace('Research could', 'Cloud processing could')
          .replace('Research was denied', 'Cloud processing was denied');
        this.notify(message);
        throw new CloudProcessingError(message);
      }
    }
    throw new CloudProcessingError('Cloud processing could not be completed.');
  }
}
