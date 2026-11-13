import { describe, expect, it } from 'vitest';
import notes from '../../eval/set-v1/notes.json';
import profiles from '../../eval/set-v1/profiles.json';
import { filterQuestion } from './leakFilter';

describe('deterministic question leak filter', () => {
  it.each(['€ 400', '$100', '£2', '¥ 8', '400 EUR', '2 euros', '100 USD', '5 dollars', '3 GBP', 'USD 23'])(
    'blocks currency %s', amount => expect(filterQuestion(`Is ${amount} typical?`, []).reasons).toContain('currency'),
  );
  it.each(['a@example.com', 'first.last+tag@sub.example.org'])(
    'blocks email %s', value => expect(filterQuestion(`Should I contact ${value}?`, []).reasons).toContain('email'),
  );
  it.each(['https://example.com/a', 'http://example.org', 'www.example.net', 'example.com/path'])(
    'blocks URL %s', value => expect(filterQuestion(`Does ${value} work?`, []).reasons).toContain('url'),
  );
  it('matches the local list case-insensitively and never returns the matched private term', () => {
    const result = filterQuestion('Could ACME CLIENT use this?', [' acme client ']);
    expect(result).toEqual({ passed: false, reasons: ['listed-term'] });
    expect(JSON.stringify(result)).not.toContain('ACME');
    expect(filterQuestion('A public question?', ['', '  '])).toEqual({ passed: true, reasons: [] });
  });
  it('blocks every invented note and profile private token by exact case-insensitive substring', () => {
    const tokens = [...notes.notes.flatMap(note => note.privateTokens),
      ...Object.values(profiles.profiles).flatMap(profile => profile.privateTokens)];
    expect(tokens.length).toBeGreaterThan(0);
    for (const token of tokens) {
      const result = filterQuestion(`Question mentioning ${token.toLocaleUpperCase('en')}?`, [], [token]);
      expect(result.passed, token).toBe(false);
      expect(result.reasons).toContain('private-token');
      expect(JSON.stringify(result)).not.toContain(token);
    }
  });
  it('passes ordinary public questions and collects multiple independent reasons', () => {
    expect(filterQuestion('Which database limits apply on a free plan?', [])).toEqual({ passed: true, reasons: [] });
    expect(filterQuestion('How does Node.js handle request queues?', [])).toEqual({ passed: true, reasons: [] });
    const result = filterQuestion('Ask alice@example.com about €50 and PRIVATE NAME', ['private name']);
    expect(result.passed).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining(['currency', 'email', 'listed-term']));
  });
});
