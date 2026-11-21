import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { OutboxEntry } from '../store/triageTypes';
import { OutboxPage } from './OutboxPage';

it('deduplicates only idea description display without changing stored log entries', () => {
  const keptOut = ['Stripe', 'stripe', 'Stripe account', 'budget'];
  const idea: OutboxEntry = { id: 'i', kind: 'idea', ideaId: 'idea', question: 'A fictional description',
    keptOut, status: 'approved', createdAt: 1 };
  const question: OutboxEntry = { id: 'q', question: 'A fictional question?', keptOut: [...keptOut],
    status: 'approved', createdAt: 2 };
  const html = renderToStaticMarkup(<OutboxPage entries={[idea, question]} decide={async () => true}
    remove={async () => {}} />);
  expect(html).toContain('Left out of the description: Stripe account, budget');
  expect(html).toContain('Left out of the question: Stripe, stripe, Stripe account, budget');
  expect(idea.keptOut).toEqual(['Stripe', 'stripe', 'Stripe account', 'budget']);
});
