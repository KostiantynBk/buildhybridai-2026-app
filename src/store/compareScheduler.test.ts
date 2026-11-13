import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';
import { openLocalStore } from './index';
import { Scheduler, type LocalService } from './scheduler';
import { compareV1 } from '../pipeline/prompts/compare.v1';
import type { Job } from '../ai/localModel';

it('runs extraction then compare through one guarded service without including the profile', async () => {
  const store = await openLocalStore(`compare-scheduler-${crypto.randomUUID()}`);
  const original = 'Fifty visitors are expected at once. The catalogue is simple and intended ' +
    'for the first small test.';
  const edited = 'Twenty visitors are expected at once. The catalogue is simple and intended for the first small test.';
  const old = { kind: 'assumption', text: 'Fifty visitors', quote: 'Fifty visitors are expected at once',
    topics: ['hosting'] };
  await store.putProfile({ id: 'profile', type: 'project', text: 'PRIVATE PROFILE SENTINEL', topics: [], tags: [],
    updatedAt: 0 });
  await store.saveNotebook(original, 0);
  await store.enqueueSettled(4000, 'extract.v2');
  const initial = await store.claim(4000);
  if (!initial) throw new Error('Missing initial job');
  await store.complete(initial.job, [old]);
  await store.finalizeReady();
  const oldItem = (await store.snapshot()).items.find(item => item.text === old.text)!;
  await store.saveNotebook(edited, 10000);
  const runner = vi.fn(async (job: Job<unknown>) => ({ data: job.instructions === compareV1
    ? { status: 'changed', newQuote: 'Twenty visitors are expected at once' }
    : { items: [{ ...old, kind: 'constraint', text: 'Twenty visitors',
      quote: 'Twenty visitors are expected at once' }] }, source: 'on_device', latencyMs: 1, raw: '{}' }));
  const service = { state: { kind: 'ready' }, subscribe: () => () => {}, runLocal: runner } as unknown as LocalService;
  const scheduler = new Scheduler(store, service, () => 'extract.v2', () => {}, () => 20000);
  try {
    await scheduler.start();
    await scheduler.tick();
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls.every(call => !call[0].prompt.includes('PRIVATE PROFILE SENTINEL'))).toBe(true);
    const current = (await store.snapshot()).items.find(item => item.status === 'current');
    expect(current).toMatchObject({ text: 'Twenty visitors', kind: 'constraint', lineageId: oldItem.lineageId });
    expect((await store.lineages()).find(lineage => lineage.lineageId === oldItem.lineageId && lineage.version === 2))
      .toMatchObject({ status: 'changed' });
  } finally { scheduler.stop(); store.close(); }
});
