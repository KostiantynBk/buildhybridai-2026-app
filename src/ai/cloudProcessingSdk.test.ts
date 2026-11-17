import { deleteApp, initializeApp } from 'firebase/app';
import { getAI, GoogleAIBackend } from 'firebase/ai';
import { expect, it, vi } from 'vitest';
import { extractV2 } from '../pipeline/prompts/extract.v2';
import type { AppConfig } from '../config';

const holder = vi.hoisted(() => ({ ai: null as unknown }));
vi.mock('./firebase', () => ({ firebaseAI: () => holder.ai }));
import { createProcessingAdapter } from './cloudProcessing';

it('sends frozen instructions, examples, prompt and schema via the real SDK with mocked fetch', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ candidates: [
    { content: { role: 'model', parts: [{ text: '{"items":[]}' }] }, finishReason: 'STOP' },
  ] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetch);
  const app = initializeApp({ apiKey: 'example', projectId: 'example', appId: 'example' },
    `processing-sdk-${crypto.randomUUID()}`);
  try {
    holder.ai = getAI(app, { backend: new GoogleAIBackend(), useLimitedUseAppCheckTokens: true });
    const adapter = createProcessingAdapter({} as AppConfig);
    const result = await adapter({ prompt: 'Changed paragraph sentinel', schema: extractV2.schema,
      instructions: extractV2 }, 'example-model');
    expect(result.source).toBe('in_cloud');
    expect(fetch).toHaveBeenCalledOnce();
    const request = fetch.mock.calls[0][1] as RequestInit;
    const body = String(request.body);
    expect(body).toContain('Changed paragraph sentinel');
    expect(body).toContain('responseJsonSchema');
    expect(body).not.toContain('PROFILE_SENTINEL');
    expect(body).not.toContain('NEVER_SEND_SENTINEL');
  } finally { await deleteApp(app); vi.unstubAllGlobals(); }
});
