import { expect, it, vi } from 'vitest';
import { extract, extractStructured, type Extraction } from './extract';
import type { Job } from '../ai/localModel';

const table = '| Risk | Check |\n|---|---|\n| Alpha | One |\n| Beta | Two |\n| Gamma | Three |';
it('runs each v2 table row with header context and merges only exact deduplicated quotes', async () => {
  const seen = vi.fn();
  const run = async <T,>(job: Job<T>) => {
    seen(job);
    const row = job.prompt.includes('| Alpha | One |') ? 'Alpha' :
      job.prompt.includes('| Beta | Two |') ? 'Beta' : 'Gamma';
    const data: Extraction = { items: [
      { kind: 'assumption', text: 'Header', quote: 'Risk | Check', topics: [] },
      { kind: 'assumption', text: 'Altered',
        quote: `${row.toLowerCase()} | ${row === 'Alpha' ? 'One' : row === 'Beta' ? 'Two' : 'Three'}`, topics: [] },
      { kind: 'assumption', text: 'Synthetic join',
        quote: `| Risk | Check |\n| ${row} | ${row === 'Alpha' ? 'One' : row === 'Beta' ? 'Two' : 'Three'} |`,
        topics: [] },
      { kind: 'assumption', text: row,
        quote: `| ${row} | ${row === 'Alpha' ? 'One' : row === 'Beta' ? 'Two' : 'Three'} |`, topics: [] },
    ] };
    return { data: data as T, source: 'on_device', raw: '', latencyMs: 1 };
  };
  const result = await extractStructured(run, 'My plan', table, undefined, 'extract.v2');
  expect(seen).toHaveBeenCalledTimes(3);
  expect(seen.mock.calls.every(([job]) => job.prompt.includes('| Risk | Check |'))).toBe(true);
  expect(seen.mock.calls.every(([job]) => !job.prompt.includes('|---|---|'))).toBe(true);
  expect(result.items.map(item => item.quote)).toEqual(['Risk | Check', '| Alpha | One |', '| Beta | Two |',
    '| Gamma | Three |']);
  expect(result.items.every(item => table.includes(item.quote))).toBe(true);
  for (const quote of ['alpha | One', 'beta | Two', 'gamma | Three']) {
    const runNormalized = async <T,>() => ({ data: { items: [
      { kind: 'assumption', text: 'Altered', quote, topics: [] },
    ] } as T, source: 'on_device', raw: '', latencyMs: 1 });
    expect((await extract(runNormalized, 'My plan', table, undefined, 'extract.v2')).items[0]?.quote).toBe(quote);
  }
});
it('provides list context but never accepts a quote from the intro alone', async () => {
  const list = 'Problems to solve:\n- First problem is long.\n- Second problem is long.\n- Third problem is long.';
  const seen: string[] = [];
  const run = async <T,>(job: Job<T>) => {
    seen.push(job.prompt);
    const line = job.prompt.split('\n').at(-1)!;
    const data = { items: [
      { kind: 'assumption', text: 'Intro', quote: 'Problems to solve', topics: [] },
      { kind: 'assumption', text: 'Item', quote: line.slice(2), topics: [] },
    ] };
    return { data: data as T, source: 'on_device', raw: '', latencyMs: 1 };
  };
  const result = await extractStructured(run, 'My plan', list, undefined, 'extract.v2');
  expect(seen).toHaveLength(3);
  expect(seen.every(prompt => prompt.includes('Problems to solve:\n- '))).toBe(true);
  expect(result.items.map(item => item.quote)).toEqual(['First problem is long.', 'Second problem is long.',
    'Third problem is long.']);
});
it('maps recovered list quotes back to balanced original formatting and rejects near misses', async () => {
  const list = 'Intro:\n- **Notebook** (left) saves locally.\n- *Other* item.\n- `Third` item.';
  const run = async <T,>(job: Job<T>) => {
    const quotes = job.prompt.includes('Notebook') ?
      ['Notebook (left) saves', 'otebook (left) saves', 'Notebook (right) saves'] : [];
    return { data: { items: quotes.map(quote => ({ kind: 'decision', text: quote, quote, topics: [] })) } as T,
      source: 'on_device', raw: '', latencyMs: 1 };
  };
  const result = await extractStructured(run, 'My plan', list, undefined, 'extract.v2');
  expect(result.items.map(item => item.quote)).toEqual(['**Notebook** (left) saves']);
  expect(result.items.every(item => list.includes(item.quote))).toBe(true);
});
it('rejects altered arithmetic inside a code span on the real structured adoption path', async () => {
  const list = '- Keep `a*b*c` as the literal formula for estimates tomorrow.\n- Second item.\n- Third item.';
  const run = async <T,>(job: Job<T>) => ({
    data: { items: job.prompt.includes('a*b*c') ? [{ kind: 'assumption', text: 'formula',
      quote: 'Keep abc as the literal formula for estimates tomorrow.', topics: [] }] : [] } as T,
    source: 'on_device', raw: '', latencyMs: 1,
  });
  const result = await extractStructured(run, 'My plan', list, undefined, 'extract.v2');
  expect(result.items).toEqual([]);
});
it('rejects arithmetic-marker substitutions on structured and unsplit inputs', async () => {
  for (const [literal, altered] of [
    ['Use 20*(2+3)*4 for the estimate.', 'Use 20(2+3)4 for the estimate.'],
    ['Use a*-b/c*-d for the estimate.', 'Use a-b/c-d for the estimate.'],
  ]) {
    for (const [source, quote] of [[literal, altered], [altered, literal]]) {
      for (const split of [false, true]) {
        const paragraph = split ? `- ${source}\n- Other item.\n- Third item.` : source;
        const run = async <T,>(job: Job<T>) => ({ data: { items: job.prompt.includes(source) ?
          [{ kind: 'assumption', text: 'formula', quote, topics: [] }] : [] } as T,
        source: 'on_device', raw: '', latencyMs: 1 });
        const result = await extractStructured(run, 'My plan', paragraph, undefined, 'extract.v2', split);
        expect(result.items).toEqual([]);
      }
    }
  }
});
it('declines recovery in every row when a different row has unsupported link syntax', async () => {
  const paragraph = '- **First** item is here.\n- See [the reference](/path).\n- Third item is here.';
  const run = async <T,>(job: Job<T>) => ({ data: { items: job.prompt.includes('**First**') ?
    [{ kind: 'assumption', text: 'first', quote: 'First item is here.', topics: [] }] : [] } as T,
  source: 'on_device', raw: '', latencyMs: 1 });
  const result = await extractStructured(run, 'My plan', paragraph, undefined, 'extract.v2');
  expect(result.items).toEqual([]);
});
it('rejects cross-cell formatting on local table rows and the full cloud block', async () => {
  for (const marker of ['*', '`']) {
    const row = `| ${marker}draft | review${marker} **stays local** |`;
    const changed = '| draft | review stays local |';
    for (const [sourceRow, quote] of [[row, changed], [changed, row]]) {
      const table = `| Pattern | Result |\n|---|---|\n${sourceRow}\n| Second | Third |`;
      for (const local of [true, false]) {
        const run = async <T,>(job: Job<T>) => ({ data: { items: job.prompt.includes(sourceRow) ?
          [{ kind: 'assumption', text: 'fixture', quote, topics: [] }] : [] } as T,
        source: local ? 'on_device' : 'in_cloud', raw: '', latencyMs: 1 });
        const result = await extractStructured(run, 'My plan', table, undefined, 'extract.v2', local);
        expect(result.items).toEqual([]);
      }
    }
  }
});
it('rejects escaped-pipe role swaps but keeps legacy exact quotes', async () => {
  const source = '| path `a\\`| next `b\\| text` here |';
  const quote = '| path `a\\| next b\\`| text **here** |';
  for (const [row, proposed] of [[source, quote], [quote, source]]) {
    const table = `| Pattern | Result |\n|---|---|\n${row}\n| Second | Third |`;
    for (const local of [true, false]) {
      const run = async <T,>() => ({ data: { items: [
        { kind: 'assumption', text: 'role swap', quote: proposed, topics: [] },
        { kind: 'assumption', text: 'exact', quote: row, topics: [] },
      ] } as T, source: local ? 'on_device' : 'in_cloud', raw: '', latencyMs: 1 });
      const result = await extractStructured(run, 'My plan', table, undefined, 'extract.v2', local);
      expect(result.items.map(item => item.text)).toEqual(['exact']);
    }
  }
});
it('rejects CR list-boundary substitutions in whole-block routes while preserving legacy quotes', async () => {
  const text = '- Review draft each morning.\n- Keep the archive local for this project.\n' +
    '- Save a signed copy for tomorrow.';
  const altered = '- Review *draft each morning.\r- Keep the archive* local for this project.\r' +
    '- Save a signed copy for tomorrow.';
  for (const version of ['extract.v1', 'extract.v2'] as const) {
    const crSource = text.replace(/\n/g, '\r');
    const sourceRun = async <T,>() => ({ data: { items: [{ kind: 'assumption', text: 'fixture',
      quote: altered, topics: [] }] } as T, source: version === 'extract.v1' ? 'on_device' : 'in_cloud',
      raw: '', latencyMs: 1 });
    expect((await extractStructured(sourceRun, 'My plan', crSource, undefined, version, false)).items).toEqual([]);
    for (const [quote, accepted] of [[altered, false], [altered.replace(/\r/g, '\n'), false],
      [altered.replace(/\r/g, '\r\n'), false], [text, true], [text.replace(/\n/g, '\r'), true]] as const) {
      const run = async <T,>() => ({ data: { items: [{ kind: 'assumption', text: 'fixture', quote, topics: [] }] } as T,
        source: version === 'extract.v1' ? 'on_device' : 'in_cloud', raw: '', latencyMs: 1 });
      const result = await extractStructured(run, 'My plan', text, undefined, version, false);
      expect(result.items.length).toBe(accepted ? 1 : 0);
    }
  }
});
it('maps cloud quotes while keeping a single full-paragraph request', async () => {
  const paragraph = 'Plan: **on-device** model.\n- One item\n- Two items\n- Three items';
  const seen: string[] = [];
  const run = async <T,>(job: Job<T>) => {
    seen.push(job.prompt);
    return { data: { items: [{ kind: 'assumption', text: 'Model', quote: 'Plan: on-device model', topics: [] }] } as T,
      source: 'in_cloud', raw: '', latencyMs: 1 };
  };
  const result = await extractStructured(run, 'My plan', paragraph, undefined, 'extract.v2', false);
  expect(seen).toEqual([`Title: My plan\nParagraph:\n${paragraph}`]);
  expect(result.items[0].quote).toBe('Plan: **on-device** model');
});
it('uses one unchanged full-paragraph call when splitting is disabled', async () => {
  const seen = vi.fn();
  const run = async <T,>(job: Job<T>) => { seen(job); return { data: { items: [] } as T,
    source: 'in_cloud', raw: '', latencyMs: 1 }; };
  await extractStructured(run, 'My plan', table, undefined, 'extract.v2', false);
  expect(seen).toHaveBeenCalledOnce();
  expect(seen.mock.calls[0][0].prompt).toContain(table);
});
