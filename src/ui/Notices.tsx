import type { State } from '../ai/localModel';

export function Notices({ configured, state }: { configured: boolean; state: State }) {
  return (
    <>
      {!configured && (
        <div className="notice">Firebase is not configured: AI features are off. See README setup.</div>
      )}
      {(state.kind === 'unsupported' || state.kind === 'unavailable') && (
        <div className="notice">
          The local model is unavailable. Use compatible desktop Chrome, sufficient disk and supported
          hardware. No automatic cloud fallback is used.
        </div>
      )}
    </>
  );
}
