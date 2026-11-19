import { deleteApp, initializeApp } from 'firebase/app';
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode } from 'firebase/ai';
import { expect, it, vi } from 'vitest';
import { researchApproved } from './researchFlow';
import { CloudProcessingService } from './cloudProcessing';
import { extract } from '../pipeline/extract';

it.each(['research', 'processing'] as const)('retries SDK-wrapped fetch errors once in %s', async route => {
  for (const persistent of [false, true]) {
    const response = () => new Response(JSON.stringify({ candidates: [{ content: { role: 'model',
      parts: [{ text: '{"items":[]}' }] }, finishReason: 'STOP' }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } });
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch'));
    if (persistent) fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    else fetch.mockResolvedValueOnce(response());
    vi.stubGlobal('fetch', fetch);
    const app = initializeApp({ apiKey: 'example', projectId: 'example', appId: 'example' },
      `network-test-${crypto.randomUUID()}`);
    try {
      const ai = getAI(app, { backend: new GoogleAIBackend(), useLimitedUseAppCheckTokens: true });
      const model = getGenerativeModel(ai, { mode: InferenceMode.ONLY_IN_CLOUD,
        inCloudParams: { model: 'example' } });
      if (route === 'research') {
        const entry = { id: 'e', question: 'Public question?', keptOut: [], cardId: 'c', itemLineageId: 'l',
          itemVersion: 1, status: 'approved', createdAt: 1 };
        const store = { snapshot: vi.fn().mockResolvedValue({ outbox: [entry] }),
          preSendCheck: vi.fn().mockResolvedValue({ allowed: true }), cloudConsent: vi.fn().mockResolvedValue(true),
          reserveResearch: vi.fn().mockResolvedValue(1), cancelResearch: vi.fn().mockResolvedValue(undefined),
          finishResearch: vi.fn().mockResolvedValue(undefined) };
        const adapter = async (question: string) => {
          await model.generateContent(question);
          return { source: 'in_cloud', result: { text: 'Example', parts: ['Example'], sources: [], supports: [],
            suggestions: '', grounded: false } };
        };
        const call = researchApproved(store, adapter, 'e', 'example');
        if (persistent) await expect(call).rejects.toThrow('Network error while researching');
        else expect((await call).attempts).toBe(2);
        expect(store.reserveResearch).toHaveBeenCalledTimes(2);
      } else {
        const store = { cloudModeConsent: vi.fn().mockResolvedValue(true),
          reserveCloudProcessing: vi.fn().mockResolvedValue(1), cancelCloudProcessingReservation: vi.fn() };
        const adapter = async () => {
          const result = await model.generateContent('fixture');
          return { source: result.response.inferenceSource, text: result.response.text() };
        };
        const service = new CloudProcessingService(store, adapter, () => true, () => 'example', () => {});
        const call = extract(job => service.runLocal(job), 'My plan', 'fixture', undefined, 'extract.v2');
        if (persistent) await expect(call).rejects.toThrow('Network error during cloud processing');
        else await expect(call).resolves.toMatchObject({ items: [] });
        expect(store.reserveCloudProcessing).toHaveBeenCalledTimes(2);
      }
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally { await deleteApp(app); vi.unstubAllGlobals(); }
  }
});
