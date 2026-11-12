import { AIError, AIErrorCode } from 'firebase/ai';
import { describe, expect, it } from 'vitest';
import { LocalModelService, type Model } from '../ai/localModel';
import { safeAvailability, safeErrorName } from '../ai/errorMetadata';
import { formatFailureStatus } from './failureStatus';
import { runEvaluation } from './runner';

const sentinel = 'PRIVATE_MESSAGE_SENTINEL_never_export';
async function runWithFailure(failure: unknown) {
  let now = 0;
  let hidden = false;
  let availabilityCalls = 0;
  let calls = 0;
  const model: Model = {
    prepare: async () => {},
    generate: async () => {
      calls++;
      if (calls === 1) return { source: 'on_device', text: () => '{"ready":true}' };
      now = 125;
      hidden = true;
      throw failure;
    },
  };
  const service = new LocalModelService({
    configured: true,
    hasApi: () => true,
    availability: async () => (++availabilityCalls === 1 ? 'available' : 'downloadable'),
    createModel: () => model,
    isForeground: () => true,
    isHidden: () => hidden,
    onForeground: () => () => {},
    now: () => now,
  });
  await service.probe();
  await service.prepare();
  return runEvaluation({
    mode: 'run1',
    runner: (job) => service.runLocal(job),
    warmupLatencyMs: 0,
    onDeviceModel: 'synthetic-model',
    signal: new AbortController().signal,
    rest: async () => {},
  });
}

describe('safe failure diagnostics', () => {
  it.each([
    'UnknownError',
    'NotSupportedError',
    'QuotaExceededError',
    'AbortError',
    'InvalidStateError',
    'NotReadableError',
    'TimeoutError',
  ])('exports %s without its message or stack', async (name) => {
    const result = await runWithFailure(new DOMException(sentinel, name));
    expect(result.complete).toBe(false);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      error: 'device-error',
      errorClass: 'device-error',
      errorName: name,
      availabilityAfter: 'downloadable',
      elapsedMs: 125,
      hidden: true,
      latencyMs: null,
      source: null,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain('stack');
    const status = formatFailureStatus(result.rows[0]);
    expect(status).toContain(name);
    expect(status).toContain('downloadable');
    expect(status).toContain('125 ms');
    expect(status).not.toContain(sentinel);
  });
  it('captures standard JavaScript Error names without messages', async () => {
    for (const error of [new Error(sentinel), new TypeError(sentinel), new RangeError(sentinel)]) {
      const result = await runWithFailure(error);
      expect(result.rows[0].errorName).toBe(error.name);
      expect(JSON.stringify(result)).not.toContain(sentinel);
    }
  });
  it('extracts a one-level cause and known Firebase AIError code without messages', async () => {
    const cause = new Error(sentinel, { cause: new DOMException(sentinel, 'QuotaExceededError') });
    const first = await runWithFailure(cause);
    expect(first.rows[0].errorName).toBe('QuotaExceededError');
    const second = await runWithFailure(new AIError(AIErrorCode.API_NOT_ENABLED, sentinel));
    expect(second.rows[0].errorName).toBe('api-not-enabled');
    const third = await runWithFailure(
      new Error(sentinel, {
        cause: new AIError(AIErrorCode.UNSUPPORTED, sentinel),
      }),
    );
    expect(third.rows[0].errorName).toBe('unsupported');
    expect(JSON.stringify([first, second, third])).not.toContain(sentinel);
  });
  it('records parser failures without exporting invalid response content or changing readiness', async () => {
    let calls = 0;
    let now = 0;
    const model: Model = {
      prepare: async () => {},
      generate: async () => {
        calls++;
        if (calls === 1) return { source: 'on_device', text: () => '{"ready":true}' };
        now = 40;
        return { source: 'on_device', text: () => sentinel };
      },
    };
    const service = new LocalModelService({
      configured: true,
      hasApi: () => true,
      availability: async () => 'available',
      createModel: () => model,
      isForeground: () => true,
      isHidden: () => false,
      onForeground: () => () => {},
      now: () => now,
    });
    await service.probe();
    await service.prepare();
    const controller = new AbortController();
    const result = await runEvaluation({
      mode: 'run1',
      runner: (job) => service.runLocal(job),
      warmupLatencyMs: 0,
      onDeviceModel: 'synthetic-model',
      signal: controller.signal,
      onUpdate: (evaluation) => {
        if (evaluation.rows.length === 1) controller.abort();
      },
    });
    expect(result.rows[0]).toMatchObject({
      errorName: 'SyntaxError',
      errorClass: 'invalid-output',
      availabilityAfter: null,
      elapsedMs: 40,
      hidden: false,
      source: 'on_device',
    });
    expect(service.state.kind).toBe('ready');
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });
  it('does not treat arbitrary exception names or codes as safe', () => {
    expect(safeErrorName({ name: sentinel, code: sentinel })).toBe('OtherError');
    expect(safeErrorName({ name: 'FirebaseError', code: sentinel })).toBe('OtherError');
    expect(safeAvailability(sentinel)).toBe('unknown');
  });
});
