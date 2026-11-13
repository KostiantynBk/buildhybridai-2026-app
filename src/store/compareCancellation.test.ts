import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';
import { LocalModelService, type Model } from '../ai/localModel';
import { openLocalStore, type LocalStore } from './index';
import { Scheduler } from './scheduler';

const old = 'The hosting handles fifty visitors at once. The project has a simple catalogue for early users.';
const edited = 'The hosting handles twenty visitors at once. The project has a simple catalogue for early users.';
const oldQuote = 'The hosting handles fifty visitors at once';
const newQuote = 'The hosting handles twenty visitors at once';
const flush = async () => { for (let i = 0; i < 120; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
async function pendingCompare(store: LocalStore) {
  await store.saveNotebook(`${old}\n\nshort side`, 0);
  await store.enqueueSettled(4000, 'extract.v2');
  const initial = await store.claim(4000);
  if (!initial) throw new Error('Missing extract');
  await store.complete(initial.job, [{ kind: 'assumption', text: 'Fifty', quote: oldQuote, topics: [] }], 4000);
  await store.finalizeReady();
  await store.saveNotebook(`${edited}\n\nshort side`, 10000);
  await store.enqueueSettled(14000, 'extract.v2');
  const updated = await store.claim(14000);
  if (!updated) throw new Error('Missing updated extract');
  await store.complete(updated.job, [{ kind: 'constraint', text: 'Twenty', quote: newQuote, topics: [] }], 14000);
  await store.finalizeReady();
}
async function serviceFixture() {
  let visible = true;
  let onVisibility = () => {};
  let finish!: (result: { source: string; text: () => string }) => void;
  const generate = vi.fn(async (prompt: string) => {
    if (prompt === 'Return JSON with ready set to true.') {
      return { source: 'on_device', text: () => '{"ready":true}' };
    }
    return new Promise<{ source: string; text: () => string }>(resolve => { finish = resolve; });
  });
  const model: Model = { prepare: async () => {}, generate };
  const service = new LocalModelService({ configured: true, hasApi: () => true, availability: async () => 'available',
    createModel: () => model, isForeground: () => visible, onForeground: callback => {
      onVisibility = callback; return () => { onVisibility = () => {}; };
    }, now: () => 100 });
  await service.probe();
  await service.prepare();
  const complete = () => finish({ source: 'on_device',
    text: () => JSON.stringify({ status: 'changed', newQuote }) });
  return { service, generate, complete, setVisible: (value: boolean) => { visible = value; onVisibility(); } };
}
it('does not cancel an already-dispatched comparison when only another paragraph changes', async () => {
  const store = await openLocalStore(`unrelated-${crypto.randomUUID()}`);
  let scheduler: Scheduler | undefined;
  try {
    await pendingCompare(store);
    const fixture = await serviceFixture();
    scheduler = new Scheduler(store, fixture.service, () => 'extract.v2', () => {}, () => 100000);
    const pending = scheduler.start();
    await flush();
    expect(fixture.generate).toHaveBeenCalledTimes(2);
    const snapshot = await store.snapshot();
    const next = `${edited}\n\nshort side updated`;
    scheduler.edited(next, snapshot.paragraphs);
    await store.saveNotebook(next, 20000);
    scheduler.saved();
    fixture.complete();
    await pending;
    const job = (await store.snapshot()).jobs.find(value => value.step === 'compare');
    expect(job).toMatchObject({ status: 'done', attempts: 1 });
    expect(fixture.generate).toHaveBeenCalledTimes(2);
  } finally { scheduler?.stop(); store.close(); }
});
it('counts dispatched cancellations and stops at three for the same compare key', async () => {
  const store = await openLocalStore(`dispatch-cap-${crypto.randomUUID()}`);
  let scheduler: Scheduler | undefined;
  try {
    await pendingCompare(store);
    const fixture = await serviceFixture();
    let now = 100000;
    for (let attempt = 1; attempt <= 3; attempt++) {
      scheduler = new Scheduler(store, fixture.service, () => 'extract.v2', () => {}, () => now);
      const pending = scheduler.start();
      await flush();
      expect(fixture.generate).toHaveBeenCalledTimes(attempt + 1);
      scheduler.stop();
      fixture.complete();
      await pending;
      const job = (await store.snapshot()).jobs.find(value => value.step === 'compare');
      expect(job).toMatchObject({ attempts: attempt, status: attempt === 3 ? 'failed' : 'pending' });
      now += attempt === 1 ? 5000 : 10000;
    }
    await store.finalizeReady();
    expect(await store.claim(now)).toBeNull();
    expect(fixture.generate).toHaveBeenCalledTimes(4);
    expect((await store.lineages()).some(lineage => lineage.unchecked)).toBe(true);
  } finally { scheduler?.stop(); store.close(); }
});
it('refunds a compare cancelled while still queued behind the foreground gate', async () => {
  const store = await openLocalStore(`predispatch-${crypto.randomUUID()}`);
  let scheduler: Scheduler | undefined;
  try {
    await pendingCompare(store);
    const fixture = await serviceFixture();
    fixture.setVisible(false);
    scheduler = new Scheduler(store, fixture.service, () => 'extract.v2', () => {}, () => 100000);
    const pending = scheduler.start();
    await flush();
    scheduler.stop();
    fixture.setVisible(true);
    await pending;
    expect(fixture.generate).toHaveBeenCalledTimes(1);
    expect((await store.snapshot()).jobs.find(value => value.step === 'compare'))
      .toMatchObject({ status: 'pending', attempts: 0 });
  } finally { scheduler?.stop(); store.close(); }
});
