import { expect, it, vi } from 'vitest';
import type { Job } from '../ai/localModel';
import { anglesV1 } from '../pipeline/prompts/angles.v1';
import { questionV1 } from '../pipeline/prompts/question.v1';
import { whynoteV1 } from '../pipeline/prompts/whynote.v1';
import type { LocalRunner } from '../pipeline/extract';
import { runGate2 } from './run3';

function syntheticRunner() {
  return vi.fn(async (job: Job<unknown>) => {
    let data: unknown;
    if (job.instructions === anglesV1) data = { concerns: [{ item: 1, angle: 'end-user',
      concern: 'Could the builder check public limits?', checkable: true }] };
    else if (job.instructions === questionV1) data = { question: 'What limits apply to Leora?', keptOut: [] };
    else if (job.instructions === whynoteV1) {
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
  expect(first.runner.mock.calls.filter(call => call[0].instructions === anglesV1)).toHaveLength(27);
  expect(first.runner.mock.calls.filter(call => call[0].instructions === questionV1)).toHaveLength(27);
  expect(JSON.stringify(first.result)).not.toContain('Calder & Finch');
});
it('shares each distinct concern question across profiles without mismatching why-note inputs', async () => {
  const runner = vi.fn(async (job: Job<unknown>) => {
    let data: unknown;
    if (job.instructions === anglesV1) data = { concerns: [
      { item: 1, angle: 'end-user', concern: 'Concern frontend', checkable: true },
      { item: 2, angle: 'limits-operations', concern: 'Concern backend', checkable: true },
    ] };
    else if (job.instructions === questionV1) data = { question: job.prompt.includes('Concern frontend')
      ? 'What is the frontend limit?' : 'What is the backend limit?', keptOut: [] };
    else if (job.instructions === whynoteV1) {
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
  expect(runner.mock.calls.filter(call => call[0].instructions === questionV1)).toHaveLength(54);
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
