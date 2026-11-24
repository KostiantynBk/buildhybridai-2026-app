import { useState } from 'react';

/** Dismissals are local to this mounted draft and its exact text. */
export function useNameDismissals(text: string, draftId: string) {
  const [cleared, setCleared] = useState<Record<string, string[]>>({});
  const key = JSON.stringify([draftId, text]);
  return {
    remaining: (names: string[]) => names.filter(name => !(cleared[key] ?? []).includes(name)),
    dismiss: (name: string) => setCleared(old => ({ ...old, [key]: [...(old[key] ?? []), name] })),
  };
}

export function NameWarning({ names, dismiss }: { names: string[]; dismiss(name: string): void }) {
  if (!names.length) return null;
  return <p>{names.length === 1 ? 'This looks like a name from your plan: ' :
    'These look like names from your plan: '}{names.map((name, index) => <span key={name}>
    {index > 0 && ', '}{name} <button type="button" className="quiet name-dismiss"
      aria-label={`Not private: ${name}`} onClick={() => dismiss(name)}>Not private</button></span>)}.
    {' '}{names.length === 1 ? 'Edit it out, or send anyway.' : 'Edit them out, or send anyway.'}</p>;
}
