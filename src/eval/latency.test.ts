import { expect, it, vi } from 'vitest';
import type { EvaluationRow } from './runner';
import type { LocalRunner } from '../pipeline/extract';
import { latencySummary, quantile, run1LatencyByNote } from './runner';

const row = (overrides: Partial<EvaluationRow> = {}): EvaluationRow => ({
  noteId: 'n01',
  repetition: 1,
  promptVersion: 'extract.v1',
  inputSize: 1,
  inputSizeUnit: 'characters',
  latencyMs: 1000,
  source: 'on_device',
  schemaValid: true,
  returnedItems: [],
  items: [],
  beforeDrop: 0,
  quoteExact: 0,
  droppedBadQuotes: 0,
  droppedDuplicates: 0,
  error: null,
  errorName: null,
  errorClass: null,
  availabilityAfter: null,
  elapsedMs: null,
  hidden: null,
  wordCount: 200,
  sampleKind: 'gate',
  firstEvaluationAttemptAfterReload: false,
  ...overrides,
});

it('uses the nineteenth of twenty for nearest-rank p95', () => {
  expect(
    quantile(
      Array.from({ length: 20 }, (_, i) => i + 1),
      0.95,
    ),
  ).toBe(19);
});
it('counts failed gate calls as slower than 12 seconds without changing observed rows', () => {
  const rows = Array.from({ length: 20 }, (_, index) =>
    row({
      repetition: index + 1,
      ...(index >= 18 ? { schemaValid: false, error: 'invalid-output', latencyMs: 50 } : {}),
    }),
  );
  const summary = latencySummary(rows);
  expect(summary.gate.wordCountInBand).toBe(true);
  expect(summary.gate.sampleCount).toBe(20);
  expect(summary.gate.failedCalls).toBe(2);
  expect(summary.gate.p95Ms).toBeGreaterThan(12000);
  expect(rows[18].latencyMs).toBe(50);
});
it('keeps first evaluation out of Run 1 warm timing and reports note length', () => {
  const result = run1LatencyByNote([
    row({ sampleKind: 'run1', firstEvaluationAttemptAfterReload: true, latencyMs: 9000 }),
    row({ sampleKind: 'run1', latencyMs: 2000 }),
  ]);
  expect(result[0]).toMatchObject({ wordCount: 200, sampleCount: 1, medianMs: 2000 });
});
it('keeps a prior practice call separate and begins the gate without another first sample', async () => {
  vi.resetModules();
  const tracker = await import('./runner');
  tracker.recordFirstEvaluation(tracker.markEvaluationCall(), {
    latencyMs: 123,
    source: 'on_device',
    error: null,
  });
  const fake = vi.fn(async () => ({
    data: { items: [] },
    latencyMs: 10,
    source: 'on_device',
    raw: '{"items":[]}',
  })) as unknown as LocalRunner;
  const evaluation = await tracker.runEvaluation({
    mode: 'latency',
    runner: fake,
    onDeviceModel: 'synthetic-model 1.0',
    warmupLatencyMs: 100,
    signal: new AbortController().signal,
    rest: async () => {},
  });
  const summary = evaluation.summary as ReturnType<typeof latencySummary>;
  expect(evaluation.rows).toHaveLength(45);
  expect(evaluation.rows[0].sampleKind).toBe('gate');
  expect(summary.firstEvaluationAfterReload?.latencyMs).toBe(123);
  expect(summary.gate.sampleCount).toBe(20);
});
it('schedules a first evaluation separately, then twenty in-band gate calls and the curve', async () => {
  vi.resetModules();
  const { runEvaluation } = await import('./runner');
  const fake = vi.fn(async () => ({
    data: { items: [] },
    latencyMs: 10,
    source: 'on_device',
    raw: '{"items":[]}',
  })) as unknown as LocalRunner;
  const evaluation = await runEvaluation({
    mode: 'latency',
    runner: fake,
    onDeviceModel: 'synthetic-model 1.0',
    warmupLatencyMs: 100,
    signal: new AbortController().signal,
    rest: async () => {},
    chromeVersion: 'example',
  });
  expect(evaluation.complete).toBe(true);
  expect(evaluation.rows).toHaveLength(46);
  expect(evaluation.rows[0].sampleKind).toBe('first-evaluation');
  const gate = evaluation.rows.filter((item) => item.sampleKind === 'gate');
  expect(gate).toHaveLength(20);
  expect(gate.every((item) => item.wordCount >= 150 && item.wordCount <= 250)).toBe(true);
  const summary = evaluation.summary as ReturnType<typeof latencySummary>;
  expect(summary.gate.sampleCount).toBe(20);
  expect(summary.gate.p95Ms).toBe(10);
  expect(summary.sizes.every((item) => item.sampleCount === 5)).toBe(true);
  expect(summary.sizes[0].maxOfFiveMs).toBe(10);
});
