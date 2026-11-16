import { builtInSettings, type SettingsSnapshot, type SettingsValues } from '../settings/defaults';

export type Run4Provenance = { model: string; promptVersion: 'research.v2';
  settings: SettingsSnapshot; builtInDefaults: SettingsValues; remoteNarrowed: boolean };
export function run4Provenance(settings: SettingsSnapshot, model: string): Run4Provenance {
  const baseline = builtInSettings().values;
  const snapshot = { values: { ...settings.values }, sources: { ...settings.sources }, fetchTime: settings.fetchTime };
  const remoteNarrowed = (snapshot.sources.cloud_enabled === 'remote' && !snapshot.values.cloud_enabled &&
    baseline.cloud_enabled) || (snapshot.sources.daily_cloud_budget === 'remote' &&
      snapshot.values.daily_cloud_budget < baseline.daily_cloud_budget);
  return { model, promptVersion: 'research.v2', settings: snapshot, builtInDefaults: { ...baseline }, remoteNarrowed };
}
