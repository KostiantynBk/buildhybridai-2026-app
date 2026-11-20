import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { StateGallery } from './StateGallery';

it('renders real fake-fixture card and idea containers, including proof and uncertainty states', () => {
  const html = renderToStaticMarkup(<StateGallery />);
  expect(html).toContain('Worth checking');
  expect(html).toContain('question held back: private detail');
  expect(html).toContain('ThoughtPartner found nothing it could look up');
  expect(html).toContain('FAKE placeholder research text.');
  expect(html).toContain('Searching the web');
  expect(html).toContain('Your plan changed since this was checked.');
  expect(html).toContain('We couldn&#x27;t confirm this still matches your plan.');
  expect(html).toContain('Mode changed, draft again.');
  expect(html).toContain('Cloud processing is disabled.');
  expect(html).toContain('FAKE storage error for design review.');
  expect(html).not.toContain('Add at least three current statements first.');
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  expect(new Set(ids).size).toBe(ids.length);
  expect(html).not.toContain('id="notebook"');
  expect(html).toMatch(/<button disabled="">Send this question<\/button>/);
  expect(html).toMatch(/<button disabled="">Don&#x27;t send<\/button>/);
  expect(html).toMatch(/<button disabled="">Reopen<\/button>/);
});
