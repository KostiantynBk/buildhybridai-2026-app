import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  model: vi.fn(() => ({
    generateContent: async () => ({ response: { inferenceSource: 'on_device', text: () => '{}' } }),
  })),
}));
vi.mock('firebase/app', () => ({ initializeApp: vi.fn(() => ({})) }));
vi.mock('firebase/app-check', () => ({
  initializeAppCheck: vi.fn(),
  ReCaptchaEnterpriseProvider: class {},
  CustomProvider: class {},
}));
vi.mock('firebase/ai', () => ({
  getAI: vi.fn(() => ({})),
  getGenerativeModel: mocks.model,
  GoogleAIBackend: class {},
  InferenceMode: { ONLY_ON_DEVICE: 'only_on_device' },
}));
import { makeFirebaseModel } from './firebase';

afterEach(() => vi.unstubAllGlobals());
it('passes the exact fixed turns and schema to ONLY_ON_DEVICE', async () => {
  vi.stubGlobal('LanguageModel', { availability: vi.fn() });
  const adapter = makeFirebaseModel({
    apiKey: 'example',
    authDomain: 'example',
    projectId: 'example',
    appId: 'example',
    siteKey: 'example',
    dev: false,
    debug: false,
  });
  const schema = { type: 'object' };
  await adapter.generate('input', schema, {
    system: 'system text',
    exampleInput: 'example input',
    exampleOutput: 'example output',
  });
  expect(mocks.model).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      mode: 'only_on_device',
      onDeviceParams: expect.objectContaining({
        promptOptions: { responseConstraint: schema },
        createOptions: expect.objectContaining({
          initialPrompts: [
            { role: 'system', content: [{ type: 'text', value: 'system text' }] },
            { role: 'user', content: [{ type: 'text', value: 'example input' }] },
            { role: 'assistant', content: [{ type: 'text', value: 'example output' }] },
          ],
        }),
      }),
    }),
  );
  await adapter.generate('input', schema, {
    system: 'system v2',
    exampleInput: 'example A input',
    exampleOutput: 'example A output',
    additionalExamples: [{ input: 'example B input', output: 'example B output' }],
  });
  expect(mocks.model).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({
      mode: 'only_on_device',
      onDeviceParams: expect.objectContaining({
        promptOptions: { responseConstraint: schema },
        createOptions: expect.objectContaining({
          initialPrompts: [
            { role: 'system', content: [{ type: 'text', value: 'system v2' }] },
            { role: 'user', content: [{ type: 'text', value: 'example A input' }] },
            { role: 'assistant', content: [{ type: 'text', value: 'example A output' }] },
            { role: 'user', content: [{ type: 'text', value: 'example B input' }] },
            { role: 'assistant', content: [{ type: 'text', value: 'example B output' }] },
          ],
        }),
      }),
    }),
  );
  vi.stubGlobal('LanguageModel', undefined);
  await expect(
    adapter.generate('input', schema, {
      system: 'system text',
      exampleInput: 'example input',
      exampleOutput: 'example output',
    }),
  ).rejects.toMatchObject({ code: 'unsupported' });
});
