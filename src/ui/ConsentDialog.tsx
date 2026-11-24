import { useEffect, useRef } from 'react';

export type ConsentFocus = { trigger: Element | null; fallback: Element | null };
export type ConsentRequest = ConsentFocus & { message: string; cloudMode?: boolean;
  validate?: () => Promise<boolean>; finish(accepted: boolean): void };

export function consentFocus(trigger: Element | null): ConsentFocus {
  return { trigger, fallback: trigger?.closest('article[tabindex], .idea-card') ??
    document.querySelector?.('main') ?? null };
}

export function ConsentDialog({ request }: { request: ConsentRequest }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const accepted = useRef(false);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    cancel.current?.focus();
    return () => {
      if (element.open) element.close();
      if (!(request.cloudMode && accepted.current) && request.trigger instanceof HTMLElement &&
          request.trigger.isConnected) request.trigger.focus();
      if ((request.cloudMode && accepted.current || document.activeElement !== request.trigger) &&
          request.fallback instanceof HTMLElement &&
          request.fallback.isConnected) request.fallback.focus();
    };
  }, [request]);
  return <dialog ref={dialog} aria-labelledby="consent-title" aria-describedby="consent-message"
    onCancel={event => { event.preventDefault(); request.finish(false); }}
    onKeyDown={event => {
      if (event.key !== 'Tab') return;
      const buttons = dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
      if (!buttons?.length) { event.preventDefault(); return; }
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }}>
    <h2 id="consent-title">{request.cloudMode ? 'Use cloud mode?' : 'Send for research?'}</h2>
    <p id="consent-message" className="consent-message">{request.message}</p>
    <button onClick={() => { accepted.current = true; request.finish(true); }}>
      {request.cloudMode ? 'OK' : 'Send'}</button>
    <button ref={cancel} onClick={() => request.finish(false)}>Cancel</button>
  </dialog>;
}
