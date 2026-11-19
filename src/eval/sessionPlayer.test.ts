import { expect, it } from 'vitest';
import { ALLOW_HELD_BACK, applySessionEdit, buildSessionStepLog, nextSessionEdit, prepareSessionStart,
  removeSessionTerms, sessionForPlay } from './sessionPlayer';
import { demoNeverSend, demoProfile } from '../profile/profile';
import type { ProfileRecord, Snapshot } from '../store';

it('records the required step evidence without copying the private list', () => {
  const baseline = { paragraphs: [], items: [], profile: [], jobs: [] } as Snapshot;
  const snapshot = { ...baseline, paragraphs: [{ id: 'p', version: 1 }], neverSend: ['SENTINEL_LIST'],
    items: [{ id: 'i', paragraphId: 'p', kind: 'assumption', quote: 'quote', topics: ['hosting'] }],
    jobs: [{ paragraphId: 'p', step: 'extract', promptVersion: 'extract.v2', status: 'done', attempts: 1 }],
    cards: [{ id: 'c', paragraphId: 'p', itemQuote: 'quote', angle: 'end-user', concern: 'concern', score: 1 }],
    outbox: [{ id: 'o', cardId: 'c', question: 'Question?', keptOut: ['name'], status: 'pending' },
      { id: 'idea', kind: 'idea', question: 'IDEA_EXPORT_SENTINEL', keptOut: [], status: 'approved' }],
    dependencies: [], lineages: [] } as unknown as Snapshot;
  const log = buildSessionStepLog(1, 100, 250, false, baseline, snapshot, [], []);
  expect(log.elapsedMs).toBe(150);
  expect(log.items).toHaveLength(1);
  expect(log.cards).toHaveLength(1);
  expect(log.outbox[0]).toMatchObject({ question: 'Question?', keptOut: ['name'], status: 'pending' });
  expect(log.jobs[0]).toMatchObject({ promptVersion: 'extract.v2' });
  expect(JSON.stringify(log)).not.toContain('SENTINEL_LIST');
  expect(JSON.stringify(log)).not.toContain('IDEA_EXPORT_SENTINEL');
});
it('refuses held-back S2 and S3 without a runtime override', () => {
  expect(ALLOW_HELD_BACK).toBe(false);
  expect(() => sessionForPlay('S2')).toThrow('held back');
  expect(() => sessionForPlay('S3')).toThrow('held back');
  expect(() => nextSessionEdit('S2', 1, '', {})).toThrow('held back');
});
it('adds scenario and demo terms as needed, and removal keeps prior terms', async () => {
  for (const profile of ['own', 'A', 'B'] as const) {
    let terms = ['Existing Secret', 's1 token'];
    let records: ProfileRecord[] = [];
    const writeTerms = async (value: string[]) => { terms = value; };
    const writeProfile = async (value: ProfileRecord[]) => { records = value; };
    const result = await prepareSessionStart(profile, records, terms, ['S1 Token', 'New S1 Token'], () => true,
      writeTerms, writeProfile);
    expect(result).not.toBeNull();
    expect(terms).toContain('Existing Secret');
    expect(terms).toContain('s1 token');
    expect(terms).toContain('New S1 Token');
    if (profile === 'own') {
      expect(result?.added).toEqual(['New S1 Token']);
      expect(records).toEqual([]);
    } else {
      for (const token of demoNeverSend(profile)) expect(terms).toContain(token);
      expect(records.map(record => record.id)).toEqual(demoProfile(profile).map(record => record.id));
    }
    await removeSessionTerms(terms, result!.added, writeTerms);
    expect(terms).toEqual(['Existing Secret', 's1 token']);
  }
});
it('cancels without writes and warns only for an actual profile replacement', async () => {
  const original = demoProfile('B', 0);
  let terms = ['Original'];
  let records = original;
  const writeTerms = async (value: string[]) => { terms = value; };
  const writeProfile = async (value: ProfileRecord[]) => { records = value; };
  let shown = '';
  const cancelled = await prepareSessionStart('A', records, terms, ['S1 token'], message => {
    shown = message; return false;
  }, writeTerms, writeProfile);
  expect(cancelled).toBeNull();
  expect(shown).toContain('This replaces your current profile: skills, projects and lessons');
  expect(shown).toContain('Profile → Export first');
  expect(terms).toEqual(['Original']);
  expect(records).toBe(original);
  await prepareSessionStart('B', records, terms, ['SS'], message => {
    shown = message; return false;
  }, writeTerms, writeProfile);
  expect(shown).not.toContain('This replaces your current profile');
  expect(shown).toContain('short terms');
  expect(shown).toContain('SS');
  await expect(prepareSessionStart('own', records, Array.from({ length: 200 }, (_, i) => `term${i}`),
    ['extra'], () => true, writeTerms, writeProfile)).rejects.toThrow('exceeds 200');
  expect(terms).toEqual(['Original']);
});
it('builds S1 writes and replaces the intended earlier paragraph without losing other text', () => {
  let called = '';
  applySessionEdit(nextSessionEdit('S1', 1, '', {}), value => { called = value; });
  expect(called).toContain(sessionForPlay('S1').steps[0].text);
  let text = '';
  let blocks: Record<number, string> = {};
  for (const step of [1, 2, 3, 4, 5, 6, 7]) {
    const next = nextSessionEdit('S1', step, text, blocks);
    text = next.text; blocks = next.blocks;
  }
  const session = sessionForPlay('S1');
  expect(text).toContain(session.steps[4].text);
  expect(text).toContain(session.steps[5].text);
  expect(text).toContain(session.steps[6].text);
  expect(text).not.toContain(session.steps[0].text);
  expect(text).not.toContain(session.steps[1].text);
  expect(() => nextSessionEdit('S1', 5, 'unrelated text', blocks)).toThrow('missing or ambiguous');
});
