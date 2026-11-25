import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { openLocalStore, type LocalStore } from './index';
import { NotebookPanel } from '../ui/NotebookPanel';

const paragraphs = [
  'First fictional plan assumes enough visitors will use this simple public booking service today.',
  'Second fictional plan assumes regular customers will pay for the service without a discount today.',
  'Third fictional plan assumes the public catalogue will remain responsive under frequent visitor searches.',
];
async function prepare(name: string) {
  const store = await openLocalStore(`${name}-${crypto.randomUUID()}`);
  await store.saveNotebook(paragraphs.join('\n\n'), 0);
  await store.enqueueSettled(4000, 'extract.v2');
  return store;
}
async function finish(store: LocalStore, job: NonNullable<Awaited<ReturnType<LocalStore['claim']>>>, now: number) {
  if (job.job.step === 'extract') {
    await store.complete(job.job, [{ kind: 'assumption', text: `Finding ${job.paragraph.order}`,
      quote: job.paragraph.text.split(' ').slice(0, 4).join(' '), topics: [] }], now, 'on_device');
    await store.finalizeReady();
  } else if (job.job.step === 'angles') {
    const input = await store.anglesInput(job.job);
    expect(input?.paragraph).toBe(paragraphs[job.paragraph.order]);
    expect(input?.items).toHaveLength(1);
    await store.completeAngles(job.job, input!, [
      { item: 1, angle: 'end-user', concern: 'Could real visitors use this fictional service?', checkable: true },
      { item: 1, angle: 'limits-operations', concern: 'What public limits apply to this service?', checkable: true },
    ], 'same-session', now, 'on_device');
  } else throw new Error(`Unexpected step ${job.job.step}`);
}
async function run(interleaved: boolean) {
  const store = await prepare(interleaved ? 'interleave' : 'extract-first');
  const sequence: string[] = [];
  try {
    for (let i = 0; i < 6; i++) {
      if (interleaved || i >= 3) await store.enqueueAngles(4000 + i);
      const job = (await store.claim(4000 + i))!;
      sequence.push(`${job.job.step}:${job.paragraph.order}`);
      const snapshot = await store.snapshot();
      const html = renderToStaticMarkup(<NotebookPanel text={paragraphs.join('\n\n')} save={() => {}}
        storageStatus="saved" snapshot={snapshot} configured ready activeClaim={job.job} />);
      if (job.job.step === 'extract') expect(html).toContain('Reading your paragraph on this device');
      else expect(html).toContain('Looking for things worth checking');
      await finish(store, job, 4000 + i);
    }
    const state = await store.snapshot();
    const order = new Map(state.paragraphs.map(p => [p.id, p.order]));
    const marks = state.cards!.map(c => ({ order: order.get(c.paragraphId), angle: c.angle,
      sourceAngle: c.sourceAngle, quote: c.itemQuote, concern: c.concern, score: c.score }))
      .sort((a, b) => a.order! - b.order! || String(a.angle).localeCompare(String(b.angle)));
    return { sequence, marks };
  } finally { store.close(); }
}
it('interleaves extract and angles in plan order without changing plan-ordered picks', async () => {
  const interleaved = await run(true);
  const oldTiming = await run(false);
  expect(interleaved.sequence).toEqual(['extract:0', 'angles:0', 'extract:1', 'angles:1', 'extract:2', 'angles:2']);
  expect(oldTiming.sequence).toEqual(['extract:0', 'extract:1', 'extract:2', 'angles:0', 'angles:1', 'angles:2']);
  expect(interleaved.marks).toHaveLength(6);
  expect(interleaved.marks).toEqual(oldTiming.marks);
});
it('explicit requested angles jump ahead of automatic extracts', async () => {
  const store = await prepare('requested');
  try {
    const first = (await store.claim(4000))!;
    await finish(store, first, 4000);
    const item = (await store.snapshot()).items[0];
    await store.requestCheck(item.id, 4001);
    const next = (await store.claim(4001))!;
    expect(next.job).toMatchObject({ step: 'angles', requested: true });
  } finally { store.close(); }
});
it('keeps an already stored short item when a new extraction is filtered elsewhere', async () => {
  const store = await prepare('preserve-short');
  try {
    const first = (await store.claim(4000))!;
    await store.complete(first.job, [{ kind: 'assumption', text: 'Old stored item',
      quote: 'First fictional', topics: [] }], 4000, 'on_device');
    await store.finalizeReady();
    expect((await store.snapshot()).items[0].quote).toBe('First fictional');
    await store.enqueueAngles(4001);
    expect((await store.snapshot()).items[0].quote).toBe('First fictional');
  } finally { store.close(); }
});
it('preserves cloud createdAt ordering even when it differs from plan order', async () => {
  const name = `cloud-order-${crypto.randomUUID()}`;
  const store = await openLocalStore(name);
  try {
    await store.setCloudModeConsent(true);
    await store.saveNotebook(paragraphs.join('\n\n'), 0);
    await store.enqueueSettled(4000, 'extract.v2', 'in_cloud');
    const { openDB } = await import('idb');
    const { STORE_VERSION } = await import('./index');
    const db = await openDB(name, STORE_VERSION);
    const state = await store.snapshot();
    const firstId = state.paragraphs.find(p => p.order === 0)!.id;
    const lastId = state.paragraphs.find(p => p.order === 2)!.id;
    for (const job of state.jobs) await db.put('jobs', { ...job, createdAt: job.paragraphId === lastId ? 0 : 10 });
    db.close();
    const claimed = await store.claim(4000, 'in_cloud');
    expect(claimed?.paragraph.id).toBe(lastId);
    expect(claimed?.paragraph.id).not.toBe(firstId);
  } finally { store.close(); }
});
it('orders compare before angles after extract in the same paragraph', async () => {
  const name = `step-order-${crypto.randomUUID()}`;
  const store = await openLocalStore(name);
  try {
    await store.saveNotebook(paragraphs.join('\n\n'), 0);
    await store.enqueueSettled(4000, 'extract.v2');
    const first = (await store.claim(4000))!;
    await finish(store, first, 4000);
    await store.enqueueAngles(4001);
    const { openDB } = await import('idb');
    const { STORE_VERSION } = await import('./index');
    const db = await openDB(name, STORE_VERSION);
    const angle = (await store.snapshot()).jobs.find(job => job.step === 'angles')!;
    await db.put('jobs', { ...angle, key: `${angle.paragraphId}@1#compare#test`, step: 'compare',
      lineageId: 'fixture', promptVersion: 'compare.v1', createdAt: 4001 });
    db.close();
    expect((await store.claim(4001))?.job.step).toBe('compare');
  } finally { store.close(); }
});
it('fences a claimed extraction if the paragraph changes mid-reading', async () => {
  const store = await prepare('edit-mid-reading');
  try {
    const first = (await store.claim(4000))!;
    const edited = paragraphs.map((p, i) => i === 0 ? `${p} A new revision.` : p).join('\n\n');
    await store.saveNotebook(edited, 4001);
    const accepted = await store.complete(first.job, [{ kind: 'assumption', text: 'Stale fake output',
      quote: 'First fictional plan', topics: [] }], 4002, 'on_device');
    expect(accepted).toBe(false);
    expect((await store.snapshot()).items.some(item => item.text === 'Stale fake output')).toBe(false);
  } finally { store.close(); }
});
