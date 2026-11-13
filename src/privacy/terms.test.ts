import { expect, it } from 'vitest';
import { validateNeverSend } from './terms';
import { demoNeverSend, exportProfile, importProfileBundle } from '../profile/profile';

it('trims, deduplicates case-insensitively, accepts short terms and rejects excess without truncation', () => {
  expect(validateNeverSend(['  Acme  ', 'ACME', 'AI', '', ' client '])).toEqual(['Acme', 'AI', 'client']);
  expect(() => validateNeverSend(['x'.repeat(101)])).toThrow('100');
  expect(() => validateNeverSend(Array.from({ length: 201 }, (_, index) => `term-${index}`))).toThrow('200');
});
it('round-trips the private list in local profile exports and accepts old profile format', () => {
  const terms = ['private one', 'private two'];
  expect(importProfileBundle(exportProfile([], terms))).toEqual({ records: [], neverSend: terms });
  expect(importProfileBundle('{"version":1,"records":[]}')).toEqual({ records: [], neverSend: [] });
  expect(() => importProfileBundle('{"version":1,"records":[],"neverSend":[10]}')).toThrow();
  expect(demoNeverSend('A')).toContain('Calder & Finch');
  expect(demoNeverSend('B')).toContain('Harrowby Telecom');
});
