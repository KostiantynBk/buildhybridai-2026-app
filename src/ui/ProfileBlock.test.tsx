import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { ProfileRecord } from '../store';
import type { ThoughtCard } from '../store/triageTypes';
import { ProfileBlock } from './NotebookPanel';

it('renders current selected records verbatim and reflects edits or deletions without a model', () => {
  const card = { triageVersion: 'v2.1', brief: false, profileRecordIds: ['lesson', 'a'] } as ThoughtCard;
  const record = { id: 'a', type: 'skill', text: 'Original & exact\nSecond line', depth: 'new',
    topics: ['hosting'], tags: [], updatedAt: 0 } as ProfileRecord;
  const lesson = { id: 'lesson', type: 'lesson', text: 'Lesson first', topics: ['hosting'], tags: [],
    updatedAt: 0 } as ProfileRecord;
  const render = (profile: ProfileRecord[]) => renderToStaticMarkup(<ProfileBlock card={card} profile={profile} />);
  const original = render([record, lesson]);
  expect(original).toContain('From your profile');
  expect(original).toContain('Original &amp; exact\nSecond line');
  expect(original).toContain('white-space:pre-wrap');
  expect(original.indexOf('Lesson first')).toBeLessThan(original.indexOf('Original &amp; exact'));
  const edited = render([{ ...record, text: 'Changed exact text' }, lesson]);
  expect(edited).toContain('Changed exact text');
  expect(edited).not.toContain('Original');
  const oneDeleted = render([lesson]);
  expect(oneDeleted).toContain('Lesson first');
  expect(oneDeleted).not.toContain('Original');
  expect(render([])).toBe('');
  expect(renderToStaticMarkup(<ProfileBlock card={{ ...card, brief: true }} profile={[record]} />)).toBe('');
});
