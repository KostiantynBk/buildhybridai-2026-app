import { expect, it, vi } from 'vitest';
import type { ProfileRecord } from '../store';
import type { Job } from '../ai/localModel';
import { runAngles, runQuestion, runWhyNote, chooseProfileRecords, type TriageItem } from './triage';
import type { LocalRunner } from './extract';
import { anglesV2 } from './prompts/angles.v2';
import { questionV2 } from './prompts/question.v2';
import { whynoteV2 } from './prompts/whynote.v2';

const item: TriageItem = { lineageId: 'l', version: 1, kind: 'assumption', text: 'A statement',
  quote: 'the selected words', topics: ['hosting'] };
const profile: ProfileRecord[] = [{ id: 's', type: 'skill', depth: 'new', text: 'PROFILE_SENTINEL',
  topics: ['hosting'], tags: [], updatedAt: 0 }];
it('keeps profile, never-send terms and paragraph-only content out of angles/question prompts', async () => {
  const run = vi.fn(async job => ({ data: job.instructions === anglesV2
    ? { concerns: [{ item: 1, angle: 'end-user', concern: 'A concern', checkable: true }] }
    : { question: 'What are the hosting limits?', keptOut: ['client name', 'PRIVATE_LIST_SENTINEL'] },
  source: 'on_device', latencyMs: 1, raw: '{}' }));
  const runner = run as unknown as LocalRunner;
  const itemWithProfile = { ...item, profile };
  const angles = await runAngles(runner, 'the selected words PARAGRAPH_ONLY_SENTINEL', [itemWithProfile]);
  expect(angles.concerns).toHaveLength(1);
  const question = await runQuestion(runner, itemWithProfile, 'end-user', 'A concern', ['PRIVATE_LIST_SENTINEL']);
  expect(question.keptOut).toEqual(['client name']);
  expect(question.leak.passed).toBe(true);
  expect(run.mock.calls[0][0].instructions).toBe(anglesV2);
  expect(run.mock.calls[1][0].instructions).toBe(questionV2);
  for (const call of run.mock.calls) {
    expect(call[0].prompt).not.toContain('PROFILE_SENTINEL');
    expect(call[0].prompt).not.toContain('PRIVATE_LIST_SENTINEL');
  }
  expect(run.mock.calls[1][0].prompt).not.toContain('PARAGRAPH_ONLY_SENTINEL');
  expect(run.mock.calls[1][0].prompt).toContain('A statement');
  expect(run.mock.calls[1][0].prompt).not.toContain('{item.text}');
});
it('chooses up to three profile records by shared topics, lesson then skill then id', () => {
  const record = (id: string, type: ProfileRecord['type'], topics: string[]): ProfileRecord => ({ id, type,
    text: id, topics, tags: [], updatedAt: 0, ...(type === 'skill' ? { depth: 'some' as const } : {}) });
  const values = [record('p', 'project', ['hosting', 'payments']), record('s', 'skill', ['hosting']),
    record('l2', 'lesson', ['hosting']), record('l1', 'lesson', ['hosting']), record('x', 'preference', ['other'])];
  expect(chooseProfileRecords(['hosting', 'payments'], values).map(value => value.id)).toEqual(['p', 'l1', 'l2']);
});
it('reserves the triggering track-record lesson even when three records share more topics', async () => {
  const records: ProfileRecord[] = ['a', 'b', 'c'].map(id => ({ id, type: 'skill', depth: 'deep', text: id,
    topics: ['hosting', 'payments'], tags: [], updatedAt: 0 }));
  records.push({ id: 'lesson', type: 'lesson', text: 'LESSON_SENTINEL', topics: ['hosting'], tags: [], updatedAt: 0 });
  expect(chooseProfileRecords(['hosting', 'payments'], records, 'lesson').map(record => record.id))
    .toEqual(['lesson', 'a', 'b']);
  const runner = vi.fn(async (_job: Job<unknown>) => ({
    data: { seeing: 'You plan hosting.', why: 'A reason.', used: [] },
    source: 'on_device', latencyMs: 1, raw: '{}' }));
  await runWhyNote(runner as unknown as LocalRunner, 'quote', 'track-record', 'Concern', 'Question',
    ['hosting', 'payments'], records, undefined, 'lesson');
  expect(runner.mock.calls[0][0].prompt).toContain('LESSON_SENTINEL');
});
it('allows the selected profile only in why-note, strips unknown IDs and rejects non-You seeing', async () => {
  const runner = vi.fn(async (_job: Job<unknown>) => ({ data: { seeing: 'You are planning hosting.', why: 'A reason.',
    used: ['s', 'unknown'] }, source: 'on_device', latencyMs: 1, raw: '{}' }));
  const output = await runWhyNote(runner as unknown as LocalRunner, item.quote, 'end-user', 'A concern',
    'A public question?', item.topics, profile);
  expect(output.note?.used).toEqual(['s']);
  expect(runner.mock.calls[0][0].prompt).toContain('PROFILE_SENTINEL');
  expect(runner.mock.calls[0][0].instructions).toBe(whynoteV2);
  expect(runner.mock.calls[0][0].prompt).not.toContain('{one line per record:');
  runner.mockResolvedValueOnce({ data: { seeing: 'The builder plans hosting.', why: 'A reason.', used: ['s'] },
    source: 'on_device', latencyMs: 1, raw: '{}' });
  expect((await runWhyNote(runner as unknown as LocalRunner, item.quote, 'end-user', 'Concern',
    'Question?', item.topics, profile)).note).toBeNull();
});
it('makes no angles call without eligible quotes and rejects cloud sources', async () => {
  const runner = vi.fn(async () => ({ data: { concerns: [] }, source: 'in_cloud', latencyMs: 1, raw: '{}' }));
  expect((await runAngles(runner as unknown as LocalRunner, 'Different paragraph', [item])).source).toBe('code');
  expect(runner).not.toHaveBeenCalled();
  await expect(runAngles(runner as unknown as LocalRunner, 'the selected words', [item]))
    .rejects.toMatchObject({ code: 'privacy-fault' });
});
