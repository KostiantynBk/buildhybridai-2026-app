import { expect, it, vi } from 'vitest';
import { describeIdea } from './describeIdea';
import { LocalError, type Job } from '../ai/localModel';

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
