import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import EvalPage from './EvalPage';

const service = {
  state: { kind: 'ready' },
  browserAvailability: 'available',
  preparing: false,
  warmLatencyMs: null,
  privacyFaults: 0,
  subscribe: () => () => {},
  probe: async () => {},
  prepare: async () => {},
  runLocal: async () => {
    throw new Error('not called');
  },
};
vi.mock('../ui/service', () => ({
  config: {},
  createService: () => service,
  useForeground: () => true,
}));

it('permits practice but blocks measured runs until the model identity is entered', () => {
  const html = renderToStaticMarkup(<EvalPage />);
  expect(html).toContain(
    'On-device model (as read from chrome://on-device-internals → Broker State)',
  );
  expect(html).toMatch(/<button>Run local practice<\/button>/);
  expect(html).toMatch(/<button disabled=""[^>]*>Start Run 1<\/button>/);
  expect(html).toMatch(/<button disabled=""[^>]*>Start latency gate and curve<\/button>/);
  expect(html).toContain('Enter the on-device model name and version.');
  expect(html).toContain('No measured run is active to cancel.');
  expect(html).toContain('Complete or stop a measured run before exporting.');
  expect(html).toContain('maxLength="200"');
  expect(html).toContain('<option value="extract.v2" selected="">extract.v2</option>');
  expect(html).toContain('<option value="extract.v1">extract.v1</option>');
});
