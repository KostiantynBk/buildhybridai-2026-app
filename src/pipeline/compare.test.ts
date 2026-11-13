import { expect, it, vi } from 'vitest';
import { compare } from './compare';
import type { LocalRunner } from './extract';

it('uses the normalized-quote shortcut without invoking the model', async () => {
  const runner = vi.fn() as unknown as LocalRunner;
  const result = await compare(runner, { text: 'Earlier', quote: 'THE  plan' }, 'The plan is here.');
  expect(result).toMatchObject({ status: 'unchanged', source: 'code', promptVersion: 'compare.v1' });
  expect(runner).not.toHaveBeenCalled();
});
it('uses on-device compare, and flags a missing changed quote for confirmation', async () => {
  const runner = vi.fn(async () => ({ data: { status: 'changed', newQuote: 'missing quote' },
    source: 'on_device', latencyMs: 5, raw: '{}' })) as unknown as LocalRunner;
  expect(await compare(runner, { text: 'Earlier', quote: 'old quote' }, 'A new paragraph')).toMatchObject({
    status: 'changed', source: 'on_device', newQuoteFound: false, needsConfirmation: true,
  });
  expect(runner).toHaveBeenCalledTimes(1);
});
it('rejects an unverified source', async () => {
  const runner = vi.fn(async () => ({ data: { status: 'changed', newQuote: 'new' },
    source: 'in_cloud', latencyMs: 5, raw: '{}' })) as unknown as LocalRunner;
  await expect(compare(runner, { text: 'Earlier', quote: 'old' }, 'new')).rejects.toMatchObject({
    code: 'privacy-fault',
  });
});
