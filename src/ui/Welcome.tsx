import { useState } from 'react';
import type { State } from '../ai/localModel';
import { chromeSetup, copy } from './copy';

export function Welcome({ state, configured, foreground, preparing, cloudMode, cloudEnabled, chooseCloud,
  download, checkAgain, trySample, startBlank, sampleAvailable, browserAvailability = 'not checked' }: {
  state: State; configured: boolean; foreground: boolean; preparing: boolean; cloudMode: boolean;
  cloudEnabled: boolean; sampleAvailable: boolean; browserAvailability?: string;
  chooseCloud(): void; download(): void; checkAgain(): void;
  trySample(): void; startBlank(): void;
}) {
  const [setup, setSetup] = useState(false);
  const ready = state.kind === 'ready';
  const installed = state.kind === 'downloadable' && browserAvailability === 'available';
  const canDownload = state.kind === 'downloadable' || state.kind === 'downloading';
  return <section className="panel welcome" aria-labelledby="welcome-title">
    <span className="eyebrow">ThoughtPartner</span><h2 id="welcome-title">Welcome</h2>
    <p>{copy.welcomePromise}</p><p>{cloudMode ? copy.welcomeCloud : copy.welcomeLocal}</p>
    <div role="status" aria-live="polite">
      {(ready || installed) && <p>Your browser can run the on-device model.</p>}
      {canDownload && !installed && <p>Chrome needs to download the model (one time).</p>}
      {state.kind === 'downloading' && <p>Downloading the on-device model… {
        Math.round(Math.max(0, Math.min(1, state.progress)) * 100)}%</p>}
      {state.kind === 'warming' && <p>Setting up the on-device model…</p>}
      {(state.kind === 'unsupported' || state.kind === 'unavailable' || state.kind === 'error') &&
        <p>The on-device model isn't ready on this browser.</p>}
    </div>
    {state.kind === 'downloading' && <progress aria-label="Model download progress" max={1}
      value={Math.max(0, Math.min(1, state.progress))} />}
    {canDownload && <button className="primary" disabled={!configured || !foreground || preparing}
      onClick={download}>{installed ? 'Set up model' : 'Download model'}</button>}
    {(state.kind === 'unsupported' || state.kind === 'unavailable' || state.kind === 'error') && !cloudMode && <div>
      <button onClick={() => setSetup(value => !value)} aria-expanded={setup}>Set up Gemma 4 in Chrome</button>{' '}
      <button disabled={!configured || !cloudEnabled} onClick={chooseCloud}>Use cloud mode instead</button>
      {setup && <><ol>{chromeSetup.map(step => <li key={step}>{step}</li>)}</ol>
        <button onClick={checkAgain}>Check again</button></>}
    </div>}
    <div className="welcome-actions">
      {sampleAvailable && <button className="primary" onClick={trySample}>Try a sample plan</button>}{' '}
      <button onClick={startBlank}>{sampleAvailable ? 'Start blank' : 'Continue'}</button>
    </div>
  </section>;
}
