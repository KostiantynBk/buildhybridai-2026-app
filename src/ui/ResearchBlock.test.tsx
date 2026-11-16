import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { stubSafeSuggestionParser } from '../ai/testSuggestionParser';
import { mountSuggestions, ResearchBlock } from './ResearchBlock';
import type { ResearchResult } from '../ai/cloudResearch';

beforeEach(stubSafeSuggestionParser);
afterEach(() => vi.unstubAllGlobals());
it('inserts unmodified Google suggestions into a same-width Shadow DOM host', () => {
  const root = { innerHTML: '', replaceChildren: vi.fn() };
  const attachShadow = vi.fn().mockReturnValue(root);
  const host = { shadowRoot: null, attachShadow } as unknown as HTMLDivElement;
  const html = '<style>.search {color: red}</style><a href="https://google.com">Search</a>';
  const cleanup = mountSuggestions(host, html);
  expect(attachShadow).toHaveBeenCalledWith({ mode: 'open' });
  expect(root.innerHTML).toBe(html);
  cleanup();
  expect(root.replaceChildren).toHaveBeenCalledOnce();
});
it('shows the exact answer and aggregate sources when response parts do not align', () => {
  const result: ResearchResult = { text: 'Exact returned text', parts: ['different'],
    sources: [{ uri: 'https://example.com/x', title: 'Source title' }],
    supports: [{ partIndex: 0, startIndex: 0, endIndex: 1, indices: [0] }], suggestions: '<div>Search</div>' };
  const html = renderToStaticMarkup(<ResearchBlock result={result} />);
  expect(html).toContain('Exact returned text');
  expect(html).toContain('Source title');
  expect(html).not.toContain('<sup>');
});
it('maps UTF-8 support offsets without changing answer text or source numbering', () => {
  const result: ResearchResult = { text: 'Café 🎉\nExactly.', parts: ['Café 🎉\nExactly.'],
    sources: [null, { uri: 'https://example.com/x', title: 'Source title' }],
    supports: [{ partIndex: 0, startIndex: 0, endIndex: 10, indices: [1] }], suggestions: '<div>Search</div>' };
  const html = renderToStaticMarkup(<ResearchBlock result={result} />);
  expect(html).toContain('Café 🎉<sup><a href="https://example.com/x"');
  expect(html).toContain('[2]');
  expect(html).toContain('<li value="2">');
  expect(html).toContain('\nExactly.');
  expect(html).toContain('width:100%');
});
