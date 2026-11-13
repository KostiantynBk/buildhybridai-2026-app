import { expect, it, vi } from 'vitest';
import { LocalModelService, type Model } from '../ai/localModel';
import { runEvaluation } from './runner';
import { builtInSettings } from '../settings/defaults';
import { validateRemote } from '../settings/remoteSettings';

function fakeService() {
  const generate = vi.fn(
    async (prompt: string): Promise<{ source: string; text: () => string }> => {
      const raw =
        prompt === 'Return JSON with ready set to true.' ? '{"ready":true}' : '{"items":[]}';
      return { source: 'on_device', text: () => raw };
    },
  );
  const model: Model = { prepare: async () => {}, generate };
  const service = new LocalModelService({
    configured: true,
    hasApi: () => true,
    availability: async () => 'available',
    createModel: () => model,
    isForeground: () => true,
    onForeground: () => () => {},
    now: () => 100,
  });
  return { service, generate };
}
it('runs the full scored harness using a fake local model and exports a summary', async () => {
  const { service, generate } = fakeService();
  await service.probe();
  await service.prepare();
  const rest = vi.fn(async () => {});
  const evaluation = await runEvaluation({
    mode: 'run1',
    runner: (job) => service.runLocal(job),
    promptVersion: 'extract.v1',
    onDeviceModel: '  synthetic-model 1.0  ',
    warmupLatencyMs: service.warmLatencyMs,
    signal: new AbortController().signal,
    rest,
    chromeVersion: 'synthetic browser',
  });
  const remote = validateRemote({ entries: { cloud_enabled: { source: 'remote', value: 'false' },
    prompt_set: { source: 'remote', value: 'v1' }, daily_cloud_budget: { source: 'remote', value: '0' } },
    fetchTime: 1234 });
  expect(remote.values.cloud_enabled).toBe(false);
  const exported = JSON.parse(JSON.stringify({ runs: [evaluation] }));
  expect(exported.runs[0].environment.settings).toEqual(builtInSettings());
  expect(evaluation.complete).toBe(true);
  expect(exported.runs[0].environment.onDeviceModel).toBe('synthetic-model 1.0');
  expect(exported.runs[0].rows).toHaveLength(60);
  expect(exported.runs[0].summary.counts.schemaValid).toBe(60);
  expect(exported.runs[0].summary.counts.restraintPassed).toBe(9);
  expect(rest).toHaveBeenCalledTimes(59);
  expect(generate).toHaveBeenCalledTimes(61);
  expect(JSON.stringify(generate.mock.calls)).not.toContain('synthetic-model 1.0');
});
it('stops on a device error, retaining rows and incomplete status', async () => {
  const { service, generate } = fakeService();
  await service.probe();
  await service.prepare();
  generate.mockRejectedValueOnce(new Error('device failed'));
  const result = await runEvaluation({
    mode: 'run1',
    runner: (job) => service.runLocal(job),
    promptVersion: 'extract.v1',
    onDeviceModel: 'synthetic-model 1.0',
    warmupLatencyMs: 0,
    signal: new AbortController().signal,
    rest: async () => {},
  });
  expect(result.complete).toBe(false);
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0].error).toBe('device-error');
  expect(result.reason).toContain('device-error');
});
it('stops latency mode on a privacy fault without reading the response', async () => {
  const { service, generate } = fakeService();
  await service.probe();
  await service.prepare();
  const text = vi.fn(() => '{"items":[]}');
  generate.mockResolvedValueOnce({ source: 'in_cloud', text });
  const result = await runEvaluation({
    mode: 'latency',
    runner: (job) => service.runLocal(job),
    promptVersion: 'extract.v1',
    onDeviceModel: 'synthetic-model 1.0',
    warmupLatencyMs: 0,
    signal: new AbortController().signal,
    rest: async () => {},
  });
  expect(result.complete).toBe(false);
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0].error).toBe('privacy-fault');
  expect(result.rows[0].source).toBe('in_cloud');
  expect(text).not.toHaveBeenCalled();
});
it('cancellation preserves partial rows without retrying', async () => {
  const { service } = fakeService();
  await service.probe();
  await service.prepare();
  const controller = new AbortController();
  const result = await runEvaluation({
    mode: 'latency',
    runner: (job) => service.runLocal(job),
    promptVersion: 'extract.v1',
    onDeviceModel: 'synthetic-model 1.0',
    warmupLatencyMs: 0,
    signal: controller.signal,
    rest: async () => controller.abort(),
  });
  expect(result.complete).toBe(false);
  expect(result.rows).toHaveLength(1);
  expect(result.reason).toContain('Cancelled');
});
