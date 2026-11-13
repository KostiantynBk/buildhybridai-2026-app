import { expect, it } from 'vitest';
import { overlaps } from '../eval/scoring';
import { overlapRatio } from './overlap';

it('agrees with frozen D-019 eligibility across fixtures and a seeded generated set', () => {
  const fixtures: Array<[string, string, string]> = [
    ['abcd', 'ab', 'bc'], ['abcde', 'ab', 'cd'], ['', '', ''], ['a a a', 'a', 'a'],
    ['A  B  a b', 'a b', ' B A '], ['abcdef', 'abcd', 'cdef'], ['abcabcabc', 'abc', 'bca'],
    ['zero words', 'absent', 'zero'], ['anything', '', 'thing'],
  ];
  expect(overlapRatio('abcd', 'ab', 'bc')).toBe(0.5);
  let seed = 0x12345678;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const alphabet = ['a', 'A', 'b', 'B', ' ', '  ', '\n', 'c'];
  for (let i = 0; i < 2000; i++) {
    let body = '';
    for (let j = 0, count = next() % 25; j < count; j++) body += alphabet[next() % alphabet.length];
    const fragment = () => {
      if (next() % 5 === 0) return '';
      const start = next() % (body.length + 1);
      const length = next() % (body.length + 1);
      const part = body.slice(start, start + length);
      return next() % 2 ? part.toUpperCase() : part.replace(/ /g, '  ');
    };
    fixtures.push([body, fragment(), fragment()]);
  }
  for (const [body, left, right] of fixtures) {
    expect(overlapRatio(body, left, right) >= 0.5).toBe(overlaps(body, left, right));
  }
});
