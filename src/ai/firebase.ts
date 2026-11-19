import { initializeApp } from 'firebase/app';
import {
  CustomProvider,
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
} from 'firebase/app-check';
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode } from 'firebase/ai';
import type { AppConfig } from '../config';
import { languageOptions, LocalError, type Model, type PromptContext } from './localModel';
import { enableDevelopmentAppCheckDebug } from './debugDev';

type PromptApi = { availability(options: typeof languageOptions): Promise<string> };
export function browserApi(): PromptApi | undefined {
  return (globalThis as typeof globalThis & { LanguageModel?: PromptApi }).LanguageModel;
}

let instance: ReturnType<typeof getAI> | undefined;
const models = new Map<string, ReturnType<typeof getGenerativeModel>>();
export function firebaseAI(config: AppConfig): ReturnType<typeof getAI> {
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
    if (import.meta.env.DEV && config.dev && config.debug) enableDevelopmentAppCheckDebug();
    const provider =
      import.meta.env.DEV && config.dev && config.debug
        ? new CustomProvider({
            getToken: async () => {
              throw new Error('Debug provider is unavailable.');
            },
          })
        : new ReCaptchaEnterpriseProvider(config.siteKey);
    initializeAppCheck(app, { provider, isTokenAutoRefreshEnabled: true });
    instance = getAI(app, { backend: new GoogleAIBackend(), useLimitedUseAppCheckTokens: true });
  }
  return instance;
}
export function makeFirebaseModel(config: AppConfig): Model {
  if (!browserApi()) {
    throw new LocalError('unsupported', 'The local model API is unavailable.');
  }
  const ai = firebaseAI(config);
  function local(schema: object, instructions?: PromptContext) {
    if (!browserApi()) {
      throw new LocalError('unsupported', 'The local model API is unavailable.');
    }
    const key = JSON.stringify({ schema, instructions });
    let model = models.get(key);
    if (!model) {
      const initialPrompts = instructions
        ? [
            {
              role: 'system' as const,
              content: [{ type: 'text' as const, value: instructions.system }],
            },
            ...(instructions.exampleInput !== undefined && instructions.exampleOutput !== undefined ? [
              { role: 'user' as const, content: [{ type: 'text' as const, value: instructions.exampleInput }] },
              { role: 'assistant' as const, content: [{ type: 'text' as const, value: instructions.exampleOutput }] },
            ] : []),
            ...(instructions.additionalExamples ?? []).flatMap((example) => [
              { role: 'user' as const, content: [{ type: 'text' as const, value: example.input }] },
              {
                role: 'assistant' as const,
                content: [{ type: 'text' as const, value: example.output }],
              },
            ]),
          ]
        : undefined;
      model = getGenerativeModel(ai, {
        mode: InferenceMode.ONLY_ON_DEVICE,
        onDeviceParams: {
          createOptions: { ...languageOptions, initialPrompts },
          promptOptions: { responseConstraint: schema },
        },
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
    async generate(prompt, schema, instructions) {
      const model = local(schema, instructions);
      // Recheck immediately before the SDK call; no preferred/cloud route exists here.
      if (!browserApi()) {
        throw new LocalError('unsupported', 'The local model API is unavailable.');
      }
      const result = await model.generateContent(prompt);
      return { source: result.response.inferenceSource, text: () => result.response.text() };
    },
  };
}
