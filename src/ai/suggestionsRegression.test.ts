import { afterEach, expect, it, vi } from 'vitest';
import { isGrounded, sendChecked, type CloudAdapter, type ResearchResult } from './cloudResearch';
import { researchApproved } from './researchFlow';
import { sendRun4Question } from '../eval/run4Cloud';
import { mountSuggestions } from '../ui/ResearchBlock';

const unsafe = '<img src="data:invalid" onerror="globalThis.__unsafeSuggestionExecuted=true">';
const valid = '<div>Unchanged Search Suggestions</div>';
const makeResult = (suggestions: string): ResearchResult => ({ text: 'Answer', parts: ['Answer'], sources: [],
  supports: [], suggestions, grounded: false });
const approved = { id: 'e', question: 'Public question?', keptOut: [], cardId: 'c', itemLineageId: 'l',
  itemVersion: 1, status: 'approved', createdAt: 1 };
const makeStore = () => ({ snapshot: vi.fn().mockResolvedValue({ outbox: [approved], neverSend: [] }),
  preSendCheck: vi.fn().mockResolvedValue({ allowed: true }), cloudConsent: vi.fn().mockResolvedValue(true),
  reserveResearch: vi.fn().mockResolvedValue(1), cancelResearch: vi.fn().mockResolvedValue(undefined),
  finishResearch: vi.fn().mockResolvedValue(undefined) });
afterEach(() => vi.unstubAllGlobals());
it('rejects sparse unsafe suggestions through both send paths and the actual mount boundary', async () => {
  const parse = vi.fn((html: string) => ({ querySelector: () => null, querySelectorAll: () => html === unsafe ?
    [{ namespaceURI: 'http://www.w3.org/1999/xhtml', localName: 'img',
      attributes: [{ name: 'src', value: 'data:invalid' }, { name: 'onerror', value: 'marker' }] }] : [] }));
  vi.stubGlobal('DOMParser', class { parseFromString = parse; });
  const adapter = vi.fn<CloudAdapter>().mockResolvedValue({ source: 'in_cloud', result: makeResult(unsafe) });
  const store = makeStore();
  await expect(researchApproved(store, adapter, 'e', 'm')).rejects.toThrow('required Search');
  await expect(sendRun4Question(store, adapter, { id: 'q', profile: 'A', question: 'Public question?' }, 'm',
    { enabled: true, budget: 20 })).rejects.toThrow('required Search');
  expect(parse).toHaveBeenCalledWith(unsafe, 'text/html');
  const attachShadow = vi.fn();
  mountSuggestions({ shadowRoot: null, attachShadow } as unknown as HTMLDivElement, unsafe);
  expect(attachShadow).not.toHaveBeenCalled();
  const good = await sendChecked(async () => ({ source: 'in_cloud', result: makeResult(valid) }), 'q', 'm');
  expect(isGrounded(good)).toBe(true);
  const root = { innerHTML: '', replaceChildren: vi.fn() };
  mountSuggestions({ shadowRoot: null, attachShadow: () => root } as unknown as HTMLDivElement, good.suggestions);
  expect(root.innerHTML).toBe(valid);
});
it('fails closed if no DOM parser is available', async () => {
  vi.stubGlobal('DOMParser', undefined);
  await expect(sendChecked(async () => ({ source: 'in_cloud', result: makeResult(valid) }), 'q', 'm'))
    .rejects.toThrow('required Search');
  const attachShadow = vi.fn();
  mountSuggestions({ shadowRoot: null, attachShadow } as unknown as HTMLDivElement, valid);
  expect(attachShadow).not.toHaveBeenCalled();
});
