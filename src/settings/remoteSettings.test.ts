import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config';
import { builtInSettings } from './defaults';
import { bundledPromptSets } from './promptSets';
import { createSettingsLoader, validateRemote } from './remoteSettings';

const config: AppConfig = { apiKey: 'example', authDomain: 'example', projectId: 'example',
  appId: 'example', siteKey: 'example', dev: false, debug: false };
const response = (entries: Parameters<typeof validateRemote>[0]['entries']) => ({ entries, fetchTime: 1234 });
const remote = (value: string) => ({ source: 'remote' as const, value });
afterEach(() => vi.useRealTimers());

describe('settings validation', () => {
  it('accepts only narrowing values and identifies their source per key', () => {
    const settings = validateRemote(response({ cloud_enabled: remote('false'),
      cloud_model: remote('gemini-3.5-flash-lite'), prompt_set: remote('v1'),
      daily_cloud_budget: remote('7') }));
    expect(settings.values).toEqual({ cloud_enabled: false, cloud_model: 'gemini-3.5-flash-lite',
      prompt_set: 'v1', daily_cloud_budget: 7 });
    expect(Object.values(settings.sources)).toEqual(['remote', 'remote', 'remote', 'remote']);
    expect(settings.fetchTime).toBe(1234);
    expect(bundledPromptSets.v2.extract.version).toBe('extract.v2');
    expect(bundledPromptSets.v1.extract.version).toBe('extract.v1');
    expect(bundledPromptSets.v2.compare.version).toBe('compare.v1');
  });
  it('accepts built-in-equivalent switch and prompt values', () => {
    const settings = validateRemote(response({ cloud_enabled: remote('true'), prompt_set: remote('v2') }));
    expect(settings.values.cloud_enabled).toBe(true);
    expect(settings.values.prompt_set).toBe('v2');
    expect(settings.sources.cloud_enabled).toBe('remote');
    expect(settings.sources.prompt_set).toBe('remote');
  });
  it.each(['', 'yes', '1', '0', 'undefined'])('rejects invalid cloud switch %s', value => {
    const settings = validateRemote(response({ cloud_enabled: remote(value) }));
    expect(settings.values.cloud_enabled).toBe(true);
    expect(settings.sources.cloud_enabled).toBe('remote-rejected');
  });
  it.each(['-1', '21', '999999999999999999999', '2.5', 'NaN', '1e2', ''])
    ('rejects invalid budget %s to the default', value => {
      const settings = validateRemote(response({ daily_cloud_budget: remote(value) }));
      expect(settings.values.daily_cloud_budget).toBe(20);
      expect(settings.sources.daily_cloud_budget).toBe('remote-rejected');
    });
  it.each(['0', '20'])('accepts budget at the %s boundary', value => {
    const settings = validateRemote(response({ daily_cloud_budget: remote(value) }));
    expect(settings.values.daily_cloud_budget).toBe(Number(value));
    expect(settings.sources.daily_cloud_budget).toBe('remote');
  });
  it('rejects unknown model and prompt set without losing other accepted keys', () => {
    const settings = validateRemote(response({ cloud_enabled: remote('false'),
      cloud_model: remote('unapproved-model'), prompt_set: remote('v9'), daily_cloud_budget: remote('0') }));
    expect(settings.values).toEqual({ ...builtInSettings().values, cloud_enabled: false, daily_cloud_budget: 0 });
    expect(settings.sources).toEqual({ cloud_enabled: 'remote', cloud_model: 'remote-rejected',
      prompt_set: 'remote-rejected', daily_cloud_budget: 'remote' });
  });
  it('ignores non-remote sources and rejects a malformed remote value per key', () => {
    const settings = validateRemote(response({ cloud_enabled: { source: 'default', value: 'false' },
      prompt_set: { source: 'static', value: 'v1' },
      daily_cloud_budget: { source: 'remote', value: null as unknown as string } }));
    expect(settings.values).toEqual(builtInSettings().values);
    expect(settings.sources.cloud_enabled).toBe('defaults');
    expect(settings.sources.prompt_set).toBe('defaults');
    expect(settings.sources.daily_cloud_budget).toBe('remote-rejected');
  });
});

describe('startup loader', () => {
  it('does not initialize or fetch without configuration', async () => {
    const fetch = vi.fn();
    const load = createSettingsLoader({ fetch });
    expect(await load(null)).toEqual(builtInSettings());
    expect(fetch).not.toHaveBeenCalled();
  });
  it('resolves fetch failure quietly to defaults', async () => {
    const load = createSettingsLoader({ fetch: async () => { throw new Error('not exposed'); } });
    await expect(load(config)).resolves.toEqual(builtInSettings());
  });
  it('times out to defaults and ignores late success', async () => {
    vi.useFakeTimers();
    let complete!: (value: ReturnType<typeof response>) => void;
    const fetch = vi.fn(() => new Promise<ReturnType<typeof response>>(resolve => { complete = resolve; }));
    const load = createSettingsLoader({ fetch }, 25);
    const pending = load(config);
    await vi.advanceTimersByTimeAsync(25);
    expect(await pending).toEqual(builtInSettings());
    complete(response({ cloud_enabled: remote('false') }));
    await Promise.resolve();
    expect(await load(config)).toEqual(builtInSettings());
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('uses defaults when unsupported and fetches only once when configured', async () => {
    const fetch = vi.fn(async () => null);
    const load = createSettingsLoader({ fetch });
    expect(await load(config)).toEqual(builtInSettings());
    expect(await load(config)).toEqual(builtInSettings());
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
