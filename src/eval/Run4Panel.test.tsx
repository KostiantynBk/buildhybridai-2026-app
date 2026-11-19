import { expect, it } from 'vitest';
import { builtInSettings } from '../settings/defaults';
import { validateRemote } from '../settings/remoteSettings';
import { run4Provenance } from './run4Provenance';
import { run4Export } from './Run4Panel';

it('exports per-attempt immutable model/settings provenance and ratings without result data', () => {
  const defaults = builtInSettings();
  const first = run4Provenance(defaults, defaults.values.cloud_model);
  const remote = validateRemote({ entries: { daily_cloud_budget: { source: 'remote', value: '5' } }, fetchTime: 42 });
  const narrowed = run4Provenance(remote, remote.values.cloud_model);
  const rejected = validateRemote({ entries: { daily_cloud_budget: { source: 'remote', value: '99' } },
    fetchTime: 43 });
  const rejectedSnapshot = run4Provenance(rejected, rejected.values.cloud_model);
  defaults.values.daily_cloud_budget = 1;
  remote.values.daily_cloud_budget = 2;
  expect(first.settings.values.daily_cloud_budget).toBe(20);
  expect(first.model).toBe('gemini-3.5-flash-lite');
  expect(first.promptVersion).toBe('research.v2');
  expect(first.builtInDefaults.daily_cloud_budget).toBe(20);
  expect(first.remoteNarrowed).toBe(false);
  expect(narrowed.settings.values.daily_cloud_budget).toBe(5);
  expect(narrowed.settings.sources.daily_cloud_budget).toBe('remote');
  expect(narrowed.settings.fetchTime).toBe(42);
  expect(narrowed.remoteNarrowed).toBe(true);
  expect(rejectedSnapshot.settings.sources.daily_cloud_budget).toBe('remote-rejected');
  expect(rejectedSnapshot.settings.values.daily_cloud_budget).toBe(20);
  expect(rejectedSnapshot.remoteNarrowed).toBe(false);
  const report = run4Export([
    { id: 'attempt-1', questionId: 'e', latencyMs: null, sourceCount: null, suggestionsPresent: null,
      inCloud: null, grounded: null, displayed: false, provenance: first },
    { id: 'attempt-2', questionId: 'e', latencyMs: 8, sourceCount: 1, suggestionsPresent: true,
      inCloud: true, grounded: true, displayed: true, provenance: narrowed },
    { id: 'attempt-3', questionId: 'x', latencyMs: null, sourceCount: null, suggestionsPresent: null,
      inCloud: null, grounded: null, displayed: false, provenance: rejectedSnapshot },
  ], { 'attempt-2': { answers: 'yes', datedFact: 'no', alsoWorthKnowing: 'yes' } });
  expect(report.sends).toBe(3);
  expect(report.rows[0].ratings).toBeNull();
  expect(report.rows[0].provenance).toEqual(first);
  expect(report.rows[1].provenance).toEqual(narrowed);
  expect(report.rows[2].provenance).toEqual(rejectedSnapshot);
  expect(report.rows[1].ratings).toEqual({ answers: 'yes', datedFact: 'no', alsoWorthKnowing: 'yes' });
  expect(JSON.stringify(report)).not.toContain('result');
  expect(JSON.stringify(report)).not.toContain('SECRET-ANSWER');
  expect(JSON.stringify(report)).not.toContain('https://secret-source');
});
it('exports idea attempt provenance without grounded content', () => {
  const provenance = run4Provenance(builtInSettings(), 'model', 'research.idea.v1');
  const report = run4Export([{ id: 'idea-attempt', questionId: 'I1', latencyMs: 5, sourceCount: 3,
    suggestionsPresent: true, inCloud: true, grounded: true, displayed: true, provenance }], {});
  expect(report.promptVersion).toBe('research.idea.v1');
  expect(report.rows[0].provenance).toMatchObject({ thinkingLevel: 'HIGH', promptVersion: 'research.idea.v1' });
  expect(JSON.stringify(report)).not.toContain('RESULT_SENTINEL');
});
