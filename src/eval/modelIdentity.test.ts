import { describe, expect, it, vi } from 'vitest';
import { canStartMeasuredRun, normalizeModelIdentity } from './modelIdentity';
import { runEvaluation, type RunMode } from './runner';
import type { LocalRunner } from '../pipeline/extract';

const ready = { configured: true, ready: true, running: false, foreground: true };
describe('on-device model identity', () => {
  it('requires a nonempty model for measured runs while preserving all existing gates', () => {
    expect(canStartMeasuredRun({ ...ready, model: '' })).toBe(false);
    expect(canStartMeasuredRun({ ...ready, model: '   ' })).toBe(false);
    expect(canStartMeasuredRun({ ...ready, model: ' synthetic-model 1.0 ' })).toBe(true);
    expect(canStartMeasuredRun({ ...ready, model: 'synthetic', configured: false })).toBe(false);
    expect(canStartMeasuredRun({ ...ready, model: 'synthetic', ready: false })).toBe(false);
    expect(canStartMeasuredRun({ ...ready, model: 'synthetic', foreground: false })).toBe(false);
    expect(canStartMeasuredRun({ ...ready, model: 'synthetic', running: true })).toBe(false);
    expect(normalizeModelIdentity(`  ${'x'.repeat(250)}  `)).toHaveLength(200);
  });
  it.each<RunMode>(['run1', 'latency'])(
    'blocks %s before invoking the runner when empty',
    async (mode) => {
      const runner = vi.fn() as unknown as LocalRunner;
      await expect(
        runEvaluation({
          mode,
          runner,
          onDeviceModel: '  ',
          warmupLatencyMs: null,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow('On-device model identity is required.');
      expect(runner).not.toHaveBeenCalled();
    },
  );
});
