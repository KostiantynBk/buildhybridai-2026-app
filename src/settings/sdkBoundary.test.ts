import { expect, it, vi } from 'vitest';
import { readConfig } from '../config';

const sdk = vi.hoisted(() => ({
  initializeApp: vi.fn(() => ({})),
  isSupported: vi.fn(async () => true),
  getRemoteConfig: vi.fn(() => ({ settings: {}, defaultConfig: {}, fetchTimeMillis: 1234 })),
  setLogLevel: vi.fn(), ensureInitialized: vi.fn(async () => {}), fetchAndActivate: vi.fn(async () => true),
  getValue: vi.fn((_config: unknown, _key: string) => ({ getSource: () => 'default', asString: () => '' })),
}));
vi.mock('firebase/app', () => ({ initializeApp: sdk.initializeApp }));
vi.mock('firebase/remote-config', () => ({
  isSupported: sdk.isSupported, getRemoteConfig: sdk.getRemoteConfig, setLogLevel: sdk.setLogLevel,
  ensureInitialized: sdk.ensureInitialized, fetchAndActivate: sdk.fetchAndActivate, getValue: sdk.getValue,
}));
import { loadSettings, sdkAdapter } from './remoteSettings';
import type { AppConfig } from '../config';

it('never enters SDK without valid config and uses exactly the safe SDK path when configured', async () => {
  await loadSettings(null);
  await loadSettings(readConfig({ VITE_FIREBASE_API_KEY: 'YOUR_FIREBASE_API_KEY' }));
  expect(sdk.initializeApp).not.toHaveBeenCalled();
  expect(sdk.isSupported).not.toHaveBeenCalled();
  expect(sdk.getRemoteConfig).not.toHaveBeenCalled();
  expect(sdk.fetchAndActivate).not.toHaveBeenCalled();
  const synthetic = readConfig({ VITE_FIREBASE_API_KEY: 'example', VITE_FIREBASE_AUTH_DOMAIN: 'example',
    VITE_FIREBASE_PROJECT_ID: 'example', VITE_FIREBASE_APP_ID: 'example',
    VITE_RECAPTCHA_ENTERPRISE_SITE_KEY: 'example' });
  const result = await loadSettings(synthetic);
  expect(sdk.initializeApp).toHaveBeenCalledTimes(1);
  expect(sdk.isSupported).toHaveBeenCalledTimes(1);
  expect(sdk.getRemoteConfig).toHaveBeenCalledTimes(1);
  expect(sdk.fetchAndActivate).toHaveBeenCalledTimes(1);
  expect(sdk.getValue.mock.calls.map(args => args[1])).toEqual([
    'cloud_enabled', 'cloud_model', 'prompt_set', 'daily_cloud_budget',
  ]);
  const config = sdk.getRemoteConfig.mock.results[0].value;
  expect(config.settings).toEqual({ minimumFetchIntervalMillis: 3600000, fetchTimeoutMillis: 8000 });
  expect(Object.keys(config.defaultConfig)).toEqual([
    'cloud_enabled', 'cloud_model', 'prompt_set', 'daily_cloud_budget',
  ]);
  expect(result.sources).toEqual({ cloud_enabled: 'defaults', cloud_model: 'defaults',
    prompt_set: 'defaults', daily_cloud_budget: 'defaults' });
});

it('does not initialize or fetch after an expired support check', async () => {
  vi.clearAllMocks();
  let resolveSupport!: (supported: boolean) => void;
  sdk.isSupported.mockImplementationOnce(() => new Promise(resolve => { resolveSupport = resolve; }));
  const controller = new AbortController();
  const synthetic: AppConfig = { apiKey: 'example', authDomain: 'example', projectId: 'example',
    appId: 'example', siteKey: 'example', dev: false, debug: false };
  const pending = sdkAdapter.fetch(synthetic, controller.signal);
  controller.abort();
  resolveSupport(true);
  expect(await pending).toBeNull();
  expect(sdk.initializeApp).not.toHaveBeenCalled();
  expect(sdk.getRemoteConfig).not.toHaveBeenCalled();
});

it('does not begin a fetch after an expired storage initialization', async () => {
  vi.clearAllMocks();
  let finish!: () => void;
  sdk.ensureInitialized.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const controller = new AbortController();
  const synthetic: AppConfig = { apiKey: 'example', authDomain: 'example', projectId: 'example',
    appId: 'example', siteKey: 'example', dev: false, debug: false };
  const pending = sdkAdapter.fetch(synthetic, controller.signal);
  await vi.waitFor(() => expect(sdk.ensureInitialized).toHaveBeenCalledTimes(1));
  controller.abort();
  finish();
  expect(await pending).toBeNull();
  expect(sdk.fetchAndActivate).not.toHaveBeenCalled();
});
