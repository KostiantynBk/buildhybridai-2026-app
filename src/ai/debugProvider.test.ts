import { expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  initializeApp: vi.fn(() => ({})),
  initializeAppCheck: vi.fn(),
  getAI: vi.fn(() => ({})),
  custom: vi.fn(),
  enterprise: vi.fn(),
}));
vi.mock('firebase/app', () => ({ initializeApp: mocks.initializeApp }));
vi.mock('firebase/app-check', () => ({
  initializeAppCheck: mocks.initializeAppCheck,
  CustomProvider: class {
    constructor(options: unknown) {
      mocks.custom(options);
    }
  },
  ReCaptchaEnterpriseProvider: class {
    constructor(siteKey: string) {
      mocks.enterprise(siteKey);
    }
  },
}));
vi.mock('firebase/ai', () => ({
  getAI: mocks.getAI,
  getGenerativeModel: vi.fn(),
  GoogleAIBackend: class {},
  InferenceMode: { ONLY_ON_DEVICE: 'only_on_device' },
}));
import { makeFirebaseModel } from './firebase';

it('uses a fail-closed custom provider without constructing reCAPTCHA in dev debug mode', async () => {
  vi.stubGlobal('self', globalThis);
  vi.stubGlobal('LanguageModel', { availability: vi.fn() });
  try {
    makeFirebaseModel({
      apiKey: 'example',
      authDomain: 'example',
      projectId: 'example',
      appId: 'example',
      siteKey: '',
      dev: true,
      debug: true,
    });
    expect(mocks.custom).toHaveBeenCalledTimes(1);
    expect(mocks.enterprise).not.toHaveBeenCalled();
    expect(mocks.getAI).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      useLimitedUseAppCheckTokens: true,
    }));
    const options = mocks.custom.mock.calls[0][0] as { getToken: () => Promise<unknown> };
    await expect(options.getToken()).rejects.toThrow('Debug provider is unavailable.');
  } finally {
    delete (globalThis as Record<string, unknown>)[['FIREBASE', 'APPCHECK', 'DEBUG', 'TOKEN'].join('_')];
    vi.unstubAllGlobals();
  }
});
