import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { stubSafeSuggestionParser } from './testSuggestionParser';

beforeEach(stubSafeSuggestionParser);
afterEach(() => vi.unstubAllGlobals());
const mocks = vi.hoisted(() => ({ getGenerativeModel: vi.fn(), generateContent: vi.fn(), firebaseAI: vi.fn() }));
vi.mock('firebase/ai', () => ({ getGenerativeModel: mocks.getGenerativeModel,
  InferenceMode: { ONLY_IN_CLOUD: 'only-cloud' } }));
vi.mock('./firebase', () => ({ firebaseAI: mocks.firebaseAI }));
import { createCloudAdapter, RESEARCH_SYSTEM, safeSuggestions, sendChecked } from './cloudResearch';
import type { AppConfig } from '../config';

it('calls the SDK with only the approved question and the canonical system instruction', async () => {
  mocks.getGenerativeModel.mockReturnValue({ generateContent: mocks.generateContent });
  mocks.generateContent.mockResolvedValue({ response: { inferenceSource: 'in_cloud', text: () => 'Grounded',
    candidates: [{ content: { parts: [{ text: 'Grounded' }] }, groundingMetadata: {
      groundingChunks: [{ web: { uri: 'https://example.com', title: 'Example' } }],
      searchEntryPoint: { renderedContent: '<div>Google</div>' }, groundingSupports: [{
        segment: { partIndex: 0, startIndex: 0, endIndex: 8, text: 'Grounded' }, groundingChunkIndices: [0],
      }],
    } }] } });
  const adapter = createCloudAdapter({} as AppConfig);
  await sendChecked(adapter, 'Approved public question?', 'gemini-3.5-flash-lite');
  expect(mocks.getGenerativeModel).toHaveBeenCalledWith(undefined, { mode: 'only-cloud', inCloudParams: {
    model: 'gemini-3.5-flash-lite', systemInstruction: RESEARCH_SYSTEM, tools: [{ googleSearch: {} }],
  } });
  expect(mocks.generateContent).toHaveBeenCalledWith('Approved public question?');
  expect(mocks.generateContent.mock.calls[0]).toEqual(['Approved public question?']);
});
it('accepts reconstructed Google suggestions with inline SVG logos and rejects SVG links', () => {
  const fixture = '<style>.chip{display:inline-block}</style><svg class="logo-light" ' +
    'xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/><ellipse/><polygon/><polyline/><line/>' +
    '<clipPath/><title>Logo</title><desc>Logo</desc><radialGradient/></svg><svg class="logo-dark" ' +
    'xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>' +
    '<a class="chip" href="https://vertexaisearch.cloud.google.com/grounding-api-redirect/example">Search</a>';
  const html = 'http://www.w3.org/1999/xhtml';
  const svg = 'http://www.w3.org/2000/svg';
  const element = (localName: string, namespaceURI: string, attributes: Array<{ name: string; value: string }> = []) =>
    ({ localName, namespaceURI, attributes });
  const elements = [element('style', html), element('svg', svg), element('path', svg), element('svg', svg),
    element('path', svg), element('a', html, [{ name: 'href',
      value: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/example' }]),
    ...['ellipse', 'polygon', 'polyline', 'line', 'clipPath', 'title', 'desc', 'radialGradient']
      .map(name => element(name, svg))];
  const parse = vi.fn().mockReturnValue({ querySelector: () => null, querySelectorAll: () => elements });
  vi.stubGlobal('DOMParser', class { parseFromString = parse; });
  try {
    expect(safeSuggestions(fixture)).toBe(true);
    expect(parse).toHaveBeenCalledWith(fixture, 'text/html');
    elements[1].attributes.push({ name: 'xlink:href', value: 'https://example.com' });
    expect(safeSuggestions(fixture)).toBe(false);
    elements[1].attributes.length = 0;
    elements[2].attributes.push({ name: 'onload', value: 'alert(1)' });
    expect(safeSuggestions(fixture)).toBe(false);
    elements[2].attributes.length = 0;
    elements[5].attributes[0].value = 'http://example.com';
    expect(safeSuggestions(fixture)).toBe(false);
  } finally { vi.unstubAllGlobals(); }
});
it('allows ungrounded answers and grounded answers with missing or mismatched citation offsets', async () => {
  const base = { text: 'Exact answer', parts: ['different'], sources: [], supports: [], suggestions: '',
    grounded: false };
  expect(await sendChecked(async () => ({ source: 'in_cloud', result: base }), 'question', 'model')).toEqual(base);
  const grounded = { ...base, grounded: true, suggestions: '<div>Search</div>',
    sources: [{ uri: 'https://example.com', title: 'Source' }] };
  expect(await sendChecked(async () => ({ source: 'in_cloud', result: grounded }), 'question', 'model'))
    .toEqual(grounded);
  await expect(sendChecked(async () => ({ source: 'in_cloud', result: { ...grounded, suggestions: '' } }),
    'question', 'model')).rejects.toThrow('required Search sources and suggestions');
  await expect(sendChecked(async () => ({ source: 'in_cloud', result: { ...base, text: '' } }), 'q', 'm'))
    .rejects.toThrow();
});
it('fingerprints the frozen system instruction', async () => {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(RESEARCH_SYSTEM));
  const hex = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  expect(hex).toBe('28d5f578e5b9516d1c59263efbd91740f617f0b22dfd2074febb3b7bb8671d5e');
});
