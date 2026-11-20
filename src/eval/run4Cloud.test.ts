import { expect, it, vi } from 'vitest';
import { sendRun4Idea, sendRun4Question, validateRun4Ideas, validateRun4Questions } from './run4Cloud';
import ideas from '../../eval/run4-ideas.json';
import { run4Provenance } from './run4Provenance';
import { builtInSettings } from '../settings/defaults';
import type { CloudAdapter, ResearchResult } from '../ai/cloudResearch';

const item = { id: 'example', profile: 'A' as const, question: 'What are hosting limits?' };
const result: ResearchResult = { text: 'RESULT_SENTINEL', parts: [], sources: [], supports: [], suggestions: '',
  grounded: false };
function fixture(terms: string[] = []) {
  return { snapshot: vi.fn().mockResolvedValue({ neverSend: terms }), cloudConsent: vi.fn().mockResolvedValue(true),
    reserveResearch: vi.fn().mockResolvedValue(1), cancelResearch: vi.fn().mockResolvedValue(undefined),
    finishResearch: vi.fn().mockResolvedValue(undefined) };
}
it('validates frozen items and rejects duplicate IDs', () => {
  expect(validateRun4Questions([item])).toEqual([item]);
  expect(() => validateRun4Questions([item, item])).toThrow('duplicate');
});
it('validates separate idea descriptions and records HIGH-thinking provenance', async () => {
  const rows = validateRun4Ideas(ideas);
  expect(rows.map(row => row.id)).toEqual(['I1', 'I2', 'I3', 'I4']);
  expect(() => validateRun4Ideas([{ ...rows[0], profile: 'A' }])).toThrow();
  const store = fixture();
  const adapter = vi.fn<CloudAdapter>().mockResolvedValue({ source: 'in_cloud', result });
  await expect(sendRun4Idea(store, adapter, rows[0], 'model', { enabled: true, budget: 1 }))
    .rejects.toThrow('No web sources were attached');
  expect(adapter).toHaveBeenCalledOnce();
  expect(store.finishResearch).toHaveBeenCalledWith(1, 'completed', 'ungrounded');
  expect(adapter).toHaveBeenCalledWith(rows[0].description, 'model');
  expect(run4Provenance(builtInSettings(), 'model', 'research.idea.v1'))
    .toMatchObject({ promptVersion: 'research.idea.v1', thinkingLevel: 'HIGH' });
  expect(JSON.stringify(store.finishResearch.mock.calls)).not.toContain('RESULT_SENTINEL');
});
it('sends only the approved frozen question and holds the response in memory', async () => {
  const store = fixture();
  const adapter = vi.fn<CloudAdapter>().mockResolvedValue({ source: 'in_cloud', result });
  const measured = vi.fn();
  const view = await sendRun4Question(store, adapter, item, 'model', { enabled: true, budget: 1,
    onResponse: measured });
  expect(adapter).toHaveBeenCalledWith(item.question, 'model');
  expect(view.result.text).toBe('RESULT_SENTINEL');
  expect(measured).toHaveBeenCalledWith(expect.objectContaining({ grounded: false, suggestionsPresent: false }));
  expect(JSON.stringify(store.finishResearch.mock.calls)).not.toContain('RESULT_SENTINEL');
  expect(JSON.stringify(measured.mock.calls)).not.toContain('RESULT_SENTINEL');
});
it('blocks never-send terms, revoked consent, disabled cloud and exhausted budget without dispatch', async () => {
  const adapter = vi.fn<CloudAdapter>();
  const blocked = fixture(['HOSTING']);
  await expect(sendRun4Question(blocked, adapter, item, 'model', { enabled: true, budget: 1 }))
    .rejects.toThrow('never-send');
  expect(blocked.cancelResearch).toHaveBeenCalledWith(1);
  const noConsent = fixture(); noConsent.cloudConsent.mockResolvedValue(false);
  await expect(sendRun4Question(noConsent, adapter, item, 'model', { enabled: true, budget: 1 })).rejects.toThrow();
  await expect(sendRun4Question(fixture(), adapter, item, 'model', { enabled: false, budget: 1 }))
    .rejects.toThrow('disabled');
  const exhausted = fixture(); exhausted.reserveResearch.mockResolvedValue(null);
  await expect(sendRun4Question(exhausted, adapter, item, 'model', { enabled: true, budget: 0 }))
    .rejects.toThrow('limit reached');
  expect(adapter).not.toHaveBeenCalled();
});
it('warns after a never-send change without discarding the returned answer', async () => {
  const store = fixture();
  store.snapshot.mockResolvedValueOnce({ neverSend: [] }).mockResolvedValueOnce({ neverSend: ['hosting'] });
  const adapter = vi.fn<CloudAdapter>().mockResolvedValue({ source: 'in_cloud', result });
  const view = await sendRun4Question(store, adapter, item, 'model', { enabled: true, budget: 2 });
  expect(view.changedAfterSend).toBe(true);
  expect(view.result.text).toBe('RESULT_SENTINEL');
});
