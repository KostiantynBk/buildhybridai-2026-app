import { expect, it, vi } from 'vitest';
import { LocalError, LocalModelService, type Dependencies, type Job } from '../ai/localModel';
import { extract, extractInput, type LocalRunner } from './extract';
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
