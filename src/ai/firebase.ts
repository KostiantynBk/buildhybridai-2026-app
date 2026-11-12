import { initializeApp } from 'firebase/app';
import { CustomProvider, initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode } from 'firebase/ai';
import type { AppConfig } from '../config';
import { languageOptions, LocalError, type Model } from './localModel';

export type CloudPlaceholder = { status: 'not-implemented' };
export const cloud: CloudPlaceholder = { status: 'not-implemented' };

type PromptApi = { availability(options: typeof languageOptions): Promise<string> };
export function browserApi(): PromptApi | undefined {
  return (globalThis as typeof globalThis & { LanguageModel?: PromptApi }).LanguageModel;
}

let instance: ReturnType<typeof getAI> | undefined;
const models = new Map<string, ReturnType<typeof getGenerativeModel>>();
export function makeFirebaseModel(config: AppConfig): Model {
  if (!browserApi()) {
    throw new LocalError('unsupported', 'The local model API is unavailable.');
  }
  if (!instance) {
    const app = initializeApp(
      {
        apiKey: config.apiKey,
        authDomain: config.authDomain,
        projectId: config.projectId,
        appId: config.appId,
      },
      'thoughtpartner',
    );
    if (config.dev && config.debug) {
      (self as typeof self & { FIREBASE_APPCHECK_DEBUG_TOKEN?: boolean }).FIREBASE_APPCHECK_DEBUG_TOKEN =
        true;
    }
    const provider =
      config.dev && config.debug
        ? new CustomProvider({
            getToken: async () => {
              throw new Error('Debug provider is unavailable.');
            },
          })
        : new ReCaptchaEnterpriseProvider(config.siteKey);
    initializeAppCheck(app, { provider, isTokenAutoRefreshEnabled: true });
    instance = getAI(app, { backend: new GoogleAIBackend() });
  }
  const ai = instance;
  function local(schema: object) {
    if (!browserApi()) {
      throw new LocalError('unsupported', 'The local model API is unavailable.');
    }
    const key = JSON.stringify(schema);
    let model = models.get(key);
    if (!model) {
      model = getGenerativeModel(ai, {
        mode: InferenceMode.ONLY_ON_DEVICE,
        onDeviceParams: { createOptions: languageOptions, promptOptions: { responseConstraint: schema } },
      });
      models.set(key, model);
    }
    return model;
  }
  return {
    async prepare(progress) {
      const emptySchema = { type: 'object', properties: {} };
      await local(emptySchema).initializeDeviceModel(progress);
    },
    async generate(prompt, schema) {
      const model = local(schema);
      // Recheck immediately before the SDK call; no preferred/cloud route exists here.
      if (!browserApi()) {
        throw new LocalError('unsupported', 'The local model API is unavailable.');
      }
      const result = await model.generateContent(prompt);
      return { source: result.response.inferenceSource, text: () => result.response.text() };
    },
  };
}
