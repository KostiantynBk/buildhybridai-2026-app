import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import EvalPage from './EvalPage';

const service = {
  state: { kind: 'unsupported' },
  browserAvailability: 'unsupported',
  preparing: false,
  warmLatencyMs: null,
  privacyFaults: 0,
  subscribe: () => () => {},
  probe: async () => {},
  prepare: async () => {},
  runLocal: async () => {
    throw new Error('blocked');
  },
};
vi.mock('../ui/service', () => ({
  config: null,
  createService: () => service,
  useForeground: () => true,
}));

it('renders the dev evaluation controls with no config and all run buttons disabled', () => {
  const html = renderToStaticMarkup(<EvalPage />);
  expect(html).toContain('Firebase is not configured: AI features are off');
  expect(html).toMatch(/<button disabled=""[^>]*>Run local practice<\/button>/);
  expect(html).toMatch(/<button disabled=""[^>]*>Start Run 1<\/button>/);
  expect(html).toMatch(/<button disabled=""[^>]*>Start latency gate and curve<\/button>/);
});
