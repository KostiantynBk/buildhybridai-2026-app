import { expect, it } from 'vitest';
import { createService } from './service';

it('keeps one local service for the lifetime of the current page module', () => {
  expect(createService()).toBe(createService());
});
