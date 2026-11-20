import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { Welcome } from './Welcome';
import { Notices } from './Notices';
import type { State } from '../ai/localModel';

const noop = () => {};
function render(state: State, cloudMode = false, sampleAvailable = true, browserAvailability = 'not checked') {
  return renderToStaticMarkup(<Welcome state={state} configured foreground preparing={false} cloudMode={cloudMode}
    cloudEnabled sampleAvailable={sampleAvailable} browserAvailability={browserAvailability}
    chooseCloud={noop} download={noop} checkAgain={noop}
    trySample={noop} startBlank={noop} />);
}
it('shows the product promise and model readiness for first run', () => {
  const html = render({ kind: 'ready' });
  expect(html).toContain('<h2 id="welcome-title">Welcome</h2>');
  expect(html).not.toContain('An independent second opinion on your plan.');
  expect(html).toContain('Your browser can run the on-device model.');
  expect(html).toContain('Nothing from your plan is sent until you approve it.');
  expect(html).not.toContain('Firebase contacts Google');
  expect(html).toContain('Try a sample plan');
  expect(html).toContain('Start blank');
});
it('does not claim an already available model needs downloading', () => {
  const html = render({ kind: 'downloadable' }, false, true, 'available');
  expect(html).toContain('Your browser can run the on-device model.');
  expect(html).toContain('Set up model');
  expect(html).not.toContain('needs to download');
});
it('keeps setup and cloud choices hidden while downloading or warming', () => {
  for (const state of [{ kind: 'downloading', progress: 0.4 }, { kind: 'warming' }] as State[]) {
    const html = render(state);
    expect(html).not.toContain('Set up Gemma 4');
    expect(html).not.toContain('Use cloud mode instead');
    const notices = renderToStaticMarkup(<Notices configured state={state} cloudEnabled chooseCloud={noop} />);
    expect(notices).not.toContain('Use cloud mode instead');
    expect(notices).not.toContain('Set up Chrome');
  }
});
it('shows real model download progress', () => {
  expect(render({ kind: 'downloadable' })).toContain('Download model');
  const html = render({ kind: 'downloading', progress: 0.4 });
  expect(html).toContain('40%');
  expect(html).toContain('Model download progress');
});
it.each(['unsupported', 'unavailable'] as const)('offers setup or explicit cloud choice when %s', kind => {
  const html = render({ kind });
  expect(html).toContain('Set up Gemma 4 in Chrome');
  expect(html).toContain('Use cloud mode instead');
});
it('names its buttons and provides a live readiness region in every displayed state', () => {
  const states: State[] = [{ kind: 'ready' }, { kind: 'downloadable' }, { kind: 'unsupported' },
    { kind: 'unavailable' }, { kind: 'downloading', progress: 0.4 }, { kind: 'warming' }];
  for (const state of states) {
    const html = render(state);
    expect(html).toContain('role="status"');
    for (const button of html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)) {
      expect(button[1].replace(/<[^>]*>/g, '').trim()).not.toBe('');
    }
  }
});
it('uses cloud-mode privacy copy and hides sample when unavailable', () => {
  const html = render({ kind: 'unsupported' }, true, false);
  expect(html).toContain('cloud mode sends plan inputs to Google');
  expect(html).not.toContain('Try a sample plan');
});
