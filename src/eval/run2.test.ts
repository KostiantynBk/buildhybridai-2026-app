import { expect, it, vi } from 'vitest';
import { LocalError } from '../ai/localModel';
import type { LocalRunner } from '../pipeline/extract';
import { runChangeEvaluation } from './run2';
import { builtInSettings } from '../settings/defaults';

it('runs all six frozen change pairs three times, using the product shortcut first', async () => {
  const runner = vi.fn(async () => ({ data: { status: 'unchanged', newQuote: '' },
    source: 'on_device', latencyMs: 7, raw: '{}' })) as unknown as LocalRunner;
  const run = await runChangeEvaluation({ runner, signal: new AbortController().signal, onDeviceModel: 'test model',
    warmupLatencyMs: 1, rest: async () => {}, chromeVersion: 'test' });
  expect(run.complete).toBe(true);
  expect(run.rows).toHaveLength(18);
  expect(run.rows.filter(row => row.source === 'code')).toHaveLength(6);
  expect(runner).toHaveBeenCalledTimes(12);
  expect(run.environment).toMatchObject({ onDeviceModel: 'test model', promptVersion: 'compare.v1',
    setVersion: 'changes-v1', settings: builtInSettings() });
  expect(run.summary).toMatchObject({ actualChangeRuns: 9, unchangedRuns: 9, changedRows: 0,
    changedQuoteFoundRate: null, errors: 0 });
  expect(JSON.stringify(run)).not.toContain('verdict');
});
it('stops on an unverified source and retains bounded source diagnostics', async () => {
  const runner = vi.fn(async () => { throw new LocalError('privacy-fault', 'not exported',
    { source: 'in_cloud', latencyMs: 3 }); }) as unknown as LocalRunner;
  const run = await runChangeEvaluation({ runner, signal: new AbortController().signal, onDeviceModel: 'test',
    warmupLatencyMs: null, rest: async () => {} });
  expect(run.complete).toBe(false);
  expect(run.rows[0]).toMatchObject({ error: 'privacy-fault', source: 'in_cloud', latencyMs: 3 });
  expect(JSON.stringify(run)).not.toContain('not exported');
});
it('marks a cancelled run incomplete and retains partial rows', async () => {
  const controller = new AbortController();
  const runner = vi.fn(async () => ({ data: { status: 'removed', newQuote: '' },
    source: 'on_device', latencyMs: 7, raw: '{}' })) as unknown as LocalRunner;
  const run = await runChangeEvaluation({ runner, signal: controller.signal, onDeviceModel: 'test',
    warmupLatencyMs: null, rest: async () => {}, onUpdate: () => controller.abort() });
  expect(run.complete).toBe(false);
  expect(run.reason).toBe('Cancelled by user.');
  expect(run.rows).toHaveLength(1);
});
