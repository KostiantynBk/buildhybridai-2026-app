import { useEffect, useRef, useState } from 'react';
import type { ThoughtCard, OutboxEntry } from '../store/triageTypes';
import { researchFailureMessage } from '../ai/researchFailure';
import { withdrawalText } from './OutboxPage';
import { copy, displayMessage } from './copy';

export function DraftControls({ card, outbox, receiptStatus, failureCode, researchError, searching = false,
  checkingSend = false, statusInParent = false, controlsDisabled = false, send, decline, reopen, research }: {
  card: ThoughtCard; outbox?: OutboxEntry; receiptStatus?: 'sent' | 'completed' | 'failed'; failureCode?: string;
  researchError?: string; searching?: boolean; checkingSend?: boolean; statusInParent?: boolean;
  controlsDisabled?: boolean;
  send?: (cardId: string, text: string) => Promise<void>;
  decline?: (cardId: string) => Promise<void>;
  reopen?: (cardId: string) => Promise<void>;
  research?: (id: string) => Promise<void>;
}) {
  const [text, setText] = useState(card.draftQuestion ?? '');
  const edited = useRef(false);
  useEffect(() => {
    if (!edited.current && card.draftQuestion !== undefined) setText(card.draftQuestion);
  }, [card.id, card.draftQuestion]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const act = (operation: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setMessage('');
    void operation().catch(error => setMessage(
      error instanceof Error ? displayMessage(error.message) : 'Could not complete this action.'))
      .finally(() => { locked.current = false; setBusy(false); });
  };
  if (card.questionStatus === 'marked') return null;
  if (card.questionStatus === 'waiting') return statusInParent ? null : <p>{copy.draftQuestion}</p>;
  if (card.questionStatus === 'declined') return <div><p>Not sent.</p>
    {reopen && <button disabled={busy || controlsDisabled} onClick={() => act(() => reopen(card.id))}>Reopen</button>}
    {message && <p role="alert">{message}</p>}</div>;
  if (card.questionStatus !== 'ready') return null;
  return <section><h4>Was this question useful?</h4>
    {card.noCheckable && <p>ThoughtPartner found nothing it could look up here. You can write your own question.</p>}
    {!outbox && <><label>Question <textarea value={text} onChange={event => {
      edited.current = true; setText(event.target.value);
    }} /></label>
      {(card.draftKeptOut ?? []).length > 0 && <p>Left out of the question: {card.draftKeptOut!.join(', ')}</p>}
      {send && <button disabled={busy || controlsDisabled} onClick={() => act(() => send(card.id, text))}>
        Send this question</button>}
      {decline && <button disabled={busy || controlsDisabled} onClick={() => act(() => decline(card.id))}>
        Don't send</button>}</>}
    {outbox && <><p>{outbox.question}</p>
      {outbox.status === 'pending' && <p>This question is waiting for your decision in the Outbox.</p>}
      {outbox.status === 'withdrawn' && <p>{withdrawalText(outbox)}</p>}
      {outbox.status === 'rejected' && <p>Not approved in the Outbox.</p>}
      {outbox.status === 'approved' && (searching || checkingSend) ?
        !statusInParent && <p>{searching ? copy.searching : copy.checkingBeforeResearch}</p> :
        outbox.status === 'approved' && <p>{receiptStatus === 'completed' ? copy.researchCompleted :
          receiptStatus === 'sent' ? copy.requestSent :
            receiptStatus === 'failed' ? `Sent, but the search failed: ${researchFailureMessage(failureCode)}` :
              researchError || copy.approvedNotSent}</p>}
      {outbox.status === 'approved' && (searching || checkingSend) && receiptStatus === 'completed' &&
        <p>Previous research completed.</p>}
      {outbox.status === 'approved' && (searching || checkingSend) && receiptStatus === 'failed' &&
        <p>Previous attempt failed: {researchFailureMessage(failureCode)}</p>}
      {outbox.status === 'approved' && !searching && receiptStatus !== 'completed' && research &&
        <button disabled={busy || checkingSend || controlsDisabled}
        onClick={() => act(() => research(outbox.id))}>{receiptStatus === 'failed' ? 'Try again' : 'Send now'}
      </button>}</>}
    {message && (!outbox || (outbox.status === 'approved' && !receiptStatus)) && <p role="alert">{message}</p>}
  </section>;
}
