import { describe, expect, it } from 'vitest';
import { demoProfile, exportProfile, importProfile, profileWarnings, TOPICS, validateRecord } from './profile';

const base = { id: 'test-1', type: 'skill', depth: 'some', text: 'My experience', topics: ['frontend'],
  tags: [' React ', 'TYPESCRIPT'], updatedAt: 1 };
describe('local profile', () => {
  it('validates record types, skill depth, fixed topics and normalized tags', () => {
    expect(validateRecord(base).tags).toEqual(['react', 'typescript']);
    expect(() => validateRecord({ ...base, type: 'unknown' })).toThrow();
    expect(() => validateRecord({ ...base, type: 'project' })).toThrow();
    expect(() => validateRecord({ ...base, depth: 'strong' })).toThrow();
    expect(() => validateRecord({ ...base, topics: ['not-a-topic'] })).toThrow();
    expect(() => validateRecord({ ...base, tags: ['1', '2', '3', '4', '5', '6'] })).toThrow();
    expect(TOPICS).toHaveLength(17);
  });
  it('round trips exports and safely rejects malformed or duplicate imports', () => {
    const record = validateRecord(base);
    expect(importProfile(exportProfile([record]))).toEqual([record]);
    expect(() => importProfile('{')).toThrow();
    expect(() => importProfile(JSON.stringify({ version: 1, records: [record, record] }))).toThrow();
    expect(() => importProfile(JSON.stringify({ version: 2, records: [] }))).toThrow();
    expect(() => importProfile(JSON.stringify({ version: 1, records: [{ ...record, tags: [2] }] }))).toThrow();
  });
  it('warns rather than blocks above 40 records or 6,000 text characters', () => {
    const record = validateRecord(base);
    expect(profileWarnings(Array.from({ length: 41 }, (_, i) => ({ ...record, id: String(i) })))).toHaveLength(1);
    expect(profileWarnings([{ ...record, text: 'x'.repeat(6001), tags: [] }])).toHaveLength(1);
    expect(profileWarnings([{ ...record, text: 'x'.repeat(6000), tags: [] }])).toHaveLength(0);
    const tagged = validateRecord({ ...base, text: 'x', tags: ['z'.repeat(6001)] });
    expect(profileWarnings([tagged])).toHaveLength(1);
    expect(tagged.tags[0]).toHaveLength(6001);
  });
  it('maps the unchanged synthetic A/B data to current skill-depth terms', () => {
    expect(demoProfile('A')).toHaveLength(11);
    expect(demoProfile('B')).toHaveLength(12);
    expect(demoProfile('A').find(r => r.id === 'A-s1')?.depth).toBe('deep');
    expect(demoProfile('A').find(r => r.id === 'A-s3')?.depth).toBe('new');
  });
});
