import type { Job } from '../ai/localModel';
import { CloudProcessingError, StorageQuotaError } from '../ai/cloudProcessing';
import { safeErrorName } from '../ai/errorMetadata';
import type { LocalService } from '../store/scheduler';

type Mode = 'on_device' | 'in_cloud';
export function modeRouter(local: LocalService, cloud: Pick<LocalService, 'subscribe' | 'runLocal'> | null,
  storedCloudMode: () => Promise<boolean>, cloudEnabled: () => boolean, visible: () => boolean,
  viewAgrees: (cloud: boolean) => boolean = () => true): LocalService {
  const currentMode = async (): Promise<Mode> => {
    try { return await storedCloudMode() ? 'in_cloud' : 'on_device'; } catch (error) {
      if (safeErrorName(error) === 'QuotaExceededError') throw new StorageQuotaError();
      throw error;
    }
  };
  return {
    // A cached synchronous guess cannot safely authorize a shared-database job.
    get state() { return { kind: 'paused' }; },
    async isReadyFor(mode) {
      if (await currentMode() !== mode || !viewAgrees(mode === 'in_cloud')) return false;
      return mode === 'in_cloud' ? !!cloud && cloudEnabled() && visible() : local.state.kind === 'ready';
    },
    isGeneratingFor(mode) {
      return mode === 'in_cloud' || local.isGeneratingFor?.(mode) !== false;
    },
    subscribe(listener) {
      const offLocal = local.subscribe(listener);
      const offCloud = cloud?.subscribe(listener);
      return () => { offLocal(); offCloud?.(); };
    },
    async runLocal<T>(job: Job<T>) {
      const mode = await currentMode();
      if ((job.requiredMode && job.requiredMode !== mode) || !viewAgrees(mode === 'in_cloud')) {
        throw new CloudProcessingError('The selected processing mode changed before dispatch.', true);
      }
      if (mode === 'in_cloud') {
        if (!cloud || !cloudEnabled() || !visible()) {
          throw new CloudProcessingError('Cloud processing is paused.', true);
        }
        return cloud.runLocal(job);
      }
      return local.runLocal(job);
    },
  };
}
