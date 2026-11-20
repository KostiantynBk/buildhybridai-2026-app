import { expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LocalModelService } from '../ai/localModel';
import { StatusBar, canPrepare, modelLabel, prepareDisabledReason, settingsLabel, showPrepare } from './StatusBar';
import { builtInSettings } from '../settings/defaults';

it('uses clear local readiness labels rather than raw state names', () => {
  expect(modelLabel({ kind: 'downloadable' })).toBe('not prepared yet');
  expect(modelLabel({ kind: 'downloading', progress: 0.4 })).toBe('downloading 40%');
  expect(modelLabel({ kind: 'warming' })).toBe('warming up');
  expect(modelLabel({ kind: 'ready' })).toBe('ready');
});

it('shows built-in, validated remote and rejected-source settings plainly', () => {
  const snapshot = builtInSettings();
  expect(settingsLabel(snapshot)).toBe('built-in');
  snapshot.sources.cloud_enabled = 'remote';
  snapshot.fetchTime = 1234;
  expect(settingsLabel(snapshot)).toContain('from Firebase');
  snapshot.sources.prompt_set = 'remote-rejected';
  expect(settingsLabel(snapshot)).toContain('some values rejected');
});

it('shows preparation only for downloads or errors and explains disabled controls', () => {
  expect(showPrepare({ kind: 'downloadable' }, 'available')).toBe(false);
  expect(showPrepare({ kind: 'downloadable' }, 'available', true)).toBe(true);
  expect(showPrepare({ kind: 'downloadable' }, 'downloadable')).toBe(true);
  expect(showPrepare({ kind: 'downloading', progress: 0 }, 'downloading')).toBe(true);
  expect(showPrepare({ kind: 'error', reason: 'failed' }, 'available')).toBe(true);
  expect(showPrepare({ kind: 'unavailable' }, 'unavailable')).toBe(false);
  expect(showPrepare({ kind: 'unavailable' }, 'unavailable', true)).toBe(true);
  expect(showPrepare({ kind: 'ready' }, 'available')).toBe(false);
  expect(prepareDisabledReason(false, true, false)).toContain('not configured');
  expect(prepareDisabledReason(true, false, false)).toContain('Return');
  expect(prepareDisabledReason(true, true, true)).toContain('progress');
});

it('keeps exactly one footer live status when the setup button is disabled', () => {
  const service = { state: { kind: 'downloadable' }, browserAvailability: 'downloadable', preparing: false,
    retryRequired: false, warmLatencyMs: null, privacyFaults: 0 } as unknown as LocalModelService;
  const html = renderToStaticMarkup(createElement(StatusBar, { service, configured: false, foreground: true }));
  expect((html.match(/role="status"/g) ?? [])).toHaveLength(1);
  expect(html).toContain('not configured');
});
it('enables retry only when configured, visible and not already preparing', () => {
  const error = { kind: 'error', reason: 'failed' } as const;
  expect(canPrepare(true, true, false, error)).toBe(true);
  expect(canPrepare(true, true, false, { kind: 'unavailable' })).toBe(true);
  expect(canPrepare(false, true, false, error)).toBe(false);
  expect(canPrepare(true, false, false, error)).toBe(false);
  expect(canPrepare(true, true, true, error)).toBe(false);
  expect(canPrepare(true, true, false, { kind: 'ready' })).toBe(false);
});
