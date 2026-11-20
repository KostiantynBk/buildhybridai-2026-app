import { useState } from 'react';
import type { State } from '../ai/localModel';

export function Notices({ configured, state, cloudMode, cloudEnabled, chooseCloud }: {
  configured: boolean; state: State; cloudMode?: boolean; cloudEnabled?: boolean; chooseCloud?: () => void;
}) {
  const [setup, setSetup] = useState(false);
  return (
    <>
      {!configured && (
        <div className="notice">Firebase is not configured: AI features are off. See README setup.</div>
      )}
      {['unsupported', 'unavailable', 'error'].includes(state.kind) && !cloudMode && (
        <div className="notice">
          <p>The on-device model is unavailable or setup failed. Choose how you would like to continue.</p>
          <button onClick={() => setSetup(value => !value)}>Set up Chrome's on-device model</button>{' '}
          {chooseCloud && <button disabled={!configured || !cloudEnabled} onClick={chooseCloud}>
            Use cloud mode instead</button>}
          {chooseCloud && (!configured || !cloudEnabled) && <p>Cloud mode is unavailable: {
            !configured ? 'Firebase is not configured.' : 'Cloud processing is disabled.'}</p>}
          {setup && <p>Use a supported desktop Chrome version with sufficient disk and hardware. Check
            chrome://components and chrome://flags/#gemma4-for-built-in-ai; availability depends on your browser
            and device. The browser does not guarantee which model responds.</p>}
        </div>
      )}
    </>
  );
}
