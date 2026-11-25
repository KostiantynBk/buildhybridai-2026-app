import { useEffect, useRef } from 'react';

export type ConsentFocus = { trigger: Element | null; fallback: Element | null; main?: Element | null };
export type ConsentRequest = ConsentFocus & { message: string; cloudMode?: boolean;
  validate?: () => Promise<boolean>; finish(accepted: boolean): void };

export function consentFocus(trigger: Element | null): ConsentFocus {
  const main = document.querySelector?.('main[tabindex="-1"]') ?? null;
  return { trigger, fallback: trigger?.closest('article[tabindex], .idea-card') ?? main, main };
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
      const focus = (target: Element | null | undefined) => {
        if (!(target instanceof HTMLElement) || !target.isConnected ||
            target.closest?.('[hidden], [inert], [aria-hidden="true"]') ||
            (target.getClientRects && target.getClientRects().length === 0)) return false;
        target.focus();
        return document.activeElement === target;
      };
      if (!(request.cloudMode && accepted.current) && focus(request.trigger)) return;
      if (focus(request.fallback)) return;
      focus(request.main ?? document.querySelector?.('main[tabindex="-1"]'));
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
