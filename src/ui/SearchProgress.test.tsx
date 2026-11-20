import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { OutboxEntry, ThoughtCard } from '../store/triageTypes';
import { DraftControls } from './DraftControls';
import { OutboxPage } from './OutboxPage';

const card = { id: 'c', questionStatus: 'ready', draftQuestion: 'A fake question?' } as ThoughtCard;
const entry: OutboxEntry = { id: 'e', cardId: 'c', itemLineageId: 'l', itemVersion: 1,
  question: 'A fake question?', keptOut: [], status: 'approved', createdAt: 1 };
const research = async () => {};
it('distinguishes unsent and actually searching in question controls and Outbox', () => {
  const held = renderToStaticMarkup(<DraftControls card={card} outbox={entry} research={research} />);
  expect(held).toContain('Approved, not sent.');
  expect(held).not.toContain('Searching the web');
  const active = renderToStaticMarkup(<DraftControls card={card} outbox={entry} research={research} searching />);
  expect(active).toContain('Searching the web');
  expect(active).not.toContain('Approved, not sent');
  expect(active).not.toContain('Send now');
  const outbox = renderToStaticMarkup(<OutboxPage entries={[entry]} decide={async () => true} remove={async () => {}}
    research={research} searching={{ e: true }} />);
  expect(outbox).toContain('Searching the web');
  expect(outbox).not.toContain('Approved, not sent');
  expect(outbox).not.toContain('Research this question');
});
