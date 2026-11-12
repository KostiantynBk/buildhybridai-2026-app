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
    promptVersion: 'extract.v1',
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
      promptVersion: 'extract.v1',
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
  it('never leaks a changing name getter through the export or status', async () => {
    let reads = 0;
    const error = {
      get name() {
        return ++reads <= 5 ? 'TypeError' : sentinel;
      },
    };
    const result = await runWithFailure(error);
    expect(result.rows[0].errorName).toBe('TypeError');
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(formatFailureStatus(result.rows[0])).not.toContain(sentinel);
    expect(reads).toBe(1);
  });
  it('never leaks a changing Firebase code getter through the export or status', async () => {
    let reads = 0;
    const error = {
      name: 'FirebaseError',
      get code() {
        return ++reads <= 3 ? 'no-api-key' : sentinel;
      },
    };
    const result = await runWithFailure(error);
    expect(result.rows[0].errorName).toBe('no-api-key');
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(formatFailureStatus(result.rows[0])).not.toContain(sentinel);
    expect(reads).toBe(1);
  });
  it('reads the root cause and each candidate name and code at most once', () => {
    const counts = { rootCause: 0, rootName: 0, rootCode: 0, causeName: 0, causeCode: 0 };
    const cause = {
      get name() {
        counts.causeName++;
        return 'UnknownError';
      },
      get code() {
        counts.causeCode++;
        return undefined;
      },
    };
    const root = {
      get cause() {
        counts.rootCause++;
        return cause;
      },
      get name() {
        counts.rootName++;
        return 'Error';
      },
      get code() {
        counts.rootCode++;
        return undefined;
      },
    };
    expect(safeErrorName(root)).toBe('UnknownError');
    expect(counts).toEqual({ rootCause: 1, rootName: 1, rootCode: 1, causeName: 1, causeCode: 1 });
  });
  it('reads a self-referential cause candidate only once', () => {
    let names = 0;
    let codes = 0;
    let causes = 0;
    const error = {
      get cause() {
        causes++;
        return error;
      },
      get name() {
        names++;
        return 'TypeError';
      },
      get code() {
        codes++;
        return undefined;
      },
    };
    expect(safeErrorName(error)).toBe('TypeError');
    expect({ causes, names, codes }).toEqual({ causes: 1, names: 1, codes: 1 });
  });
  it('does not treat arbitrary exception names or codes as safe', () => {
    expect(safeErrorName({ name: sentinel, code: sentinel })).toBe('OtherError');
    expect(safeErrorName({ name: 'FirebaseError', code: sentinel })).toBe('OtherError');
    expect(safeAvailability(sentinel)).toBe('unknown');
  });
});
