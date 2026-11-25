import 'fake-indexeddb/auto';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { extract, type LocalRunner } from '../pipeline/extract';
import { NotebookPanel } from '../ui/NotebookPanel';
import { openLocalStore, SETTLE_MS } from './index';

it('stores and shows a case-and-whitespace quote accepted by the evaluated extraction rule', async () => {
  const store = await openLocalStore(`quote-${crypto.randomUUID()}`);
  try {
    const text = 'one two three four five six seven eight nine ten eleven twelve thirteen';
    await store.saveNotebook(text, 0);
    await store.enqueueSettled(SETTLE_MS, 'extract.v2');
    const claim = await store.claim(SETTLE_MS);
    if (!claim) throw new Error('Expected extraction job.');
    const runner: LocalRunner = async <T,>() => ({
      data: { items: [{ kind: 'assumption', text: 'A finding', quote: 'ONE   TWO THREE', topics: ['other'] }] } as T,
      latencyMs: 1, source: 'on_device', raw: '{}',
    });
    const extracted = await extract(runner, 'My plan', claim.paragraph.text, undefined, 'extract.v2');
    expect(extracted.items).toHaveLength(1);
    expect(extracted.items[0].quote).toBe('ONE   TWO THREE');
    expect(await store.complete(claim.job, extracted.items)).toBe(true);
    const snapshot = await store.snapshot();
    expect(snapshot.items[0].quote).toBe('ONE   TWO THREE');
    const html = renderToStaticMarkup(<NotebookPanel text={text} save={() => {}} storageStatus="saved"
      snapshot={snapshot} configured ready />);
    expect(html).toContain('A finding');
    expect(html).toContain('ONE   TWO THREE');
  } finally {
    store.close();
  }
});
