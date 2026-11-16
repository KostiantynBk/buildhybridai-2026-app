import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';
// This regression explicitly exercises the pinned v2 path.
vi.mock('../pipeline/triageVersion', async importOriginal => ({
  ...(await importOriginal<typeof import('../pipeline/triageVersion')>()), TRIAGE_PROMPT_SET: 'v2',
}));

import type { Job } from '../ai/localModel';
import { anglesV2 } from '../pipeline/prompts/angles.v2';
import { questionV2 } from '../pipeline/prompts/question.v2';
import { whynoteV2 } from '../pipeline/prompts/whynote.v2';
import { openLocalStore, type ProfileRecord } from './index';
import { Scheduler, type LocalService } from './scheduler';

const paragraph = 'The hosting service supports fifty users at once and provides a simple catalogue for visitors.';
const item = { kind: 'assumption', text: 'Fifty users', quote: 'The hosting service supports fifty users at once',
  topics: ['hosting'] };
const record = (id: string, text: string): ProfileRecord => ({ id, type: 'skill', depth: 'new', text,
  topics: ['hosting'], tags: [], updatedAt: 1 });
const result = (data: unknown) => ({ data, source: 'on_device', latencyMs: 1, raw: '{}' });

for (const { used, initialDelete } of [{ used: [] as string[], initialDelete: false },
  { used: ['a'], initialDelete: false }, { used: [] as string[], initialDelete: true }]) {
  it(`invalidates ${initialDelete ? 'deleted' : 'edited'} supplied b with used=${JSON.stringify(used)}`,
    async () => {
    const store = await openLocalStore(`why-fresh-${crypto.randomUUID()}`);
    await store.putProfile(record('a', 'First skill'));
    await store.putProfile(record('b', 'Original second skill'));
    await store.saveNotebook(paragraph, 0);
    const releases: Array<(value: ReturnType<typeof result>) => void> = [];
    const run = vi.fn(async (job: Job<unknown>) => {
      job.onDispatch?.();
      if (job.instructions === whynoteV2) {
        return new Promise<ReturnType<typeof result>>(resolve => releases.push(resolve));
      }
      if (job.instructions === anglesV2) return result({ concerns: [{ item: 1, angle: 'end-user',
        concern: 'Can this be checked?', checkable: true }] });
      if (job.instructions === questionV2) return result({ question: 'What are hosting limits?', keptOut: [] });
      return result({ items: [item] });
    });
    const service = { state: { kind: 'ready' }, subscribe: () => () => {}, runLocal: run } as unknown as LocalService;
    const scheduler = new Scheduler(store, service, () => 'extract.v2', () => {});
    try {
      await scheduler.start(); await scheduler.tick(); await scheduler.tick();
      const first = scheduler.tick();
      await vi.waitFor(() => expect(releases).toHaveLength(1));
      if (initialDelete) await store.deleteProfile('b');
      else await store.putProfile({ ...record('b', 'Changed second skill'), depth: 'deep' });
      releases[0](result({ seeing: 'You use the original skill.', why: 'Old.', used }));
      await first;
      let snapshot = await store.snapshot();
      expect(snapshot.cards?.[0].why).toBeNull();
      expect(snapshot.jobs.filter(job => job.step === 'whynote' && job.status === 'pending')).toHaveLength(1);
      const refresh = scheduler.tick();
      await vi.waitFor(() => expect(releases).toHaveLength(2));
      if (initialDelete) await store.putProfile({ ...record('a', 'Changed first skill'), depth: 'deep' });
      else await store.deleteProfile('b');
      releases[1](result({ seeing: 'You use the changed skill.', why: 'Also old.', used }));
      await refresh;
      snapshot = await store.snapshot();
      expect(snapshot.cards?.[0].why).toBeNull();
      expect(snapshot.jobs.filter(job => job.step === 'whynote' &&
        ['pending', 'running'].includes(job.status))).toHaveLength(0);
    } finally { scheduler.stop(); store.close(); }
  });
}
it('keeps notes on additions and hides a committed note when a supplied record changes', async () => {
  const store = await openLocalStore(`why-commit-${crypto.randomUUID()}`);
  await store.putProfile(record('a', 'First skill'));
  await store.putProfile(record('b', 'Second skill'));
  await store.saveNotebook(paragraph, 0);
  const run = vi.fn(async (job: Job<unknown>) => {
    job.onDispatch?.();
    if (job.instructions === whynoteV2) {
      return result({ seeing: 'You use your second skill.', why: 'Relevant.', used: [] });
    }
    if (job.instructions === anglesV2) return result({ concerns: [{ item: 1, angle: 'end-user',
      concern: 'Can this be checked?', checkable: true }] });
    if (job.instructions === questionV2) return result({ question: 'What are hosting limits?', keptOut: [] });
    return result({ items: [item] });
  });
  const service = { state: { kind: 'ready' }, subscribe: () => () => {}, runLocal: run } as unknown as LocalService;
  const scheduler = new Scheduler(store, service, () => 'extract.v2', () => {});
  try {
    await scheduler.start(); await scheduler.tick(); await scheduler.tick(); await scheduler.tick();
    let snapshot = await store.snapshot();
    expect(snapshot.cards?.[0].why).not.toBeNull();
    expect(snapshot.cards?.[0].whyFingerprints?.map(value => value.id)).toEqual(['a', 'b']);
    await store.putProfile(record('c', 'Added skill'));
    snapshot = await store.snapshot();
    expect(snapshot.cards?.[0].why).not.toBeNull();
    await store.putProfile(record('b', 'Replaced second skill'));
    snapshot = await store.snapshot();
    expect(snapshot.cards?.[0].why).toBeNull();
    expect(snapshot.jobs.filter(job => job.step === 'whynote' && job.status === 'pending')).toHaveLength(1);
  } finally { scheduler.stop(); store.close(); }
});
