import type { LocalModelService, State } from '../ai/localModel';

export function modelLabel(state: State): string {
  switch (state.kind) {
    case 'unsupported':
      return 'not supported';
    case 'unavailable':
      return 'unavailable';
    case 'downloadable':
      return 'not prepared yet';
    case 'downloading':
      return `downloading ${Math.round(state.progress * 100)}%`;
    case 'warming':
      return 'warming up';
    case 'ready':
      return 'ready';
    case 'error':
      return `error — ${state.reason}`;
  }
}

export function canPrepare(
  configured: boolean,
  foreground: boolean,
  preparing: boolean,
  state: State,
): boolean {
  return (
    configured &&
    foreground &&
    !preparing &&
    ['downloadable', 'downloading', 'error', 'unavailable'].includes(state.kind)
  );
}

export function StatusBar({
  service,
  configured,
  foreground,
}: {
  service: LocalModelService;
  configured: boolean;
  foreground: boolean;
}) {
  return (
    <footer className="status" aria-live="polite">
      <div>
        <span className="status-dot" /> <strong>On-device</strong>
        <span className="separator">·</span>Local model: {modelLabel(service.state)}
        <span className="separator">·</span>Browser availability: {service.browserAvailability}
        {service.warmLatencyMs !== null && ` · Warm-up ${Math.round(service.warmLatencyMs)} ms`}
        {!foreground && ' · Paused while away'}
        {service.privacyFaults > 0 && ` · Privacy faults: ${service.privacyFaults}`}
      </div>
      <button
        disabled={!canPrepare(configured, foreground, service.preparing, service.state)}
        onClick={() => {
          void service.prepare().catch(() => undefined);
        }}
      >
        {service.state.kind === 'error' || service.state.kind === 'unavailable'
          ? 'Retry model'
          : 'Prepare model'}
      </button>
    </footer>
  );
}
