import { useState } from 'react';
import type { LocalModelService, State } from '../ai/localModel';
import { builtInSettings, type SettingsSnapshot } from '../settings/defaults';
import { copy } from './copy';

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

export function showPrepare(state: State, availability: string, retryRequired = false): boolean {
  return state.kind === 'error' || (retryRequired && ['downloadable', 'unavailable'].includes(state.kind)) ||
    ((state.kind === 'downloadable' || state.kind === 'downloading') && availability !== 'available');
}
export function prepareDisabledReason(configured: boolean, foreground: boolean, preparing: boolean): string {
  if (!configured) return 'Firebase is not configured.';
  if (!foreground) return 'Return to this tab before preparing the model.';
  if (preparing) return 'Model preparation is already in progress.';
  return '';
}

export function settingsLabel(settings: SettingsSnapshot): string {
  const hasRemote = Object.values(settings.sources).includes('remote');
  const rejected = Object.values(settings.sources).includes('remote-rejected');
  const time = settings.fetchTime === null ? '' : `, fetched ${new Date(settings.fetchTime).toLocaleTimeString()}`;
  return `${hasRemote ? 'from Firebase' : 'built-in'}${time}${rejected ? ' (some values rejected)' : ''}`;
}

export function StatusBar({
  service,
  configured,
  foreground,
  settings = builtInSettings(),
  cloudMode = false,
  cloudMessage = '',
  navigate = () => {},
}: {
  service: LocalModelService;
  configured: boolean;
  foreground: boolean;
  settings?: SettingsSnapshot;
  cloudMode?: boolean;
  cloudMessage?: string;
  navigate?: (page: 'Outbox' | 'Profile') => void;
}) {
  const [privacy, setPrivacy] = useState(false);
  return (
    <footer className="status">
      <div>
        <div role="status" aria-live="polite"><span className={`status-dot ${service.state.kind === 'ready'
          ? 'is-ready' : ''}`} aria-hidden="true" />{' '}
          <strong>{cloudMode ? 'Cloud mode' : 'On-device mode'}</strong>
          {' · '}Model: {modelLabel(service.state)}{!foreground && ' · Paused while away'}
          {cloudMessage && ` · ${cloudMessage}`}
          {service.privacyFaults > 0 && ` · A model response was stopped for safety (${service.privacyFaults}).`}
        </div>
        <button className="quiet" aria-expanded={privacy} onClick={() => setPrivacy(value => !value)}>
          What leaves your laptop</button>
        {privacy && <section className="privacy-panel" aria-label="What leaves your laptop">
          <p>On-device mode keeps notebook processing on this device.</p>
          <p>{copy.firebaseContact}</p>
          <p>Cloud mode sends paragraphs, earlier statement wording, derived statements and concerns to Google to
            write questions and a short description of your idea. Your profile and Never send list are not sent.</p>
          <p>Search research sends only the question or description you approve, with separate consent.</p>
          <button className="quiet" onClick={() => navigate('Outbox')}>What left your laptop</button>{' '}
          <button className="quiet" onClick={() => navigate('Profile')}>Privacy controls</button>
        </section>}
        <details><summary>Details</summary><p>Browser availability: {service.browserAvailability}
          {service.warmLatencyMs !== null && ` · Warm-up ${Math.round(service.warmLatencyMs)} ms`}
          {' · '}Settings: {settingsLabel(settings)}</p></details>
      </div>
      {!cloudMode && showPrepare(service.state, service.browserAvailability, service.retryRequired) && <div>
        <button
          disabled={!canPrepare(configured, foreground, service.preparing, service.state)}
          onClick={() => { void service.prepare().catch(() => undefined); }}
        >{service.state.kind === 'error' || service.retryRequired ? 'Set up model' : 'Download model'}</button>
        {!canPrepare(configured, foreground, service.preparing, service.state) &&
          <p>{prepareDisabledReason(configured, foreground, service.preparing)}</p>}
      </div>}
    </footer>
  );
}
