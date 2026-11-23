import { afterEach, expect, it, vi } from 'vitest';
import { LOCAL_AVAILABILITY_TIMEOUT_MS, LOCAL_GENERATION_TIMEOUT_MS, LocalModelService,
  type Dependencies, type Model } from './localModel';
import { startAutoPrepare } from '../ui/autoPrepare';

const schema = { type: 'object', properties: { ready: { type: 'boolean' } }, required: ['ready'] };
afterEach(() => { vi.useRealTimers(); });
function serviceWith(generate: ReturnType<typeof vi.fn>) {
  const deps: Dependencies = { configured: true, hasApi: () => true, availability: async () => 'available',
    createModel: () => ({ prepare: async () => {}, generate: generate as Model['generate'] }), isForeground: () => true,
    onForeground: () => () => {}, now: () => Date.now() };
  return new LocalModelService(deps);
}
it.each(['resolve', 'reject'] as const)('stalls at the deadline and ignores a late %s', async outcome => {
  vi.useFakeTimers();
  let finish!: (value: { source: string; text: () => string }) => void;
  let fail!: (error: Error) => void;
  const generate = vi.fn().mockResolvedValueOnce({ source: 'on_device', text: () => '{"ready":true}' })
    .mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
  const service = serviceWith(generate);
  await service.probe(); await service.prepare();
  const result = service.runLocal({ prompt: 'input', schema });
  const expectation = expect(result).rejects.toMatchObject({ code: 'timeout',
    diagnostics: { errorName: 'TimeoutError' } });
  await vi.waitFor(() => expect(finish).toBeDefined());
  await vi.advanceTimersByTimeAsync(LOCAL_GENERATION_TIMEOUT_MS);
  await expectation;
  expect(service.state.kind).toBe('stalled');
  await expect(service.runLocal({ prompt: 'second', schema })).rejects.toMatchObject({ code: 'timeout' });
  await expect(service.prepare()).rejects.toMatchObject({ code: 'timeout' });
  if (outcome === 'resolve') finish({ source: 'on_device', text: () => '{"ready":true}' });
  else fail(new Error('late failure'));
  await Promise.resolve(); await service.probe();
  expect(service.state.kind).toBe('stalled');
  expect(generate).toHaveBeenCalledTimes(2);
});
it('cannot run a queued remount warm-up or restore ready after a generation stalls', async () => {
  vi.useFakeTimers();
  let finish!: (value: { source: string; text: () => string }) => void;
  const generate = vi.fn().mockResolvedValueOnce({ source: 'on_device', text: () => '{"ready":true}' })
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const service = serviceWith(generate);
  await service.probe(); await service.prepare();
  const run = service.runLocal({ prompt: 'held', schema });
  const runError = expect(run).rejects.toMatchObject({ code: 'timeout' });
  await vi.waitFor(() => expect(finish).toBeDefined());
  await service.probe(); // A remount readiness effect must not demote a ready, active service.
  expect(service.state.kind).toBe('ready');
  service.state = { kind: 'downloadable' }; // Simulate a readiness effect that began before the timeout.
  const preparing = service.prepare();
  const prepareError = expect(preparing).rejects.toMatchObject({ code: 'timeout' });
  await vi.advanceTimersByTimeAsync(LOCAL_GENERATION_TIMEOUT_MS);
  await runError; await prepareError;
  expect(service.state.kind).toBe('stalled');
  expect(generate).toHaveBeenCalledTimes(2);
  finish({ source: 'on_device', text: () => '{"ready":true}' });
  await Promise.resolve();
  expect(service.state.kind).toBe('stalled');
});
it('settles model errors without a diagnostic probe and bounds retry availability', async () => {
  vi.useFakeTimers();
  const availability = vi.fn().mockResolvedValueOnce('available').mockImplementationOnce(() => new Promise(() => {}));
  const generate = vi.fn().mockResolvedValueOnce({ source: 'on_device', text: () => '{"ready":true}' })
    .mockRejectedValueOnce(new Error('fixture'));
  const service = new LocalModelService({ configured: true, hasApi: () => true, availability,
    createModel: () => ({ prepare: async () => {}, generate }), isForeground: () => true,
    onForeground: () => () => {}, now: Date.now });
  await service.probe(); await service.prepare();
  await expect(service.runLocal({ prompt: 'fails', schema })).rejects.toMatchObject({ code: 'device-error' });
  expect(availability).toHaveBeenCalledTimes(1);
  expect(service.retryRequired).toBe(true);
  expect(service.generating).toBe(false);
  const retry = service.prepare();
  const retryError = expect(retry).rejects.toMatchObject({ code: 'timeout' });
  await vi.advanceTimersByTimeAsync(LOCAL_AVAILABILITY_TIMEOUT_MS);
  await retryError;
  expect(service.state.kind).toBe('stalled');
  expect(generate).toHaveBeenCalledTimes(2);
});
it('does not let an obsolete held readiness check stall a newer ready service', async () => {
  vi.useFakeTimers();
  const generate = vi.fn().mockResolvedValue({ source: 'on_device', text: () => '{"ready":true}' });
  const service = new LocalModelService({ configured: true, hasApi: () => true,
    availability: () => new Promise(() => {}), createModel: () => ({ prepare: async () => {}, generate }),
    isForeground: () => true, onForeground: () => () => {}, now: Date.now });
  const oldProbe = service.probe();
  service.state = { kind: 'downloadable' };
  await service.prepare();
  await vi.advanceTimersByTimeAsync(LOCAL_AVAILABILITY_TIMEOUT_MS);
  await oldProbe;
  expect(service.state.kind).toBe('ready');
  expect(generate).toHaveBeenCalledTimes(1);
});
it.each(['timeout', 'unavailable'] as const)(
  'ignores an unmounted readiness owner when the old probe gives %s', async outcome => {
    vi.useFakeTimers();
    let old!: (value: string) => void; let current!: (value: string) => void;
    const availability = vi.fn().mockImplementationOnce(() => new Promise(resolve => { old = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { current = resolve; }));
    const generate = vi.fn().mockResolvedValue({ source: 'on_device', text: () => '{"ready":true}' });
    const service = new LocalModelService({ configured: true, hasApi: () => true, availability,
      createModel: () => ({ prepare: async () => {}, generate }), isForeground: () => true,
      onForeground: () => () => {}, now: Date.now });
    const env = { hasApi: () => true, foreground: () => true, onVisibility: () => () => {} };
    const stopOld = startAutoPrepare(service, true, env);
    await vi.advanceTimersByTimeAsync(1000);
    stopOld();
    const stopNew = startAutoPrepare(service, true, env);
    try {
      if (outcome === 'timeout') await vi.advanceTimersByTimeAsync(LOCAL_AVAILABILITY_TIMEOUT_MS - 1000);
      else { old('unavailable'); await vi.advanceTimersByTimeAsync(0); }
      expect(service.state.kind).not.toBe('stalled');
      expect(service.state.kind).not.toBe('unavailable');
      current('available');
      await vi.waitFor(() => expect(service.state.kind).toBe('ready'));
      expect(generate).toHaveBeenCalledTimes(1);
    } finally { stopNew(); }
  });
it('classifies model quota without disabling later requests', async () => {
  const quota = Object.assign(new Error('fixture'), { name: 'QuotaExceededError' });
  const generate = vi.fn().mockResolvedValueOnce({ source: 'on_device', text: () => '{"ready":true}' })
    .mockRejectedValueOnce(quota).mockResolvedValueOnce({ source: 'on_device', text: () => '{"ready":true}' });
  const service = serviceWith(generate);
  await service.probe(); await service.prepare();
  await expect(service.runLocal({ prompt: 'long', schema })).rejects.toMatchObject({ code: 'model-quota',
    diagnostics: { errorName: 'QuotaExceededError' } });
  expect(service.state.kind).toBe('ready');
  expect((await service.runLocal<{ ready: boolean }>({ prompt: 'other', schema })).data.ready).toBe(true);
});
