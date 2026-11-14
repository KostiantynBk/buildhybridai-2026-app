import { expect, it, vi } from 'vitest';
import type { Job } from '../ai/localModel';
import { anglesV2 } from '../pipeline/prompts/angles.v2';
import { questionV2 } from '../pipeline/prompts/question.v2';
import { whynoteV2 } from '../pipeline/prompts/whynote.v2';
import { anglesV1 } from '../pipeline/prompts/angles.v1';
import { questionV1 } from '../pipeline/prompts/question.v1';
import { whynoteV1 } from '../pipeline/prompts/whynote.v1';
import type { LocalRunner } from '../pipeline/extract';
import { runGate2, runPracticeV2 } from './run3';

function syntheticRunner() {
  return vi.fn(async (job: Job<unknown>) => {
    let data: unknown;
    if (job.instructions === anglesV2) data = { concerns: [{ item: 1, angle: 'end-user',
      concern: 'Could the builder check public limits?', checkable: true }] };
    else if (job.instructions === questionV2) data = { question: 'What limits apply to Leora?', keptOut: [] };
    else if (job.instructions === whynoteV2) {
      data = { seeing: 'You are planning a product.', why: 'It matters.', used: [] };
    }
    else {
      const paragraph = job.prompt.split('Paragraph:\n')[1] ?? '';
      const quote = paragraph.split(/[.!?]/)[0].trim();
      data = { items: [{ kind: 'assumption', text: 'A plan assumption', quote, topics: ['frontend', 'payments'] }] };
    }
    return { data, source: 'on_device', latencyMs: 1, raw: '{}' };
  });
}
it('runs 27 passes with 17 baseline-only metrics and a reproducible rating sample', async () => {
  const run = async () => {
    const runner = syntheticRunner();
    let clock = 0;
    const result = await runGate2({ runner: runner as unknown as LocalRunner, signal: new AbortController().signal,
      onDeviceModel: 'synthetic model', warmupLatencyMs: 1, rest: async () => {}, now: () => ++clock,
      chromeVersion: 'test' });
    return { result, runner };
  };
  const first = await run();
  const second = await run();
  expect(first.result.complete).toBe(true);
  expect(first.result.total).toBe(27);
  expect(first.result.rows.filter(row => row.repetition === 1)).toHaveLength(17);
  expect(first.result.rows.filter(row => row.repetition > 1)).toHaveLength(10);
  expect(first.result.environment.promptVersions).toEqual(['extract.v2', 'angles.v2', 'question.v2', 'whynote.v2']);
  expect(first.result.rows.every(row => row.extractedItems[0]?.kind === 'assumption')).toBe(true);
  const summary = first.result.summary as { baselineNotes: number; questions: number; privateBefore: number;
    privateAfter: number; ratingSample: { concerns: unknown[]; questions: unknown[];
      whyA: unknown[]; whyB: unknown[] } };
  expect(summary.baselineNotes).toBe(17);
  expect(summary.questions).toBe(17);
  expect(summary.privateBefore).toBeGreaterThan(0);
  expect(summary.privateAfter).toBe(0);
  expect(summary.ratingSample.concerns).toHaveLength(15);
  expect(summary.ratingSample.questions).toHaveLength(10);
  expect(summary.ratingSample.whyA).toHaveLength(6);
  expect(summary.ratingSample.whyB).toHaveLength(6);
  expect((second.result.summary as typeof summary).ratingSample).toEqual(summary.ratingSample);
  expect(first.result.environment.rulings).toMatchObject({ notePasses: 27, baselineOnlyMetrics: true,
    briefQuestion: true, briefWhyNote: false });
  expect(first.runner.mock.calls.filter(call => call[0].instructions === anglesV2)).toHaveLength(27);
  expect(first.runner.mock.calls.filter(call => call[0].instructions === questionV2)).toHaveLength(27);
  expect(JSON.stringify(first.result)).not.toContain('Calder & Finch');
});
it('shares each distinct concern question across profiles without mismatching why-note inputs', async () => {
  const runner = vi.fn(async (job: Job<unknown>) => {
    let data: unknown;
    if (job.instructions === anglesV2) data = { concerns: [
      { item: 1, angle: 'end-user', concern: 'Concern frontend', checkable: true },
      { item: 2, angle: 'limits-operations', concern: 'Concern backend', checkable: true },
    ] };
    else if (job.instructions === questionV2) data = { question: job.prompt.includes('Concern frontend')
      ? 'What is the frontend limit?' : 'What is the backend limit?', keptOut: [] };
    else if (job.instructions === whynoteV2) {
      const frontend = job.prompt.includes('Concern frontend');
      expect(job.prompt).toContain(frontend ? 'What is the frontend limit?' : 'What is the backend limit?');
      data = { seeing: 'You are building.', why: 'It matters.', used: [] };
    } else {
      const quote = (job.prompt.split('Paragraph:\n')[1] ?? '').split(/[.!?]/)[0].trim();
      data = { items: [{ kind: 'assumption', text: 'frontend item', quote: quote.slice(0, 20), topics: ['frontend'] },
        { kind: 'assumption', text: 'backend item', quote: quote.slice(-20), topics: ['backend'] }] };
    }
    return { data, source: 'on_device', latencyMs: 1, raw: '{}' };
  });
  const result = await runGate2({ runner: runner as unknown as LocalRunner, signal: new AbortController().signal,
    onDeviceModel: 'model', warmupLatencyMs: null, rest: async () => {} });
  expect(result.complete).toBe(true);
  expect(result.rows[0].questions).toHaveLength(2);
  expect(result.rows[0].whynotes).toHaveLength(2);
  expect(result.rows[0].picks.A.some(pick => pick.brief)).toBe(true);
  expect(result.rows[0].picks.B.some(pick => pick.brief)).toBe(true);
  expect((result.summary as { topPickDiffers: number }).topPickDiffers).toBe(17);
  expect(runner.mock.calls.filter(call => call[0].instructions === questionV2)).toHaveLength(54);
});
it('can still run the v1 triage set when the code-selected version is v1', async () => {
  const runner = vi.fn(async (job: Job<unknown>) => {
    const data = job.instructions === anglesV1 ? { concerns: [{ item: 1, angle: 'end-user',
      concern: 'A concern', checkable: true }] } : job.instructions === questionV1
      ? { question: 'What are the public limits?', keptOut: [] } : job.instructions === whynoteV1
        ? { seeing: 'You are planning.', why: 'It matters.', used: [] } : { items: [
          { kind: 'assumption', text: 'A plan item',
            quote: (job.prompt.split('Paragraph:\n')[1] ?? '').split(/[.!?]/)[0].trim(), topics: ['payments'] },
        ] };
    return { data, source: 'on_device', latencyMs: 1, raw: '{}' };
  });
  const result = await runGate2({ runner: runner as unknown as LocalRunner, signal: new AbortController().signal,
    onDeviceModel: 'model', warmupLatencyMs: null, rest: async () => {}, version: 'v1' });
  expect(result.complete).toBe(true);
  expect(result.environment.promptVersions).toEqual(['extract.v2', 'angles.v1', 'question.v1', 'whynote.v1']);
  expect(runner.mock.calls.some(call => call[0].instructions === anglesV2)).toBe(false);
});
it('reports v2-only counts on baseline notes without changing gate thresholds', async () => {
  const runner = vi.fn(async (job: Job<unknown>) => {
    let data: unknown;
    if (job.instructions === anglesV2) data = { concerns: [
      { item: 1, angle: 'alternatives', concern: 'Another option?', checkable: true },
      { item: 2, angle: 'end-user', concern: 'A private opinion?', checkable: false },
      { item: 2, angle: 'limits-operations', concern: 'What are the limits?', checkable: true },
    ] };
    else if (job.instructions === questionV2) data = { question: 'What are the public limits?', keptOut: [] };
    else if (job.instructions === whynoteV2) data = { seeing: 'You are planning.',
      why: 'You have not done this before.', used: [] };
    else {
      const quote = (job.prompt.split('Paragraph:\n')[1] ?? '').split(/[.!?]/)[0].trim();
      data = { items: [{ kind: 'decision', text: 'A decision', quote: quote.slice(0, 20), topics: ['payments'] },
        { kind: 'open-question', text: 'A question', quote: quote.slice(-20), topics: ['payments'] }] };
    }
    return { data, source: 'on_device', latencyMs: 1, raw: '{}' };
  });
  const result = await runGate2({ runner: runner as unknown as LocalRunner, signal: new AbortController().signal,
    onDeviceModel: 'model', warmupLatencyMs: null, rest: async () => {} });
  expect(result.complete).toBe(true);
  const reported = (result.summary as { reportedOnly: { notesWithNoCard: number; checkable: number;
    concerns: number; checkableShare: number; openQuestionItemsSent: number; decisionRespectedHolds: number;
    whyNotesDropped: number } }).reportedOnly;
  expect(reported).toEqual({ notesWithNoCard: 0, checkable: 34, concerns: 51, checkableShare: 34 / 51,
    openQuestionItemsSent: 17, decisionRespectedHolds: 17, whyNotesDropped: 34 });
});
it('runs only approved practice notes and refuses scored-set IDs', async () => {
  const fake = syntheticRunner();
  const runner = fake as unknown as LocalRunner;
  const options = { runner, signal: new AbortController().signal, onDeviceModel: 'synthetic',
    warmupLatencyMs: null, rest: async () => {} };
  await expect(runPracticeV2({ ...options, ids: ['n01'] })).rejects.toThrow('Only approved practice notes');
  expect(fake).not.toHaveBeenCalled();
  const result = await runPracticeV2(options);
  expect(result.mode).toBe('practice-v2');
  expect(result.complete).toBe(true);
  expect(result.total).toBe(7);
  expect(result.rows.map(row => row.noteId)).toEqual(['p1', 'p2', 'p3', 'p4', 'd1', 'd2', 'd3']);
  expect(result.rows.every(row => row.extractedItems.length > 0)).toBe(true);
  expect(result.summary).toMatchObject({ unscored: true, completedNotes: 7 });
  expect(result.environment.promptVersions).toEqual(['extract.v2', 'angles.v2', 'question.v2', 'whynote.v2']);
});
it('retains partial data after cancellation and stops on a cloud-sourced response', async () => {
  const controller = new AbortController();
  const runner = syntheticRunner() as unknown as LocalRunner;
  const cancelled = await runGate2({ runner, signal: controller.signal, onDeviceModel: 'model', warmupLatencyMs: null,
    rest: async () => {}, onUpdate: () => controller.abort() });
  expect(cancelled.complete).toBe(false);
  expect(cancelled.reason).toBe('Cancelled by user.');
  expect(cancelled.rows).toHaveLength(1);
  const cloud = vi.fn(async (job: Job<unknown>) => ({ data: { items: [] }, source: 'in_cloud', latencyMs: 1,
    raw: job.prompt })) as unknown as LocalRunner;
  const fault = await runGate2({ runner: cloud, signal: new AbortController().signal, onDeviceModel: 'model',
    warmupLatencyMs: null, rest: async () => {} });
  expect(fault.complete).toBe(false);
  expect(fault.rows[0].error).toBe('privacy-fault');
  expect(fault.rows[0].sources).toContain('in_cloud');
});
