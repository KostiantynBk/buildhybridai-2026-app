import { expect, it, vi } from 'vitest';
// This regression explicitly exercises the pinned v2 path.
vi.mock('./triageVersion', async importOriginal => ({
  ...(await importOriginal<typeof import('./triageVersion')>()), TRIAGE_PROMPT_SET: 'v2',
}));

import type { ProfileRecord } from '../store';
import type { Job } from '../ai/localModel';
import type { LocalRunner } from './extract';
import { runAngles, runQuestion, runWhyNote, type TriageItem } from './triage';
import { selectConcerns } from './selectConcerns';
import { anglesV2 } from './prompts/angles.v2';
import { questionV2 } from './prompts/question.v2';
import { whynoteV2 } from './prompts/whynote.v2';
import demoProfiles from '../../eval/set-v1/profiles.json';

const item: TriageItem = { lineageId: 'l', version: 1, kind: 'open-question', text: 'Can customers get refunds?',
  quote: 'Can customers get refunds?', topics: ['payments'] };
const profile = (text: string): ProfileRecord[] => [{ id: 's', type: 'skill', depth: 'some', text,
  topics: ['payments'], tags: [], updatedAt: 0 }];
const out = (data: unknown) => ({ data, source: 'on_device', latencyMs: 1, raw: '{}' });
it('sends open questions to v2 angles but not to v1', async () => {
  const run = vi.fn(async (_job: Job<unknown>) => out({ concerns: [] }));
  const v1 = await runAngles(run as unknown as LocalRunner, item.quote, [item], undefined, undefined, 'v1');
  expect(v1.items).toHaveLength(0);
  expect(run).not.toHaveBeenCalled();
  const v2 = await runAngles(run as unknown as LocalRunner, item.quote, [item], undefined, undefined, 'v2');
  expect(v2.items).toHaveLength(1);
  expect(run.mock.calls[0][0].instructions).toBe(anglesV2);
  expect(run.mock.calls[0][0].prompt).toContain('(open-question) Can customers get refunds?');
});
it('holds alternatives on decisions but not assumptions in v2', () => {
  const concern = { item: 1, angle: 'alternatives' as const, concern: 'Try another approach?', checkable: true };
  const run = (kind: string, version: 'v1' | 'v2') => selectConcerns({ paragraph: item.quote,
    items: [{ ...item, kind }], concerns: [concern], profile: [], used: [], angleCounts: {}, version });
  expect(run('decision', 'v2').held[0].reason).toBe('held back: decision respected');
  expect(run('assumption', 'v2').picked).toHaveLength(1);
  expect(run('decision', 'v1').picked).toHaveLength(1);
});
it.each([
  ['You have not handled refunds before.', 'Built payment workflows.', true],
  ['You have not handled refunds before.', 'Built notification pipelines.', true],
  ['You have not handled refunds before.', 'A cafénot prototype.', true],
  ['You have never used an AI provider.', demoProfiles.profiles.B.records.find(value => value.id === 'B-l2')!.text,
    true],
  ['This matters whenever load changes.', 'Built payment workflows.', false],
  ['You haven’t shipped an app.', 'has never shipped an iOS or Android app', false],
  ['You have not shipped an app.', 'I didn’t ship an app.', false],
  ['You have not shipped an app.', "I didn't ship an app.", false],
  ["You HAVEN'T handled refunds before.", 'Built payment workflows.', true],
  ['This has not been done by you.', 'Built payment workflows.', true],
  ['You never handled refunds.', 'Built payment workflows.', true],
  ['This happened without you.', 'Built payment workflows.', true],
  ['You have not handled refunds before.', 'I have never handled refunds.', false],
  ['You have not handled refunds before.', "I haven't handled refunds before.", false],
  ['You have not handled refunds before.', "I DIDN'T handle consumer refunds.", false],
  ['You have not handled refunds before.', 'NOT: unrelated detail.', false],
  ['This question matters for your payment plan.', 'Built payment workflows.', false],
])('guards negative why-claims against cited record text', async (why, record, dropped) => {
  const run = vi.fn(async (_job: Job<unknown>) => out({ seeing: 'You have a question.', why, used: ['s'] }));
  const result = await runWhyNote(run as unknown as LocalRunner, item.quote, 'end-user', 'Concern', 'Question?',
    item.topics, profile(record), undefined, null, undefined, item.kind, 'v2');
  expect(result.whyDropped).toBe(dropped);
  expect(result.note).toMatchObject({ seeing: 'You have a question.', why: dropped ? '' : why, used: ['s'] });
  expect(run.mock.calls[0][0].instructions).toBe(whynoteV2);
  expect(run.mock.calls[0][0].prompt).toContain('Kind: open-question');
});
it('does not use uncited or unknown records as negative evidence', async () => {
  const records = [...profile('Built payment workflows.'), { ...profile('I never shipped an app.')[0], id: 'other' }];
  const run = vi.fn(async (_job: Job<unknown>) => out({ seeing: 'You have a question.',
    why: 'You have not handled refunds before.', used: ['s', 'unknown'] }));
  const result = await runWhyNote(run as unknown as LocalRunner, item.quote, 'end-user', 'Concern', 'Question?',
    item.topics, records, undefined, null, undefined, item.kind, 'v2');
  expect(result.whyDropped).toBe(true);
  expect(result.note).toMatchObject({ seeing: 'You have a question.', why: '', used: ['s'] });
});
it('leaves legacy v1 why-note behavior and template unchanged', async () => {
  const run = vi.fn(async (_job: Job<unknown>) => out({ seeing: 'You have a question.',
    why: 'You have not handled refunds before.', used: ['s'] }));
  const result = await runWhyNote(run as unknown as LocalRunner, item.quote, 'end-user', 'Concern', 'Question?',
    item.topics, profile('Built payment workflows.'), undefined, null, undefined, item.kind, 'v1');
  expect(result.whyDropped).toBe(false);
  expect(result.note?.why).toBe('You have not handled refunds before.');
  expect(run.mock.calls[0][0].prompt).not.toContain('Kind:');
});
it('keeps profile and list sentinels out of v2 angles and public question prompts', async () => {
  const input = { ...item, profile: profile('PROFILE_SENTINEL') };
  const run = vi.fn(async (job: Job<unknown>) => out(job.instructions === anglesV2 ? { concerns: [] }
    : { question: 'What are the refund rules?', keptOut: [] }));
  const runner = run as unknown as LocalRunner;
  await runAngles(runner, item.quote, [input]);
  await runQuestion(runner, input, 'end-user', 'A concern', ['LIST_SENTINEL']);
  expect(run.mock.calls[0][0].instructions).toBe(anglesV2);
  expect(run.mock.calls[1][0].instructions).toBe(questionV2);
  for (const call of run.mock.calls) {
    expect(call[0].prompt).not.toContain('PROFILE_SENTINEL');
    expect(call[0].prompt).not.toContain('LIST_SENTINEL');
  }
});
