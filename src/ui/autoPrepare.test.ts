import { describe, expect, it, vi } from 'vitest';
import type { LocalModelService } from '../ai/localModel';
import { startAutoPrepare } from './autoPrepare';

function fixture(availability: string, configured = true, api = true, visible = true) {
  let listener = () => {};
  const service = {
    state: { kind: 'unsupported' }, browserAvailability: 'not checked', preparing: false,
    probe: vi.fn(async () => {
      service.browserAvailability = api ? availability : 'unsupported';
      service.state.kind = !api ? 'unsupported' : availability === 'available' ? 'downloadable' : availability;
    }),
    prepare: vi.fn(async () => { service.state.kind = 'ready'; }),
  };
  const env = { hasApi: () => api, foreground: () => visible,
    onVisibility: (callback: () => void) => { listener = callback; return () => { listener = () => {}; }; } };
  const start = () => startAutoPrepare(service as unknown as LocalModelService, configured, env);
  return { service, start, setVisible: (value: boolean) => { visible = value; listener(); },
    setApi: (value: boolean) => { api = value; } };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
describe('guarded automatic readiness', () => {
  it('prepares an already available model once', async () => {
    const f = fixture('available');
    const stop = f.start();
    await flush();
    expect(f.service.prepare).toHaveBeenCalledTimes(1);
    f.setVisible(false); f.setVisible(true);
    expect(f.service.prepare).toHaveBeenCalledTimes(1);
    stop();
  });
  it.each(['downloadable', 'downloading', 'unavailable', 'unsupported', 'error'])(
    'never auto-prepares availability %s', async availability => {
      const f = fixture(availability);
      const stop = f.start();
      await flush();
      expect(f.service.prepare).not.toHaveBeenCalled();
      stop();
    },
  );
  it('waits for foreground and rechecks API presence', async () => {
    const f = fixture('available', true, true, false);
    const stop = f.start();
    await flush();
    expect(f.service.prepare).not.toHaveBeenCalled();
    f.setApi(false); f.setVisible(true);
    expect(f.service.prepare).not.toHaveBeenCalled();
    f.setApi(true); f.setVisible(false); f.setVisible(true);
    expect(f.service.prepare).toHaveBeenCalledTimes(1);
    stop();
  });
  it('never auto-prepares without config or without the browser API', async () => {
    for (const f of [fixture('available', false), fixture('available', true, false)]) {
      const stop = f.start();
      await flush();
      expect(f.service.prepare).not.toHaveBeenCalled();
      stop();
    }
  });
  it('does not automatically retry a failed preparation or act after cleanup', async () => {
    const f = fixture('available');
    f.service.prepare.mockRejectedValueOnce(new Error('synthetic failure'));
    const stop = f.start();
    await flush();
    f.setVisible(false); f.setVisible(true);
    expect(f.service.prepare).toHaveBeenCalledTimes(1);
    stop();
    f.setVisible(false); f.setVisible(true);
    expect(f.service.prepare).toHaveBeenCalledTimes(1);
  });
});
