import type { LocalStore } from '../store';
import { HARD_DAILY_CLOUD_BUDGET } from '../settings/defaults';
import { isGrounded, sendChecked, type CloudAdapter, type ResearchResult } from './cloudResearch';

export type ResearchView = { result: ResearchResult; changedAfterSend: boolean; sentAt: number;
  latencyMs: number; attempts: number };
type Store = Pick<LocalStore, 'snapshot' | 'preSendCheck' | 'reserveResearch' | 'finishResearch' |
  'cancelResearch' | 'cloudConsent'>;

export function researchError(error: unknown): { network: boolean; message: string } {
  const value = error as { code?: string; name?: string; message?: string;
    customErrorData?: { status?: number }; customData?: { status?: number } };
  const status = value?.customErrorData?.status ?? value?.customData?.status;
  const message = value?.message ?? '';
  if (status === 429) {
    return { network: false, message: 'Research quota is exhausted. Try again later.' };
  }
  if (/billing|paid tier|paid service|billing account/i.test(message)) {
    return { network: false, message: 'Search research requires billing on the Firebase project.' };
  }
  if (/quota|resource.exhausted/i.test(message)) {
    return { network: false, message: 'Research quota is exhausted. Try again later.' };
  }
  if (/safety|blocked/i.test(message)) {
    return { network: false, message: 'Research was blocked by the provider’s safety checks.' };
  }
  const network = status === undefined && (value?.name === 'NetworkError' ||
    /failed to fetch|networkerror|network request failed|load failed/i.test(message));
  if (network) return { network: true, message: 'Network error while researching. Please try again.' };
  if (message === 'Cloud research did not run in the cloud.' ||
      message.startsWith('Research could not be displayed')) return { network: false, message };
  return { network: false, message: status === 403
    ? 'Research was denied. Check Firebase permissions and whether billing is enabled.'
    : 'Research could not be completed. Check billing, connection and project settings.' };
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
      await store.finishResearch(reservation, 'failed').catch(() => undefined);
      const classified = researchError(error);
      if (classified.network && attempt === 0) continue;
      throw new Error(classified.message);
    }
  }
  throw new Error('Research could not be completed.');
}
