import { deleteApp, initializeApp } from 'firebase/app';
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode } from 'firebase/ai';
import { expect, it, vi } from 'vitest';
import { researchApproved } from './researchFlow';
import type { CloudAdapter } from './cloudResearch';

it.each(['Too many requests', 'Network request failed'])('does not retry SDK HTTP 429: %s', async message => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message } }), {
    status: 429, headers: { 'Content-Type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fetch);
  const app = initializeApp({ apiKey: 'example', projectId: 'example', appId: 'example' },
    `status-test-${crypto.randomUUID()}`);
  try {
    const ai = getAI(app, { backend: new GoogleAIBackend(), useLimitedUseAppCheckTokens: true });
    const model = getGenerativeModel(ai, { mode: InferenceMode.ONLY_IN_CLOUD,
      inCloudParams: { model: 'example', tools: [{ googleSearch: {} }] } });
    const adapter: CloudAdapter = async question => {
      await model.generateContent(question);
      throw new Error('Unexpected success');
    };
    const entry = { id: 'e', question: 'Public question?', keptOut: [], cardId: 'c', itemLineageId: 'l',
      itemVersion: 1, status: 'approved', createdAt: 1 };
    const store = { snapshot: vi.fn().mockResolvedValue({ outbox: [entry] }),
      preSendCheck: vi.fn().mockResolvedValue({ allowed: true }), cloudConsent: vi.fn().mockResolvedValue(true),
      reserveResearch: vi.fn().mockResolvedValue(1), cancelResearch: vi.fn().mockResolvedValue(undefined),
      finishResearch: vi.fn().mockResolvedValue(undefined) };
    await expect(researchApproved(store, adapter, 'e', 'example')).rejects.toThrow('quota');
    expect(fetch).toHaveBeenCalledOnce();
    expect(store.finishResearch).toHaveBeenCalledWith(1, 'failed', 'quota');
  } finally { await deleteApp(app); vi.unstubAllGlobals(); }
});
