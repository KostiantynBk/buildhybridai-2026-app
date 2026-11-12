import { expect, it } from 'vitest';
import { canPrepare, modelLabel } from './StatusBar';

it('uses clear local readiness labels rather than raw state names', () => {
  expect(modelLabel({ kind: 'downloadable' })).toBe('not prepared yet');
  expect(modelLabel({ kind: 'downloading', progress: 0.4 })).toBe('downloading 40%');
  expect(modelLabel({ kind: 'warming' })).toBe('warming up');
  expect(modelLabel({ kind: 'ready' })).toBe('ready');
});

it('enables retry only when configured, visible and not already preparing', () => {
  const error = { kind: 'error', reason: 'failed' } as const;
  expect(canPrepare(true, true, false, error)).toBe(true);
  expect(canPrepare(true, true, false, { kind: 'unavailable' })).toBe(true);
  expect(canPrepare(false, true, false, error)).toBe(false);
  expect(canPrepare(true, false, false, error)).toBe(false);
  expect(canPrepare(true, true, true, error)).toBe(false);
  expect(canPrepare(true, true, false, { kind: 'ready' })).toBe(false);
});
