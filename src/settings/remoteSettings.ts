import { initializeApp } from 'firebase/app';
import {
  ensureInitialized, fetchAndActivate, getRemoteConfig, getValue, isSupported, setLogLevel,
} from 'firebase/remote-config';
import type { AppConfig } from '../config';
import { builtInSettings, HARD_DAILY_CLOUD_BUDGET, type SettingsKey, type SettingsSnapshot } from './defaults';
import { isBundledPromptSet } from './promptSets';

type RemoteEntry = { source: 'remote' | 'default' | 'static'; value: string };
type RemoteResponse = { entries: Partial<Record<SettingsKey, RemoteEntry>>; fetchTime: number | null };
export type SettingsAdapter = { fetch(config: AppConfig, signal: AbortSignal): Promise<RemoteResponse | null> };
const keys: SettingsKey[] = ['cloud_enabled', 'cloud_model', 'prompt_set', 'daily_cloud_budget'];
const allowedModels = new Set(['gemini-3.5-flash-lite']);

export function validateRemote(response: RemoteResponse): SettingsSnapshot {
  const result = builtInSettings();
  result.fetchTime = typeof response.fetchTime === 'number' && Number.isFinite(response.fetchTime) &&
    response.fetchTime >= 0 ? response.fetchTime : null;
  for (const key of keys) {
    const entry = response.entries[key];
    if (!entry || entry.source !== 'remote') continue;
    if (typeof entry.value !== 'string') {
      result.sources[key] = 'remote-rejected';
      continue;
    }
    const value = entry.value.trim();
    let accepted = false;
    if (key === 'cloud_enabled' && (value === 'true' || value === 'false')) {
      result.values.cloud_enabled = value === 'true';
      accepted = true;
    } else if (key === 'cloud_model' && allowedModels.has(value)) {
      result.values.cloud_model = 'gemini-3.5-flash-lite';
      accepted = true;
    } else if (key === 'prompt_set' && isBundledPromptSet(value)) {
      result.values.prompt_set = value;
      accepted = true;
    } else if (key === 'daily_cloud_budget' && /^\d+$/.test(value)) {
      const budget = Number(value);
      if (Number.isSafeInteger(budget) && budget >= 0 && budget <= HARD_DAILY_CLOUD_BUDGET) {
        result.values.daily_cloud_budget = budget;
        accepted = true;
      }
    }
    result.sources[key] = accepted ? 'remote' : 'remote-rejected';
  }
  return result;
}

export const sdkAdapter: SettingsAdapter = {
  async fetch(config, signal) {
    if (!(await isSupported()) || signal.aborted) return null;
    // Dedicated named app keeps Remote Config's own storage/installation separate from app content.
    const app = initializeApp({ apiKey: config.apiKey, authDomain: config.authDomain,
      projectId: config.projectId, appId: config.appId }, 'thoughtpartner-settings');
    const remote = getRemoteConfig(app);
    setLogLevel(remote, 'silent');
    remote.settings.minimumFetchIntervalMillis = 60 * 60 * 1000;
    remote.settings.fetchTimeoutMillis = 8000;
    remote.defaultConfig = { ...builtInSettings().values };
    await ensureInitialized(remote);
    if (signal.aborted) return null;
    await fetchAndActivate(remote);
    if (signal.aborted) return null;
    const entries: RemoteResponse['entries'] = {};
    for (const key of keys) {
      const entry = getValue(remote, key);
      entries[key] = { source: entry.getSource(), value: entry.asString() };
    }
    return { entries, fetchTime: remote.fetchTimeMillis >= 0 ? remote.fetchTimeMillis : null };
  },
};

export function createSettingsLoader(adapter: SettingsAdapter, timeoutMs = 10000) {
  let startup: Promise<SettingsSnapshot> | undefined;
  return function load(config: AppConfig | null): Promise<SettingsSnapshot> {
    if (!config) return Promise.resolve(builtInSettings());
    if (!startup) {
      startup = new Promise<SettingsSnapshot>((resolve) => {
        let settled = false;
        const finish = (snapshot: SettingsSnapshot) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(snapshot);
        };
        const controller = new AbortController();
        const timer = setTimeout(() => {
          controller.abort();
          finish(builtInSettings());
        }, Math.min(10000, Math.max(0, timeoutMs)));
        Promise.resolve().then(() => adapter.fetch(config, controller.signal)).then(
          (response) => {
            try {
              finish(response ? validateRemote(response) : builtInSettings());
            } catch {
              finish(builtInSettings());
            }
          },
          () => finish(builtInSettings()),
        );
      });
    }
    return startup;
  };
}
export const loadSettings = createSettingsLoader(sdkAdapter);
