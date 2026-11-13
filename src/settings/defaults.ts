export type SettingSource = 'defaults' | 'remote' | 'remote-rejected';
export type PromptSet = 'v1' | 'v2';
export interface SettingsValues {
  cloud_enabled: boolean;
  cloud_model: 'gemini-3.5-flash-lite';
  prompt_set: PromptSet;
  daily_cloud_budget: number;
}
export type SettingsKey = keyof SettingsValues;
export interface SettingsSnapshot {
  values: SettingsValues;
  sources: Record<SettingsKey, SettingSource>;
  fetchTime: number | null;
}
export const HARD_DAILY_CLOUD_BUDGET = 20;
export function builtInSettings(): SettingsSnapshot {
  return {
    values: { cloud_enabled: true, cloud_model: 'gemini-3.5-flash-lite', prompt_set: 'v2',
      daily_cloud_budget: HARD_DAILY_CLOUD_BUDGET },
    sources: { cloud_enabled: 'defaults', cloud_model: 'defaults', prompt_set: 'defaults',
      daily_cloud_budget: 'defaults' },
    fetchTime: null,
  };
}
