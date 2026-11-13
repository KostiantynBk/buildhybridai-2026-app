import type { LocalModelService } from '../ai/localModel';

export function startAutoPrepare(
  service: LocalModelService,
  configured: boolean,
  env: { hasApi(): boolean; foreground(): boolean; onVisibility(callback: () => void): () => void },
): () => void {
  let stopped = false;
  let attempted = false;
  const maybePrepare = () => {
    if (stopped || attempted || !configured || !env.hasApi() || !env.foreground() ||
        service.browserAvailability !== 'available' || service.state.kind !== 'downloadable' || service.preparing ||
        service.retryRequired) {
      return;
    }
    attempted = true;
    void service.prepare().catch(() => undefined);
  };
  const unsubscribe = env.onVisibility(maybePrepare);
  void service.probe().then(maybePrepare).catch(() => undefined);
  return () => { stopped = true; unsubscribe(); };
}
