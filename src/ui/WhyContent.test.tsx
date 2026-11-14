import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { ProfileRecord } from '../store';
import type { ThoughtCard } from '../store/triageTypes';
import { WhyContent } from './NotebookPanel';

it('renders exact cited profile text even when the v2 why sentence was dropped', () => {
  const card = { triageVersion: 'v2', why: { seeing: 'You are planning.', why: '', used: ['a'] } } as ThoughtCard;
  const profile = [{ id: 'a', type: 'skill', text: 'Original words, including punctuation!\nSecond line.',
    topics: [], tags: [],
    depth: 'new', updatedAt: 0 }] as ProfileRecord[];
  const html = renderToStaticMarkup(<WhyContent card={card} profile={profile} />);
  expect(html).toContain('You are planning.');
  expect(html).toContain('From your profile:');
  expect(html).toContain('Original words, including punctuation!\nSecond line.');
  expect(html).toContain('white-space:pre-wrap');
  const none = renderToStaticMarkup(<WhyContent card={{ ...card, why: { ...card.why!, used: [] } }}
    profile={profile} />);
  expect(none).not.toContain('From your profile:');
});
