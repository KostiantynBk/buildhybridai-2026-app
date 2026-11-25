import { expect, it } from 'vitest';
import { extract, type LocalRunner } from './extract';

it.each(['on_device', 'in_cloud'] as const)('filters only newly returned short quotes in %s', async source => {
  const paragraph = 'Alpha beta gamma delta epsilon zeta eta theta.';
  const quotes = ['Alpha', 'beta gamma', 'gamma delta epsilon', 'zeta eta theta.'];
  const runner: LocalRunner = async <T,>() => ({ data: { items: quotes.map(quote => ({ kind: 'assumption',
    text: quote, quote, topics: [] })) } as T, latencyMs: 1, source, raw: '' });
  const result = await extract(runner, 'Fake', paragraph, undefined, 'extract.v2');
  expect(result.items.map(item => item.quote)).toEqual(['gamma delta epsilon', 'zeta eta theta.']);
});
