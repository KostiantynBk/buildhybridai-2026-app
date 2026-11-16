import { expect, it } from 'vitest';
import type { ProfileRecord } from '../store';
import { selectConcerns, type SelectionItem } from './selectConcerns';
import { TRIAGE_PROMPT_SET } from './triageVersion';

const statement: SelectionItem = { lineageId: 'l', version: 1, kind: 'assumption',
  quote: 'The plan uses one hosted server.', topics: ['hosting'] };
const record = (id: string, type: ProfileRecord['type'], depth?: ProfileRecord['depth']): ProfileRecord => ({
  id, type, text: `Exact ${id} text`, topics: ['hosting'], tags: [], updatedAt: 0, ...(depth ? { depth } : {}),
});
const choose = (profile: ProfileRecord[], concern = 'A specific concern long enough to display.') => selectConcerns({
  paragraph: statement.quote, items: [statement], concerns: [{ item: 1, angle: 'end-user', concern, checkable: true }],
  profile, used: [], angleCounts: {}, version: 'v2.1',
});
it('defaults to v2.1 and selects both the triggering lesson and scoring skill, lesson first', () => {
  expect(TRIAGE_PROMPT_SET).toBe('v2.1');
  const result = choose([record('skill', 'skill', 'new'), record('lesson', 'lesson'), record('pref', 'preference')]);
  expect(result.picked[0]).toMatchObject({ angle: 'track-record', profileRecordIds: ['lesson', 'skill'] });
});
it('shows only the lesson when the strongest skill is deep', () => {
  const result = choose([record('skill', 'skill', 'deep'), record('lesson', 'lesson'), record('pref', 'preference')]);
  expect(result.picked[0]).toMatchObject({ angle: 'track-record', profileRecordIds: ['lesson'] });
});
it('selects the skill that actually set unfamiliarity, with stable ties', () => {
  const result = choose([record('new', 'skill', 'new'), record('some-b', 'skill', 'some'),
    record('some-a', 'skill', 'some')]);
  expect(result.picked[0]).toMatchObject({ score: 1, profileRecordIds: ['some-a'] });
});
it('uses the skill on the topic that sets the maximum unfamiliarity', () => {
  const item = { ...statement, topics: ['hosting', 'payments'] };
  const payments = { ...record('payments', 'skill', 'deep'), topics: ['payments'] };
  const result = selectConcerns({ paragraph: item.quote, items: [item], concerns: [{ item: 1, angle: 'end-user',
    concern: 'A specific concern long enough to display.', checkable: true }],
    profile: [record('hosting', 'skill', 'new'), payments], used: [], angleCounts: {}, version: 'v2.1' });
  expect(result.picked[0]).toMatchObject({ score: 2, profileRecordIds: ['hosting'] });
});
it('uses a sharing preference only if no lesson or scoring skill applies', () => {
  const result = choose([record('pref', 'preference')]);
  expect(result.picked[0].profileRecordIds).toEqual(['pref']);
  expect(choose([]).picked[0].profileRecordIds).toEqual([]);
});
it('never shows a block for a zero-score brief, even with a matching preference', () => {
  const result = choose([record('deep', 'skill', 'deep'), record('pref', 'preference')]);
  expect(result.picked[0]).toMatchObject({ brief: true, profileRecordIds: [] });
});
it('holds a trimmed concern under 20 characters only in v2.1', () => {
  expect(choose([], '   1234567890123456789   ').held[0].reason).toBe('held back: incomplete');
  expect(choose([], '  12345678901234567890  ').picked).toHaveLength(1);
  const v2 = selectConcerns({ paragraph: statement.quote, items: [statement],
    concerns: [{ item: 1, angle: 'end-user', concern: 'The', checkable: true }], profile: [], used: [],
    angleCounts: {}, version: 'v2' });
  expect(v2.picked).toHaveLength(1);
});
