import { deleteApp, initializeApp } from 'firebase/app';
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode } from 'firebase/ai';
import { expect, it, vi } from 'vitest';

it('uses the limited-use App Check token path in the installed SDK, with fetch mocked', async () => {
  const limited = vi.fn().mockResolvedValue({ token: 'test-token' });
  const regular = vi.fn().mockResolvedValue({ token: 'wrong-token' });
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ candidates: [
    { content: { role: 'model', parts: [{ text: 'mock answer' }] }, finishReason: 'STOP' },
  ] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetch);
  const app = initializeApp({ apiKey: 'example', projectId: 'example', appId: 'example' },
    `limited-token-test-${crypto.randomUUID()}`);
  try {
    const ai = getAI(app, { backend: new GoogleAIBackend(), useLimitedUseAppCheckTokens: true });
    (ai as unknown as { appCheck: unknown }).appCheck = { getLimitedUseToken: limited, getToken: regular };
    const model = getGenerativeModel(ai, { mode: InferenceMode.ONLY_IN_CLOUD,
      inCloudParams: { model: 'example', tools: [{ googleSearch: {} }] } });
    await model.generateContent('public test question');
    expect(limited).toHaveBeenCalledOnce();
    expect(regular).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
  } finally {
    await deleteApp(app);
    vi.unstubAllGlobals();
  }
});
