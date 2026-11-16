import { expect, it, vi } from 'vitest';
import type { Job } from '../ai/localModel';
import type { LocalRunner } from '../pipeline/extract';
import { anglesV21 } from '../pipeline/prompts/angles.v2.1';
import { questionV21 } from '../pipeline/prompts/question.v2.1';
import { whynoteV1 } from '../pipeline/prompts/whynote.v1';
import { whynoteV2 } from '../pipeline/prompts/whynote.v2';
import { demoProfile } from '../profile/profile';
import { runGate2, runPracticeV2 } from './run3';

function fakeRunner() {
  return vi.fn(async (job: Job<unknown>) => {
    let data: unknown;
    if (job.instructions === anglesV21) data = { concerns: [{ item: 1, angle: 'end-user',
      concern: 'A specific concern about public hosting limits.', checkable: true }] };
    else if (job.instructions === questionV21) data = { question: 'What are public hosting limits?', keptOut: [] };
    else {
      expect(job.instructions).not.toBe(whynoteV1);
      expect(job.instructions).not.toBe(whynoteV2);
      const quote = (job.prompt.split('Paragraph:\n')[1] ?? '').split(/[.!?]/)[0].trim();
      data = { items: [{ kind: 'assumption', text: 'Hosting assumption', quote, topics: ['hosting'] }] };
    }
    return { data, source: 'on_device', latencyMs: 1, raw: '{}' };
  });
}
it('runs the v2.1 27-pass accounting with record IDs and no profile in any prompt', async () => {
  const runner = fakeRunner();
  const run = await runGate2({ runner: runner as unknown as LocalRunner, signal: new AbortController().signal,
    onDeviceModel: 'synthetic', warmupLatencyMs: 1, rest: async () => {} });
  expect(run.complete).toBe(true);
  expect(run.total).toBe(27);
  expect(run.rows.filter(row => row.repetition === 1)).toHaveLength(17);
  expect(run.rows.filter(row => row.repetition > 1)).toHaveLength(10);
  expect(run.environment.triagePromptSet).toBe('v2.1');
  expect(run.environment.promptVersions).toEqual(['extract.v2', 'angles.v2.1', 'question.v2.1']);
  expect(run.rows.every(row => row.whynotes.length === 0)).toBe(true);
  expect(run.rows[0].picks.A[0].profileRecordIds?.length).toBeGreaterThan(0);
  expect(run.rows[0].profileBlocks[0].recordIds.length).toBeGreaterThan(0);
  for (const row of run.rows) for (const block of row.profileBlocks) {
    expect(block.records.map(record => record.id)).toEqual(block.recordIds);
    expect(block.recordIds.length).toBeLessThanOrEqual(2);
    if (block.recordIds.length === 2) {
      const source = demoProfile(block.profile);
      expect(source.find(record => record.id === block.recordIds[0])?.type).toBe('lesson');
      expect(source.find(record => record.id === block.recordIds[1])?.type).toBe('skill');
    }
  }
  const sample = (run.summary as { ratingSample: { profileA: unknown[]; profileB: unknown[]; whyA?: unknown[] } })
    .ratingSample;
  expect(sample.profileA).toHaveLength(6);
  expect(sample.profileB).toHaveLength(6);
  expect(sample.whyA).toBeUndefined();
  for (const [job] of runner.mock.calls) {
    for (const profile of ['A', 'B'] as const) for (const record of demoProfile(profile)) {
      expect(job.prompt).not.toContain(record.text);
    }
  }
  expect(runner.mock.calls.some(call => call[0].instructions === whynoteV1 ||
    call[0].instructions === whynoteV2)).toBe(false);
});
it('labels a fake practice export with the active v2.1 set and no why-note', async () => {
  const runner = fakeRunner();
  const run = await runPracticeV2({ runner: runner as unknown as LocalRunner, signal: new AbortController().signal,
    onDeviceModel: 'synthetic', warmupLatencyMs: null, rest: async () => {} });
  expect(run.complete).toBe(true);
  expect(run.total).toBe(7);
  expect(run.environment.triagePromptSet).toBe('v2.1');
  expect(run.environment.promptVersions).toEqual(['extract.v2', 'angles.v2.1', 'question.v2.1']);
  expect(run.rows.every(row => row.whynotes.length === 0)).toBe(true);
});
