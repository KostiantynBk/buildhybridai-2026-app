import { describe, it, expect, vi } from 'vitest';
import { readConfig } from '../config';
import { LocalError, LocalModelService, type Dependencies, type Model } from './localModel';

const schema = { type: 'object', properties: { ready: { type: 'boolean' } }, required: ['ready'] };
function fixture(options: { configured?: boolean; present?: boolean; available?: string } = {}) {
  let foreground = true;
  let present = options.present ?? true;
  let notify = () => {};
  const generate = vi.fn(
    async (_prompt: string, _schema: object): Promise<{ source?: string; text: () => string }> => ({
      source: 'on_device',
      text: () => '{"ready":true}',
    }),
  );
  const prepare = vi.fn(async (progress: (value: number) => void) => {
    progress(0.5);
  });
  const createModel = vi.fn((): Model => ({ prepare, generate }));
  const deps: Dependencies = {
    configured: options.configured ?? true,
    hasApi: () => present,
    availability: vi.fn(async () => options.available ?? 'downloadable'),
    createModel,
    isForeground: () => foreground,
    onForeground: (callback) => {
      notify = callback;
      return () => {
        if (notify === callback) {
          notify = () => {};
        }
      };
    },
    now: () => 100,
  };
  return {
    service: new LocalModelService(deps),
    deps,
    createModel,
    generate,
    prepare,
    setPresent: (value: boolean) => {
      present = value;
    },
    setForeground: (value: boolean) => {
      foreground = value;
      notify();
    },
  };
}
const task = { prompt: 'synthetic', schema };

describe('configuration', () => {
  const placeholders = {
    VITE_FIREBASE_API_KEY: 'YOUR_FIREBASE_API_KEY',
    VITE_FIREBASE_AUTH_DOMAIN: 'YOUR_FIREBASE_AUTH_DOMAIN',
    VITE_FIREBASE_PROJECT_ID: 'YOUR_FIREBASE_PROJECT_ID',
    VITE_FIREBASE_APP_ID: 'YOUR_FIREBASE_APP_ID',
    VITE_RECAPTCHA_ENTERPRISE_SITE_KEY: 'YOUR_RECAPTCHA_ENTERPRISE_SITE_KEY',
  };
  it('rejects absent and placeholder settings and safely permits a read-only probe', async () => {
    for (const env of [{}, placeholders]) {
      expect(readConfig(env)).toBeNull();
      const f = fixture({ configured: false });
      await f.service.probe();
      expect(f.service.browserAvailability).toBe('downloadable');
      await expect(f.service.runLocal(task)).rejects.toMatchObject({ code: 'not-configured' });
      await expect(f.service.prepare()).rejects.toMatchObject({ code: 'not-configured' });
      expect(f.createModel).not.toHaveBeenCalled();
    }
  });
  it.each([
    [true, 'true', true],
    [true, 'false', false],
    [false, 'true', false],
    [false, 'false', false],
  ])('requires a site key except dev=%s debug=%s', (dev, debug, allowed) => {
    const env = {
      VITE_FIREBASE_API_KEY: 'example',
      VITE_FIREBASE_AUTH_DOMAIN: 'example',
      VITE_FIREBASE_PROJECT_ID: 'example',
      VITE_FIREBASE_APP_ID: 'example',
      DEV: dev,
      VITE_APPCHECK_DEBUG: debug,
    };
    expect(readConfig(env) !== null).toBe(allowed);
    expect(
      readConfig({ ...env, VITE_RECAPTCHA_ENTERPRISE_SITE_KEY: 'YOUR_RECAPTCHA_ENTERPRISE_SITE_KEY' }) !==
        null,
    ).toBe(allowed);
  });
  it('only enables debug when development and explicitly requested', () => {
    const env = {
      VITE_FIREBASE_API_KEY: 'example',
      VITE_FIREBASE_AUTH_DOMAIN: 'example',
      VITE_FIREBASE_PROJECT_ID: 'example',
      VITE_FIREBASE_APP_ID: 'example',
      VITE_RECAPTCHA_ENTERPRISE_SITE_KEY: 'example',
      VITE_APPCHECK_DEBUG: 'true',
    };
    expect(readConfig({ ...env, DEV: true })?.debug).toBe(true);
    expect(readConfig({ ...env, DEV: false })?.debug).toBe(false);
  });
});

describe('readiness and local inference', () => {
  it('reports unsupported when the browser API is absent', async () => {
    const f = fixture({ present: false });
    await f.service.probe();
    expect(f.service.state.kind).toBe('unsupported');
  });
  it('reports unavailable when the browser model is unavailable', async () => {
    const f = fixture({ available: 'unavailable' });
    await f.service.probe();
    expect(f.service.state.kind).toBe('unavailable');
  });
  it('reports downloadable after the probe', async () => {
    const f = fixture();
    await f.service.probe();
    expect(f.service.state.kind).toBe('downloadable');
  });
  it('reports downloading and progress values', async () => {
    const f = fixture({ available: 'downloading' });
    const progress: number[] = [];
    f.service.subscribe(() => {
      if (f.service.state.kind === 'downloading') progress.push(f.service.state.progress);
    });
    await f.service.probe();
    await f.service.prepare();
    expect(progress).toEqual([0, 0, 0.5]);
  });
  it('enters warming before the synthetic inference', async () => {
    const f = fixture();
    const seen: string[] = [];
    f.service.subscribe(() => {
      seen.push(f.service.state.kind);
    });
    await f.service.probe();
    await f.service.prepare();
    expect(seen.indexOf('warming')).toBeGreaterThan(seen.indexOf('downloading'));
    expect(seen.indexOf('warming')).toBeLessThan(seen.indexOf('ready'));
  });
  it('enters ready after successful warm-up', async () => {
    const f = fixture({ available: 'available' });
    await f.service.probe();
    expect(f.service.browserAvailability).toBe('available');
    await f.service.prepare();
    expect(f.service.state.kind).toBe('ready');
    expect(f.service.warmLatencyMs).toBe(0);
    expect(await f.service.runLocal(task)).toMatchObject({ data: { ready: true }, source: 'on_device' });
  });
  it('rejects inference before readiness', async () => {
    const f = fixture();
    await f.service.probe();
    await expect(f.service.runLocal(task)).rejects.toMatchObject({ code: 'not-ready' });
    expect(f.createModel).not.toHaveBeenCalled();
  });
  it('never becomes ready when warm-up fails', async () => {
    const f = fixture();
    const seen: string[] = [];
    f.service.subscribe(() => {
      seen.push(f.service.state.kind);
    });
    await f.service.probe();
    f.generate.mockRejectedValueOnce(new Error('warm-up failed'));
    await expect(f.service.prepare()).rejects.toThrow();
    expect(f.service.state.kind).toBe('error');
    expect(seen).not.toContain('ready');
  });
  it('rejects a second prepare while the first is pending', async () => {
    const f = fixture();
    await f.service.probe();
    let finish!: () => void;
    f.prepare.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = f.service.prepare();
    await expect(f.service.prepare()).rejects.toMatchObject({ code: 'not-ready' });
    finish();
    await first;
    expect(f.prepare).toHaveBeenCalledTimes(1);
  });
  it('reports probe and preparation errors', async () => {
    const f = fixture();
    vi.mocked(f.deps.availability).mockRejectedValueOnce(new Error('unavailable'));
    await f.service.probe();
    expect(f.service.state.kind).toBe('error');
    await f.service.probe();
    f.prepare.mockRejectedValueOnce(new Error('download failed'));
    await expect(f.service.prepare()).rejects.toThrow();
    expect(f.service.state.kind).toBe('error');
  });
  it('retries failed preparation with an availability recheck', async () => {
    const f = fixture();
    await f.service.probe();
    f.prepare.mockRejectedValueOnce(new Error('temporary failure'));
    await expect(f.service.prepare()).rejects.toMatchObject({ code: 'device-error' });
    expect(f.service.state.kind).toBe('error');
    await f.service.prepare();
    expect(f.deps.availability).toHaveBeenCalledTimes(2);
    expect(f.service.state.kind).toBe('ready');
  });
  it('starts retry preparation before the availability promise resolves', async () => {
    const f = fixture();
    await f.service.probe();
    f.prepare.mockRejectedValueOnce(new Error('temporary failure'));
    await expect(f.service.prepare()).rejects.toMatchObject({ code: 'device-error' });
    let finish!: (value: string) => void;
    vi.mocked(f.deps.availability).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const attempt = f.service.prepare();
    expect(f.prepare).toHaveBeenCalledTimes(2);
    finish('available');
    await attempt;
    expect(f.service.state.kind).toBe('ready');
  });
  it('rechecks after device failure, refuses queued jobs, then recovers', async () => {
    const f = fixture();
    await f.service.probe();
    await f.service.prepare();
    f.generate.mockRejectedValueOnce(new Error('device lost'));
    vi.mocked(f.deps.availability).mockResolvedValueOnce('unavailable');
    const failed = f.service.runLocal(task);
    const queued = f.service.runLocal(task);
    await expect(failed).rejects.toMatchObject({ code: 'device-error' });
    await expect(queued).rejects.toMatchObject({ code: 'not-ready' });
    expect(f.service.state.kind).toBe('unavailable');
    await f.service.prepare();
    expect(f.service.state.kind).toBe('ready');
  });
  it('preserves readiness after schema rejection', async () => {
    const f = fixture();
    await f.service.probe();
    await f.service.prepare();
    vi.mocked(f.deps.availability).mockClear();
    f.generate.mockResolvedValueOnce({ source: 'on_device', text: () => '{"ready":"wrong"}' });
    await expect(f.service.runLocal(task)).rejects.toMatchObject({ code: 'invalid-output' });
    expect(f.service.state.kind).toBe('ready');
    expect(f.deps.availability).not.toHaveBeenCalled();
  });
  it('fails closed when the API disappears without an SDK call', async () => {
    const f = fixture();
    await f.service.probe();
    await f.service.prepare();
    f.createModel.mockClear();
    f.setPresent(false);
    await expect(f.service.runLocal(task)).rejects.toMatchObject({ code: 'unsupported' });
    expect(f.createModel).not.toHaveBeenCalled();
  });
  it('rejects incorrect source before touching response text', async () => {
    const f = fixture();
    await f.service.probe();
    await f.service.prepare();
    const text = vi.fn(() => '{"ready":true}');
    f.generate.mockResolvedValueOnce({ source: 'in_cloud', text });
    await expect(f.service.runLocal(task)).rejects.toMatchObject({ code: 'privacy-fault' });
    expect(text).not.toHaveBeenCalled();
    expect(f.service.privacyFaults).toBe(1);
    await expect(f.service.runLocal(task)).resolves.toMatchObject({ source: 'on_device' });
  });
  it('rejects schema-invalid JSON', async () => {
    const f = fixture();
    await f.service.probe();
    await f.service.prepare();
    f.generate.mockResolvedValueOnce({ source: 'on_device', text: () => '{"ready":"no"}' });
    await expect(f.service.runLocal(task)).rejects.toBeInstanceOf(LocalError);
    f.generate.mockResolvedValueOnce({ source: 'on_device', text: () => '{"ready":"no"}' });
    await expect(f.service.runLocal(task)).rejects.toMatchObject({ code: 'invalid-output' });
  });
  it('does not overlap pending inference calls', async () => {
    const f = fixture();
    await f.service.probe();
    await f.service.prepare();
    f.generate.mockClear();
    let finish!: (value: { source: string; text: () => string }) => void;
    f.generate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = f.service.runLocal({ ...task, prompt: 'first' });
    const second = f.service.runLocal({ ...task, prompt: 'second' });
    await vi.waitFor(() => expect(f.generate).toHaveBeenCalledTimes(1));
    finish({ source: 'on_device', text: () => '{"ready":true}' });
    await Promise.all([first, second]);
    expect(f.generate.mock.calls.map((args) => args[0])).toEqual(['first', 'second']);
  });
  it('rechecks visibility when a job resumes then immediately hides', async () => {
    const f = fixture();
    await f.service.probe();
    await f.service.prepare();
    f.generate.mockClear();
    f.setForeground(false);
    const job = f.service.runLocal(task);
    await Promise.resolve();
    f.setForeground(true);
    f.setForeground(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(f.generate).not.toHaveBeenCalled();
    f.setForeground(true);
    await job;
    expect(f.generate).toHaveBeenCalledTimes(1);
  });
  it('rechecks visibility when warm-up resumes then immediately hides', async () => {
    const f = fixture();
    await f.service.probe();
    f.setForeground(false);
    const preparation = f.service.prepare();
    await vi.waitFor(() => expect(f.service.state.kind).toBe('warming'));
    f.setForeground(true);
    f.setForeground(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(f.generate).not.toHaveBeenCalled();
    f.setForeground(true);
    await preparation;
    expect(f.generate).toHaveBeenCalledTimes(1);
  });
  it('serializes jobs in FIFO order and waits while hidden', async () => {
    const f = fixture();
    await f.service.probe();
    await f.service.prepare();
    f.generate.mockClear();
    f.setForeground(false);
    const first = f.service.runLocal({ ...task, prompt: 'first' });
    const second = f.service.runLocal({ ...task, prompt: 'second' });
    await Promise.resolve();
    await Promise.resolve();
    expect(f.generate).not.toHaveBeenCalled();
    f.setForeground(true);
    await Promise.all([first, second]);
    expect(f.generate.mock.calls.map((args) => args[0])).toEqual(['first', 'second']);
  });
});
