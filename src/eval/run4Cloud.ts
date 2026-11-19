import { isGrounded, sendChecked, type CloudAdapter } from '../ai/cloudResearch';
import { researchError, type ResearchView } from '../ai/researchFlow';
import { filterQuestion } from '../pipeline/leakFilter';
import { HARD_DAILY_CLOUD_BUDGET } from '../settings/defaults';
import type { LocalStore } from '../store';

export type Run4Question = { id: string; profile: 'A' | 'B'; question: string };
export type Run4Idea = { id: string; description: string };
type Store = Pick<LocalStore, 'snapshot' | 'cloudConsent' | 'reserveResearch' | 'finishResearch' | 'cancelResearch'>;
type Measurement = { latencyMs: number; sourceCount: number; suggestionsPresent: boolean;
  inCloud: boolean; grounded: boolean };
export function validateRun4Questions(value: unknown): Run4Question[] {
  if (!Array.isArray(value)) throw new Error('Run 4 question file must be an array.');
  const ids = new Set<string>();
  return value.map(item => {
    if (!item || typeof item.id !== 'string' || !item.id.trim() || ids.has(item.id) ||
        (item.profile !== 'A' && item.profile !== 'B') || typeof item.question !== 'string' ||
        !item.question.trim()) throw new Error('Invalid or duplicate Run 4 question.');
    ids.add(item.id);
    return { id: item.id, profile: item.profile, question: item.question };
  });
}
export function validateRun4Ideas(value: unknown): Run4Idea[] {
  if (!Array.isArray(value)) throw new Error('Run 4 idea file must be an array.');
  const ids = new Set<string>();
  return value.map(item => {
    if (!item || typeof item !== 'object' || Object.keys(item).sort().join(',') !== 'description,id' ||
        typeof item.id !== 'string' || !item.id.trim() || ids.has(item.id) ||
        typeof item.description !== 'string' || !item.description.trim()) throw new Error('Invalid Run 4 idea.');
    ids.add(item.id);
    return { id: item.id, description: item.description };
  });
}
export async function sendRun4Idea(store: Store, adapter: CloudAdapter, item: Run4Idea, model: string,
  options: { enabled: boolean; budget: number; canSend?: () => boolean; now?: () => number;
    onAttempt?: () => void; onResponse?: (value: Measurement) => void }): Promise<ResearchView> {
  return sendRun4Question(store, adapter, { id: item.id, profile: 'A', question: item.description }, model, options);
}
export async function sendRun4Question(store: Store, adapter: CloudAdapter, item: Run4Question, model: string,
  options: { enabled: boolean; budget: number; canSend?: () => boolean; now?: () => number;
    onAttempt?: () => void; onResponse?: (value: Measurement) => void }): Promise<ResearchView> {
  if (!options.enabled) throw new Error('Cloud research is currently disabled.');
  const now = options.now ?? Date.now;
  const budget = Number.isFinite(options.budget)
    ? Math.max(0, Math.min(HARD_DAILY_CLOUD_BUDGET, Math.floor(options.budget))) : 0;
  const allowed = async () => {
    const consent = await store.cloudConsent();
    const terms = (await store.snapshot()).neverSend ?? [];
    return consent && !filterQuestion(item.question, terms).reasons.includes('listed-term') &&
      (!options.canSend || options.canSend());
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const sentAt = now();
    const reservation = await store.reserveResearch('eval', budget, sentAt);
    if (reservation === null) throw new Error('Daily research limit reached. Resets tomorrow.');
    let dispatched = false;
    try {
      if (!await allowed()) throw new Error('Consent or the never-send list prevents this question from being sent.');
      dispatched = true;
      const started = now();
      options.onAttempt?.();
      const result = await sendChecked(async (question, selectedModel) => {
        const reply = await adapter(question, selectedModel);
        options.onResponse?.({ latencyMs: Math.max(0, now() - started),
          sourceCount: reply.result.sources.filter(Boolean).length, suggestionsPresent: !!reply.result.suggestions,
          inCloud: reply.source === 'in_cloud', grounded: isGrounded(reply.result) });
        return reply;
      }, item.question, model);
      const finished = now();
      let changedAfterSend = true;
      try { changedAfterSend = !await allowed(); } catch { /* Be conservative. */ }
      await store.finishResearch(reservation, 'completed').catch(() => undefined);
      return { result, changedAfterSend, sentAt, latencyMs: Math.max(0, finished - started), attempts: attempt + 1 };
    } catch (error) {
      if (!dispatched) { await store.cancelResearch(reservation).catch(() => undefined); throw error; }
      await store.finishResearch(reservation, 'failed').catch(() => undefined);
      const classified = researchError(error);
      if (classified.network && attempt === 0) continue;
      throw new Error(classified.message);
    }
  }
  throw new Error('Research could not be completed.');
}
