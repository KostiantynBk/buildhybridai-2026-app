import { afterEach, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ getGenerativeModel: vi.fn(), generateContent: vi.fn() }));
vi.mock('firebase/ai', () => ({ getGenerativeModel: sdk.getGenerativeModel,
  InferenceMode: { ONLY_IN_CLOUD: 'cloud-only' } }));
vi.mock('./firebase', () => ({ firebaseAI: vi.fn(() => ({})) }));
import { CloudProcessingService, createProcessingAdapter } from './cloudProcessing';
import { extract } from '../pipeline/extract';
import { compare } from '../pipeline/compare';
import { runAngles, runQuestion } from '../pipeline/triage';
import { whynoteV2 } from '../pipeline/prompts/whynote.v2';
import type { AppConfig } from '../config';

const store = () => ({ cloudModeConsent: vi.fn().mockResolvedValue(true),
  reserveCloudProcessing: vi.fn().mockResolvedValue(1), cancelCloudProcessingReservation: vi.fn() });
afterEach(() => vi.clearAllMocks());
it('sends only each frozen step input with no private profile, list or unrelated paragraph', async () => {
  sdk.getGenerativeModel.mockReturnValue({ generateContent: sdk.generateContent });
  const outputs = [
    { items: [{ kind: 'assumption', text: 'A hosting statement', quote: 'the selected words', topics: ['hosting'] }] },
    { status: 'changed', newQuote: 'the selected words' },
    { concerns: [{ item: 1, angle: 'end-user', concern: 'A specific hosting question to investigate',
      checkable: true }] },
    { question: 'What are public hosting limits?', keptOut: [] },
  ];
  for (const value of outputs) sdk.generateContent.mockResolvedValueOnce({ response: { inferenceSource: 'in_cloud',
    text: () => JSON.stringify(value) } });
  const service = new CloudProcessingService(store(), createProcessingAdapter({} as AppConfig), () => true,
    () => 'example-model', () => {});
  const runner = <T,>(job: import('./localModel').Job<T>) => service.runLocal(job);
  const paragraph = 'the selected words in the changed paragraph only';
  const first = await extract(runner, 'My plan', paragraph, undefined, 'extract.v2');
  const item = { lineageId: 'l', version: 1, kind: 'assumption', text: first.items[0].text,
    quote: first.items[0].quote, topics: ['hosting'] };
  await compare(runner, { text: 'Earlier public statement', quote: 'earlier wording' }, paragraph,
    undefined, undefined, 'in_cloud');
  const angles = await runAngles(runner, paragraph, [item], undefined, undefined, 'v2.1', 'in_cloud');
  await runQuestion(runner, item, 'end-user', angles.concerns[0].concern, ['NEVER_SEND_SENTINEL'], [],
    undefined, undefined, 'v2.1', 'in_cloud');
  expect(sdk.generateContent).toHaveBeenCalledTimes(4);
  for (const call of sdk.getGenerativeModel.mock.calls) {
    const params = call[1] as { mode: string; inCloudParams: { generationConfig: object } };
    expect(params.mode).toBe('cloud-only');
    expect(params.inCloudParams.generationConfig).toHaveProperty('responseJsonSchema');
  }
  for (const call of sdk.generateContent.mock.calls) {
    const payload = JSON.stringify(call[0]);
    expect(payload).not.toContain('PROFILE_SENTINEL');
    expect(payload).not.toContain('NEVER_SEND_SENTINEL');
    expect(payload).not.toContain('UNRELATED_PARAGRAPH_SENTINEL');
  }
  expect(JSON.stringify(sdk.generateContent.mock.calls[0][0])).toContain(paragraph);
  expect(JSON.stringify(sdk.generateContent.mock.calls[1][0])).toContain('earlier wording');
});
it('rejects legacy profile-bearing why-notes without a request', async () => {
  const adapter = vi.fn();
  const service = new CloudProcessingService(store(), adapter, () => true, () => 'model', () => {});
  await expect(service.runLocal({ prompt: 'PROFILE_SENTINEL', schema: whynoteV2.schema,
    instructions: whynoteV2 })).rejects.toThrow('legacy');
  expect(adapter).not.toHaveBeenCalled();
});
it('retries only a genuine network failure and never retries quota or billing responses', async () => {
  const state = store();
  const adapter = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch'))
    .mockResolvedValueOnce({ source: 'in_cloud', text: '{"items":[]}' });
  const service = new CloudProcessingService(state, adapter, () => true, () => 'model', () => {});
  await extract(job => service.runLocal(job), 'My plan', 'test', undefined, 'extract.v2');
  expect(adapter).toHaveBeenCalledTimes(2);
  adapter.mockReset().mockRejectedValue({ customErrorData: { status: 429 }, message: 'Network request failed' });
  await expect(extract(job => service.runLocal(job), 'My plan', 'test', undefined, 'extract.v2'))
    .rejects.toThrow('cloud budget is used up');
  expect(adapter).toHaveBeenCalledTimes(1);
  adapter.mockReset().mockRejectedValue({ customErrorData: { status: 403,
    errorDetails: [{ reason: 'BILLING_DISABLED' }] }, message: 'Billing not enabled' });
  await expect(extract(job => service.runLocal(job), 'My plan', 'test', undefined, 'extract.v2'))
    .rejects.toThrow('billing is unavailable');
  expect(adapter).toHaveBeenCalledTimes(1);
});
it('blocks at the daily cap and when cloud processing is disabled', async () => {
  const state = store();
  const adapter = vi.fn();
  state.reserveCloudProcessing.mockResolvedValue(null);
  const service = new CloudProcessingService(state, adapter, () => true, () => 'model', () => {});
  await expect(extract(job => service.runLocal(job), 'My plan', 'test', undefined, 'extract.v2'))
    .rejects.toThrow('Cloud mode daily limit reached. Resets tomorrow.');
  expect(adapter).not.toHaveBeenCalled();
  const disabled = new CloudProcessingService(state, adapter, () => false, () => 'model', () => {});
  await expect(extract(job => disabled.runLocal(job), 'My plan', 'test', undefined, 'extract.v2')).rejects.toThrow();
  expect(adapter).not.toHaveBeenCalled();
});
it('discards wrong-source or revoked in-flight responses', async () => {
  const state = store();
  const adapter = vi.fn().mockResolvedValue({ source: 'on_device', text: '{"items":[]}' });
  const service = new CloudProcessingService(state, adapter, () => true, () => 'model', () => {});
  await expect(extract(job => service.runLocal(job), 'My plan', 'test', undefined, 'extract.v2'))
    .rejects.toMatchObject({ code: 'privacy-fault' });
  state.cloudModeConsent.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  adapter.mockResolvedValueOnce({ source: 'in_cloud', text: '{"items":[]}' });
  await expect(extract(job => service.runLocal(job), 'My plan', 'test', undefined, 'extract.v2'))
    .rejects.toThrow('discarded');
  expect(service.message).toContain('discarded');
});
