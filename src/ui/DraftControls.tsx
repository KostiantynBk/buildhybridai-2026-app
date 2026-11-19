import { useEffect, useRef, useState } from 'react';
import type { ThoughtCard, OutboxEntry } from '../store/triageTypes';
import { researchFailureMessage } from '../ai/researchFailure';
import { withdrawalText } from './OutboxPage';

export function DraftControls({ card, outbox, receiptStatus, failureCode, researchError,
  send, decline, reopen, research }: {
  card: ThoughtCard; outbox?: OutboxEntry; receiptStatus?: 'sent' | 'completed' | 'failed'; failureCode?: string;
  researchError?: string;
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
      error instanceof Error ? error.message : 'Could not complete this action.'))
      .finally(() => { locked.current = false; setBusy(false); });
  };
  if (card.questionStatus === 'marked') return null;
  if (card.questionStatus === 'waiting') return <p role="status">Preparing your question…</p>;
  if (card.questionStatus === 'declined') return <div><p>Not sent.</p>
    {reopen && <button disabled={busy} onClick={() => act(() => reopen(card.id))}>Reopen</button>}
    {message && <p role="alert">{message}</p>}</div>;
  if (card.questionStatus !== 'ready') return null;
  return <section><h4>Was this question useful?</h4>
    {card.noCheckable && <p>ThoughtPartner found nothing it could look up here. You can write your own question.</p>}
    {!outbox && <><label>Question <textarea value={text} onChange={event => {
      edited.current = true; setText(event.target.value);
    }} /></label>
      {(card.draftKeptOut ?? []).length > 0 && <p>Left out of the question: {card.draftKeptOut!.join(', ')}</p>}
      {send && <button disabled={busy} onClick={() => act(() => send(card.id, text))}>Send this question</button>}{' '}
      {decline && <button disabled={busy} onClick={() => act(() => decline(card.id))}>Don't send</button>}</>}
    {outbox && <><p>{outbox.question}</p>
      {outbox.status === 'pending' && <p>Legacy question awaiting a decision in the Outbox.</p>}
      {outbox.status === 'withdrawn' && <p>{withdrawalText(outbox)}</p>}
      {outbox.status === 'rejected' && <p>Not approved in the Outbox.</p>}
      {outbox.status === 'approved' && receiptStatus === 'completed' && <p>Research completed.</p>}
      {outbox.status === 'approved' && receiptStatus !== 'completed' && <p>{
        receiptStatus === 'sent' ? 'Research request sent; awaiting completion.' : receiptStatus === 'failed'
          ? `Sent, but the search failed: ${researchFailureMessage(failureCode)}` :
            busy ? 'Approved, not sent. Research in progress…' : researchError || 'Approved, not sent.'}</p>}
      {outbox.status === 'approved' && receiptStatus !== 'completed' && research && <button disabled={busy}
        onClick={() => act(() => research(outbox.id))}>{receiptStatus === 'failed' ? 'Try again' : 'Send now'}
      </button>}</>}
    {message && (!outbox || (outbox.status === 'approved' && !receiptStatus)) && <p role="alert">{message}</p>}
  </section>;
}
