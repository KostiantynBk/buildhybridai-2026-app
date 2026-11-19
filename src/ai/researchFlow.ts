import type { LocalStore } from '../store';
import { HARD_DAILY_CLOUD_BUDGET } from '../settings/defaults';
import { isGrounded, sendChecked, type CloudAdapter, type ResearchResult } from './cloudResearch';
import { researchFailureMessage, type ResearchFailureCode } from './researchFailure';

export type ResearchView = { result: ResearchResult; changedAfterSend: boolean; sentAt: number;
  latencyMs: number; attempts: number };
type Store = Pick<LocalStore, 'snapshot' | 'preSendCheck' | 'reserveResearch' | 'finishResearch' |
  'cancelResearch' | 'cloudConsent'>;

export function researchError(error: unknown): { network: boolean; message: string; code: ResearchFailureCode } {
  type Details = { status?: number; errorDetails?: Array<{ reason?: string; code?: string }>;
    response?: { promptFeedback?: { blockReason?: string }; candidates?: Array<{ finishReason?: string }> } };
  const value = error as { code?: string; name?: string; message?: string; finishReason?: string;
    blockReason?: string; customErrorData?: Details; customData?: Details };
  const details = value?.customErrorData ?? value?.customData;
  const status = details?.status;
  const reasons = [value?.code, ...(Array.isArray(details?.errorDetails) ? details.errorDetails : [])
    .flatMap(item => [item?.reason, item?.code])];
  const safety = value?.blockReason === 'SAFETY' || value?.finishReason === 'SAFETY' ||
    details?.response?.promptFeedback?.blockReason === 'SAFETY' ||
    details?.response?.candidates?.some(candidate => candidate.finishReason === 'SAFETY');
  const networkMessages = ['Failed to fetch', 'Network request failed', 'Load failed'];
  const wrappedNetwork = value?.name === 'FirebaseError' && value?.code === 'error' &&
    networkMessages.some(text => value.message?.endsWith(`: ${text} (AI/error)`));
  const network = status === undefined && (value?.name === 'NetworkError' || wrappedNetwork ||
    (value?.name === 'TypeError' && networkMessages.includes(value.message ?? '')));
  const message = value?.message ?? '';
  const code: ResearchFailureCode = status === 429 || reasons.includes('RESOURCE_EXHAUSTED') ? 'quota' :
    (status === 400 || status === 403) && reasons.includes('BILLING_DISABLED') ? 'billing' :
      status === 401 || status === 403 ? 'permission' :
        safety ? 'safety' :
          network ? 'network' : message === 'Cloud research did not run in the cloud.' ? 'source-invalid' :
            message === 'Research could not be displayed with its required Search sources and suggestions.'
              ? 'display-invalid' : 'unknown';
  return { network: code === 'network', code, message: researchFailureMessage(code) };
}

// An idea uses the same attempt/budget machinery, with its own basis-aware pre-send boundary.
export async function researchIdea(store: LocalStore, adapter: CloudAdapter, ideaId: string, model: string,
  options: { budget: number; enabled?: boolean; canSend?: () => boolean; planUnchanged?: () => boolean;
    onAttempt?: () => void; onResponse?: (measurement: { latencyMs: number; sourceCount: number;
      suggestionsPresent: boolean; inCloud: boolean; grounded: boolean }) => void }): Promise<ResearchView> {
  const snapshot = await store.snapshot();
  const idea = snapshot.ideas?.find(value => value.id === ideaId);
  if (!idea?.outboxId) throw new Error('Approve this description before researching it.');
  const entryId = idea.outboxId;
  const guarded: Store = { snapshot: () => store.snapshot(), cloudConsent: () => store.cloudConsent(),
    preSendCheck: () => store.preSendIdeaCheck(ideaId), reserveResearch: (...args) => store.reserveResearch(...args),
    finishResearch: (...args) => store.finishResearch(...args), cancelResearch: key => store.cancelResearch(key) };
  return researchApproved(guarded, adapter, entryId, model, options);
}

// Only the stored approved question crosses the adapter boundary. Reservations serialize across tabs.
export async function researchApproved(
  store: Store, adapter: CloudAdapter, entryId: string, model: string,
  options: { budget: number; enabled?: boolean; canSend?: () => boolean; planUnchanged?: () => boolean;
    now?: () => number;
    onAttempt?: () => void;
    onResponse?: (measurement: { latencyMs: number; sourceCount: number; suggestionsPresent: boolean;
      inCloud: boolean; grounded: boolean }) => void } =
    { budget: HARD_DAILY_CLOUD_BUDGET },
): Promise<ResearchView> {
  if (options.enabled === false) throw new Error('Cloud research is currently disabled.');
  const entry = (await store.snapshot()).outbox?.find(value => value.id === entryId);
  if (!entry || entry.status !== 'approved') throw new Error('Approve this question before researching it.');
  const now = options.now ?? Date.now;
  const budget = Number.isFinite(options.budget)
    ? Math.max(0, Math.min(HARD_DAILY_CLOUD_BUDGET, Math.floor(options.budget))) : 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (options.canSend && !options.canSend()) throw new Error('Save your plan before researching.');
    const sentAt = now();
    const reservation = await store.reserveResearch(entryId, budget, sentAt);
    if (reservation === null) throw new Error('Daily research limit reached. Resets tomorrow.');
    let dispatched = false;
    try {
      const consent = await store.cloudConsent();
      const before = await store.preSendCheck(entryId);
      if (!consent || !before.allowed || (options.canSend && !options.canSend())) {
        throw new Error('This question cannot be sent: your plan or privacy settings changed.');
      }
      dispatched = true;
      const dispatchAt = now();
      options.onAttempt?.();
      const result = await sendChecked(async (question, selectedModel) => {
        const reply = await adapter(question, selectedModel);
        options.onResponse?.({ latencyMs: Math.max(0, now() - dispatchAt),
          sourceCount: reply.result.sources.filter(Boolean).length, suggestionsPresent: !!reply.result.suggestions,
          inCloud: reply.source === 'in_cloud', grounded: isGrounded(reply.result) });
        return reply;
      }, entry.question, model);
      const completedAt = now();
      let changedAfterSend = true;
      try { changedAfterSend = !(await store.preSendCheck(entryId)).allowed ||
        !!(options.planUnchanged && !options.planUnchanged()); } catch { /* Be conservative. */ }
      await store.finishResearch(reservation, 'completed').catch(() => undefined);
      return { result, changedAfterSend, sentAt, latencyMs: Math.max(0, completedAt - dispatchAt),
        attempts: attempt + 1 };
    } catch (error) {
      if (!dispatched) {
        await store.cancelResearch(reservation).catch(() => undefined);
        throw error;
      }
      const classified = researchError(error);
      await store.finishResearch(reservation, 'failed', classified.code).catch(() => undefined);
      if (classified.network && attempt === 0) continue;
      throw new Error(classified.message);
    }
  }
  throw new Error('Research could not be completed.');
}
