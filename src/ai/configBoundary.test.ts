import { expect, it, vi } from 'vitest';
import { readConfig } from '../config';
import { LocalModelService } from './localModel';
import { makeFirebaseModel } from './firebase';

vi.mock('firebase/app', () => ({ initializeApp: vi.fn() }));
vi.mock('firebase/app-check', () => ({ initializeAppCheck: vi.fn(), ReCaptchaEnterpriseProvider: vi.fn() }));
vi.mock('firebase/ai', () => ({
  getAI: vi.fn(),
  getGenerativeModel: vi.fn(),
  GoogleAIBackend: vi.fn(),
  InferenceMode: { ONLY_ON_DEVICE: 'only_on_device' },
}));
import { initializeApp } from 'firebase/app';
import { getAI, getGenerativeModel } from 'firebase/ai';

it.each([
  {},
  {
    VITE_FIREBASE_API_KEY: 'YOUR_FIREBASE_API_KEY',
    VITE_FIREBASE_AUTH_DOMAIN: 'YOUR_FIREBASE_AUTH_DOMAIN',
    VITE_FIREBASE_PROJECT_ID: 'YOUR_FIREBASE_PROJECT_ID',
    VITE_FIREBASE_APP_ID: 'YOUR_FIREBASE_APP_ID',
    VITE_RECAPTCHA_ENTERPRISE_SITE_KEY: 'YOUR_RECAPTCHA_ENTERPRISE_SITE_KEY',
  },
])('never enters Firebase for absent or placeholder config', async (env) => {
  const config = readConfig(env);
  const availability = vi.fn(async () => 'available');
  const service = new LocalModelService({
    configured: config !== null,
    hasApi: () => true,
    availability,
    createModel: () => makeFirebaseModel(config!),
    isForeground: () => true,
    onForeground: () => () => {},
    now: () => 0,
  });
  await service.probe();
  expect(service.browserAvailability).toBe('available');
  await expect(service.runLocal({ prompt: 'test', schema: {} })).rejects.toMatchObject({
    code: 'not-configured',
  });
  await expect(service.prepare()).rejects.toMatchObject({ code: 'not-configured' });
  expect(initializeApp).not.toHaveBeenCalled();
  expect(getAI).not.toHaveBeenCalled();
  expect(getGenerativeModel).not.toHaveBeenCalled();
});
