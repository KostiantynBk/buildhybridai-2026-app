import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { StorageNotice } from './App';
import { STORAGE_BLOCKED_NOTICE, STORAGE_OUTDATED_NOTICE } from './storageNotices';

it('renders blocked and outdated storage notices as alerts', () => {
  const blocked = renderToStaticMarkup(<StorageNotice notice={STORAGE_BLOCKED_NOTICE} />);
  expect(blocked).toContain('role="alert"');
  expect(blocked).toContain('Close other ThoughtPartner tabs to finish updating, then reload.');
  expect(renderToStaticMarkup(<StorageNotice notice={STORAGE_OUTDATED_NOTICE} />))
    .toContain('This tab is out of date. Reload.');
  expect(renderToStaticMarkup(<StorageNotice notice="" />)).toBe('');
});
