import { expect, it, vi } from 'vitest';
import { extractStructured, type Extraction } from './extract';
import type { Job } from '../ai/localModel';

const table = '| Risk | Check |\n|---|---|\n| Alpha | One |\n| Beta | Two |\n| Gamma | Three |';
it('runs each v2 table row with header context and merges only exact deduplicated quotes', async () => {
  const seen = vi.fn();
  const run = async <T,>(job: Job<T>) => {
    seen(job);
    const row = job.prompt.includes('| Alpha | One |') ? 'Alpha' :
      job.prompt.includes('| Beta | Two |') ? 'Beta' : 'Gamma';
    const data: Extraction = { items: [
      { kind: 'assumption', text: 'Header', quote: 'Risk', topics: [] },
      { kind: 'assumption', text: 'Altered', quote: row.toLowerCase(), topics: [] },
      { kind: 'assumption', text: 'Synthetic join',
        quote: `| Risk | Check |\n| ${row} | ${row === 'Alpha' ? 'One' : row === 'Beta' ? 'Two' : 'Three'} |`,
        topics: [] },
      { kind: 'assumption', text: row, quote: row, topics: [] },
    ] };
    return { data: data as T, source: 'on_device', raw: '', latencyMs: 1 };
  };
  const result = await extractStructured(run, 'My plan', table, undefined, 'extract.v2');
  expect(seen).toHaveBeenCalledTimes(3);
  expect(seen.mock.calls.every(([job]) => job.prompt.includes('| Risk | Check |'))).toBe(true);
  expect(seen.mock.calls.every(([job]) => !job.prompt.includes('|---|---|'))).toBe(true);
  expect(result.items.map(item => item.quote)).toEqual(['Risk', 'Alpha', 'Beta', 'Gamma']);
  expect(result.items.every(item => table.includes(item.quote))).toBe(true);
});
it('uses one unchanged full-paragraph call when splitting is disabled', async () => {
  const seen = vi.fn();
  const run = async <T,>(job: Job<T>) => { seen(job); return { data: { items: [] } as T,
    source: 'in_cloud', raw: '', latencyMs: 1 }; };
  await extractStructured(run, 'My plan', table, undefined, 'extract.v2', false);
  expect(seen).toHaveBeenCalledOnce();
  expect(seen.mock.calls[0][0].prompt).toContain(table);
});
