import { expect, it, vi } from 'vitest';
import { LocalError, LocalModelService, type Dependencies, type Job } from '../ai/localModel';
import { extract, extractInput, extractStructured, normalizeQuote, type LocalRunner } from './extract';
import { readFileSync } from 'node:fs';
import { bindTemplate } from './bindTemplate';
import { extractV2 } from './prompts/extract.v2';

it('binds original slots once without rescanning placeholder-like or dollar-sign values', () => {
  expect(extractInput('Literal {paragraph} $& $1', 'Text has {title} $& $1')).toBe(
    'Title: Literal {paragraph} $& $1\nParagraph:\nText has {title} $& $1',
  );
  expect(
    bindTemplate('A {title} B {paragraph}', {
      '{title}': 'X {paragraph} $&',
      '{paragraph}': 'Y {title} $1',
    }),
  ).toBe('A X {paragraph} $& B Y {title} $1');
});

it('drops unverified quotes, deduplicates and fills empty topics', async () => {
  const data = {
    items: [
      { kind: 'decision', text: 'one', quote: 'FIRST line', topics: [] },
      { kind: 'decision', text: 'duplicate', quote: 'first   line', topics: ['other'] },
      { kind: 'assumption', text: 'wrong', quote: 'absent', topics: ['other'] },
    ],
  };
  const runner = vi.fn(async () => ({
    data,
    latencyMs: 1,
    source: 'on_device',
    raw: JSON.stringify(data),
  })) as unknown as LocalRunner;
  const result = await extract(runner, 'Title', 'First line\nwith more words.');
  expect(result.items).toHaveLength(1);
  expect(result.items[0].topics).toEqual(['other']);
  expect(result.droppedBadQuotes).toBe(1);
  expect(result.droppedDuplicates).toBe(1);
  expect(result.quoteExact).toBe(0);
  expect(result.promptVersion).toBe('extract.v1');
  const exact = await extract(runner, 'Title', 'FIRST line with extra words.');
  expect(exact.quoteExact).toBe(1);
});

it('recovers formatted quotes with legacy normalized whitespace and preserves plain partial matches', async () => {
  const data = { items: [
    { kind: 'decision', text: 'formatted', quote: 'ON-device model', topics: [] },
    { kind: 'decision', text: 'plain', quote: 'rice', topics: [] },
  ] };
  const runner = (async () => ({ data, latencyMs: 1, source: 'on_device', raw: '' })) as unknown as LocalRunner;
  const result = await extract(runner, 'Title', 'An **on-device**   model has a price.');
  expect(result.items.map(item => item.quote)).toEqual(['**on-device**   model', 'rice']);
});
it('preserves input and legacy quote decisions across all 20 frozen plain-text notes', async () => {
  const notes = (JSON.parse(readFileSync('eval/set-v1/notes.json', 'utf8')) as
    { notes: Array<{ text: string }> }).notes;
  expect(notes).toHaveLength(20);
  for (const note of notes) {
    const quotes = [note.text.slice(0, 22), note.text.slice(0, 22).toUpperCase(), 'synthetic absent phrase'];
    const items = quotes.map(quote => ({ kind: 'decision', text: quote, quote, topics: ['other'] }));
    const prompts: string[] = [];
    const run = (async (job: Job<unknown>) => {
      prompts.push(job.prompt);
      return { data: { items }, source: 'on_device', raw: '', latencyMs: 1 };
    }) as LocalRunner;
    const got = await extractStructured(run, 'My plan', note.text, undefined, 'extract.v2');
    expect(prompts).toEqual([extractInput('My plan', note.text)]);
    const seen = new Set<string>();
    const expected = items.filter(item => {
      const q = normalizeQuote(item.quote);
      if (!q || !normalizeQuote(note.text).includes(q) || seen.has(q)) return false;
      seen.add(q); return true;
    });
    expect(got.items).toEqual(expected);
  }
});
it('discards an unverified source for a job with both examples', async () => {
  const text = vi.fn(() => '{"items":[]}');
  const generate = vi
    .fn()
    .mockResolvedValueOnce({ source: 'on_device', text: () => '{"ready":true}' })
    .mockResolvedValueOnce({ source: 'in_cloud', text });
  const service = new LocalModelService({
    configured: true,
    hasApi: () => true,
    createModel: () => ({ prepare: async () => {}, generate }),
    availability: async () => 'available',
    isForeground: () => true,
    onForeground: () => () => {},
    now: () => 0,
  });
  await service.probe();
  await service.prepare();
  await expect(
    service.runLocal({ prompt: 'synthetic', schema: extractV2.schema, instructions: extractV2 }),
  ).rejects.toMatchObject({ code: 'privacy-fault' });
  expect(text).not.toHaveBeenCalled();
  expect(service.privacyFaults).toBe(1);
});

it.each([
  { configured: false, hasApi: true, code: 'not-configured' },
  { configured: true, hasApi: false, code: 'unsupported' },
])('instructions cannot bypass a missing config or API', async ({ configured, hasApi, code }) => {
  const createModel = vi.fn();
  const deps: Dependencies = {
    configured,
    hasApi: () => hasApi,
    createModel,
    availability: async () => 'available',
    isForeground: () => true,
    onForeground: () => () => {},
    now: () => 0,
  };
  const service = new LocalModelService(deps);
  const job: Job<unknown> = {
    prompt: 'synthetic',
    schema: {},
    instructions: {
      system: 'fixed',
      exampleInput: 'example A',
      exampleOutput: '{}',
      additionalExamples: [{ input: 'example B', output: '{}' }],
    },
  };
  await expect(service.runLocal(job)).rejects.toMatchObject({ code });
  expect(createModel).not.toHaveBeenCalled();
  expect(new LocalError('invalid-output', 'x').code).toBe('invalid-output');
});
