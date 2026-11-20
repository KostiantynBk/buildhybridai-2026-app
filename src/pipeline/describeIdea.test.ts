import { expect, it, vi } from 'vitest';
import { describeIdea } from './describeIdea';
import { LocalError, type Job } from '../ai/localModel';
import { samplePlan } from '../ui/samplePlan';
import { describeV2 } from './prompts/describe.v2';

it.each(['', 'one two three', Array(61).fill('word').join(' ')])('falls back for a bad length', async text => {
  const run = async <T,>(_job: Job<T>) => ({ data: { description: text, keptOut: [] } as T, source: 'on_device' });
  expect(await describeIdea(run, ['One statement'], 'on_device')).toMatchObject({ description: '', keptOut: [] });
});
it('falls back on invalid model output without inventing a description', async () => {
  const run = async <T,>(_job: Job<T>): Promise<{ data: T; source: string }> => {
    throw new LocalError('invalid-output', 'Invalid JSON.');
  };
  expect(await describeIdea(run, ['One statement'], 'on_device')).toEqual({ description: '', keptOut: [] });
});
it('never accepts the wrong model source', async () => {
  const run = async <T,>(_job: Job<T>) => ({ data: { description:
    'A tool helps people make their plans clearer with simple notes.', keptOut: [] } as T, source: 'in_cloud' });
  await expect(describeIdea(run, ['Selected statement'], 'on_device')).rejects.toMatchObject({ code: 'privacy-fault' });
});
it('passes only selected statements with the chosen mode', async () => {
  const seen = vi.fn();
  const run = async <T,>(job: Job<T>) => { seen(job); return { data: { description:
    'A tool helps people make their plans clearer with simple notes.', keptOut: [] } as T, source: 'in_cloud' }; };
  await describeIdea(run, ['Selected statement'], 'in_cloud');
  const job = seen.mock.calls[0][0] as Job<unknown>;
  expect(job.prompt).toBe('1. Selected statement');
  expect(job.requiredMode).toBe('in_cloud');
  expect(JSON.stringify(job)).not.toContain('PROFILE_SENTINEL');
  expect(JSON.stringify(job)).not.toContain('NEVER_SEND_SENTINEL');
});
it('passes the S1 opening to v2 and accepts a fake-model restaurant no-show description', async () => {
  const seen = vi.fn();
  const run = async <T,>(job: Job<T>) => { seen(job); return { source: 'on_device', data: {
    description: 'A deposit booking page helps restaurants reduce no-shows from guests who miss reservations.',
    keptOut: ['project name', 'payment provider'],
  } as T }; };
  const result = await describeIdea(run, ['Guests might not show up', 'Take a deposit'], 'on_device', undefined,
    undefined, samplePlan[0], 'describe.v2');
  const job = seen.mock.calls[0][0] as Job<unknown>;
  expect(job.instructions).toBe(describeV2);
  expect(job.prompt).toContain(samplePlan[0]);
  expect(job.prompt.indexOf('Guests might not show up')).toBeLessThan(job.prompt.indexOf('Take a deposit'));
  expect(result.description).toMatch(/restaurant/i);
  expect(result.description).toMatch(/no-shows/i);
  expect(result.description).not.toMatch(/react|stripe/i);
});
