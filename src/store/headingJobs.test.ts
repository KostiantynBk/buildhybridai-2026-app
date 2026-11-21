import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { expect, it, vi } from 'vitest';
import { openLocalStore, STORE_VERSION } from './index';
import { firstParagraph, openingMatches } from './ideaBasis';
import { Scheduler } from './scheduler';

const heading = '# This deliberately long heading contains twelve or more words but is only a heading';
const prose = 'This deliberately long prose contains twelve or more words and describes a useful plan in detail.';
it('never enqueues a heading extraction and enqueues normally after editing it into prose', async () => {
  const store = await openLocalStore(`heading-${crypto.randomUUID()}`);
  try {
    await store.saveNotebook(heading, 0); await store.enqueueSettled(4000, 'extract.v2');
    expect((await store.snapshot()).jobs).toEqual([]);
    await store.saveNotebook(prose, 5000); await store.enqueueSettled(9000, 'extract.v2');
    expect((await store.snapshot()).jobs).toMatchObject([{ step: 'extract', status: 'pending' }]);
  } finally { store.close(); }
});
it.each(['pending', 'running'] as const)('supersedes an existing %s heading job without inference', async status => {
  const name = `old-heading-${crypto.randomUUID()}`;
  const store = await openLocalStore(name);
  try {
    await store.saveNotebook(heading, 0);
    const p = (await store.snapshot()).paragraphs[0];
    const raw = await openDB(name, STORE_VERSION);
    await raw.put('jobs', { key: `${p.id}@${p.version}#extract`, paragraphId: p.id, paragraphVersion: p.version,
      step: 'extract', promptVersion: 'extract.v2', status, attempts: status === 'running' ? 1 : 0,
      createdAt: 0, nextRunAt: 0, runMode: 'on_device' });
    raw.close();
    const runLocal = vi.fn();
    const scheduler = new Scheduler(store, { state: { kind: 'ready' }, subscribe: () => () => {}, runLocal },
      () => 'extract.v2', () => {}, () => 5000);
    try {
      await scheduler.start();
      expect(runLocal).not.toHaveBeenCalled();
      expect((await store.snapshot()).jobs[0].status).toBe('superseded');
      expect((await store.snapshot()).paragraphs[0].text).toBe(heading);
    } finally { scheduler.stop(); }
  } finally { store.close(); }
});
it('settles a real requested-angle card when prose becomes a heading', async () => {
  const store = await openLocalStore(`heading-card-${crypto.randomUUID()}`);
  try {
    await store.saveNotebook(prose, 0); await store.enqueueSettled(4000, 'extract.v2');
    const job = (await store.claim(4000))!.job;
    await store.complete(job, [{ kind: 'assumption', text: 'A useful plan', quote: 'useful plan', topics: [] }],
      4000, 'on_device');
    await store.finalizeReady();
    const request = await store.requestCheck((await store.snapshot()).items[0].id, 5000);
    expect(request.cardId).toBeDefined();
    await store.saveNotebook(`# ${prose}`, 6000);
    const state = await store.snapshot();
    expect(state.cards!.find(card => card.id === request.cardId))
      .toMatchObject({ questionStatus: 'blocked', questionReason: 'stale' });
    expect(state.jobs.find(value => value.cardId === request.cardId && value.step === 'angles'))
      .toMatchObject({ status: 'superseded' });
  } finally { store.close(); }
});
it('settles a parked legacy heading card before the model is ready', async () => {
  const name = `legacy-heading-card-${crypto.randomUUID()}`;
  const store = await openLocalStore(name);
  try {
    await store.saveNotebook(heading, 0);
    const paragraph = (await store.snapshot()).paragraphs[0];
    const raw = await openDB(name, STORE_VERSION);
    await raw.put('cards', { id: 'legacy-card', paragraphId: paragraph.id, paragraphVersion: paragraph.version,
      questionStatus: 'waiting', askedDirectly: true });
    await raw.put('jobs', { key: 'legacy-angle', paragraphId: paragraph.id, paragraphVersion: paragraph.version,
      step: 'angles', promptVersion: 'angles.v2.1', status: 'pending', attempts: 0, createdAt: 0, nextRunAt: 0,
      runMode: 'on_device', requested: true, cardId: 'legacy-card' });
    raw.close();
    const runLocal = vi.fn();
    const scheduler = new Scheduler(store, { state: { kind: 'unsupported' }, subscribe: () => () => {}, runLocal },
      () => 'extract.v2', () => {}, () => 5000);
    try {
      await scheduler.start();
      const state = await store.snapshot();
      expect(state.jobs.find(value => value.key === 'legacy-angle')?.status).toBe('superseded');
      expect(state.cards!.find(value => value.id === 'legacy-card'))
        .toMatchObject({ questionStatus: 'blocked', questionReason: 'stale' });
      expect(runLocal).not.toHaveBeenCalled();
    } finally { scheduler.stop(); }
  } finally { store.close(); }
});
it('does not dispatch old heading-anchored angle work', async () => {
  const name = `old-heading-angle-${crypto.randomUUID()}`;
  const store = await openLocalStore(name);
  try {
    await store.saveNotebook(heading, 0);
    const p = (await store.snapshot()).paragraphs[0];
    const raw = await openDB(name, STORE_VERSION);
    await raw.put('jobs', { key: 'old-angle', paragraphId: p.id, paragraphVersion: p.version, step: 'angles',
      promptVersion: 'angles.v2.1', status: 'pending', attempts: 0, createdAt: 0, nextRunAt: 0,
      runMode: 'on_device' });
    raw.close();
    const runLocal = vi.fn();
    const scheduler = new Scheduler(store, { state: { kind: 'ready' }, subscribe: () => () => {}, runLocal },
      () => 'extract.v2', () => {}, () => 5000);
    try {
      await scheduler.start();
      expect(runLocal).not.toHaveBeenCalled();
      expect((await store.snapshot()).jobs.find(job => job.key === 'old-angle')?.status).toBe('superseded');
    } finally { scheduler.stop(); }
  } finally { store.close(); }
});
it('pins the first non-heading paragraph through idea approval and pre-send', async () => {
  const store = await openLocalStore(`heading-idea-${crypto.randomUUID()}`);
  try {
    await store.saveNotebook(`${heading}\n\n${prose}`, 0); await store.enqueueSettled(4000, 'extract.v2');
    const job = (await store.claim(4000))!.job;
    await store.complete(job, [
      { kind: 'assumption', text: 'A plan is useful', quote: 'useful plan', topics: [] },
      { kind: 'decision', text: 'Describe it', quote: 'describes', topics: [] },
      { kind: 'constraint', text: 'Contains details', quote: 'in detail', topics: [] },
    ], 4000, 'on_device');
    await store.finalizeReady();
    const idea = (await store.startIdea(5000)).idea!;
    const p = (await store.snapshot()).paragraphs.find(value => value.text === prose)!;
    expect(idea.openingBasis).toEqual({ id: p.id, version: p.version, order: p.order });
    const description = 'A planning tool helps people describe a useful plan in detail.';
    await store.finishIdeaDraft((await store.claim(5000))!.job, description, [], 5000);
    expect((await store.approveIdea(idea.id, description)).entryId).toBeDefined();
    await store.setCloudConsent(true);
    expect((await store.preSendIdeaCheck(idea.id)).allowed).toBe(true);
    await store.saveNotebook(`${prose}\n\n${heading}`, 6000);
    expect(await store.preSendIdeaCheck(idea.id)).toEqual({ allowed: false, reason: 'stale' });
  } finally { store.close(); }
});
it('fails closed without throwing when a stored v2 opening points at a heading', async () => {
  const name = `heading-old-idea-${crypto.randomUUID()}`;
  const store = await openLocalStore(name);
  try {
    await store.saveNotebook(`${heading}\n\n${prose}`, 0); await store.enqueueSettled(4000, 'extract.v2');
    const job = (await store.claim(4000))!.job;
    await store.complete(job, [
      { kind: 'assumption', text: 'A plan is useful', quote: 'useful plan', topics: [] },
      { kind: 'decision', text: 'Describe it', quote: 'describes', topics: [] },
      { kind: 'constraint', text: 'Contains details', quote: 'in detail', topics: [] },
    ], 4000, 'on_device');
    await store.finalizeReady();
    const idea = (await store.startIdea(5000)).idea!;
    const original = (await store.snapshot()).paragraphs.find(value => value.text === heading)!;
    const raw = await openDB(name, STORE_VERSION);
    const row = await raw.get('ideas', idea.id);
    row.openingBasis = { id: original.id, version: original.version, order: original.order };
    await raw.put('ideas', row); raw.close();
    await store.resume();
    expect((await store.snapshot()).jobs.find(value => value.key === idea.describeJobKey))
      .toMatchObject({ status: 'superseded', errorName: 'PlanChanged' });
    expect((await store.approveIdea(idea.id, 'A useful planning tool helps builders describe their ideas.')).entryId)
      .toBeUndefined();
  } finally { store.close(); }
});
it('uses the first non-heading for v2 and fails closed on heading-only or stale openings', async () => {
  const store = await openLocalStore(`heading-basis-${crypto.randomUUID()}`);
  try {
    await store.saveNotebook(`${heading}\n\n## Second heading`, 0);
    const headings = (await store.snapshot()).paragraphs;
    expect(firstParagraph(headings)).toBeUndefined();
    expect((await store.startIdea()).idea).toBeUndefined();
    expect(openingMatches({ id: headings[0].id, version: headings[0].version, order: headings[0].order },
      headings, true)).toBe(false);
    expect(openingMatches(undefined, headings, false)).toBe(true);
    await store.saveNotebook(`${heading}\n\n${prose}`, 5000);
    const paragraphs = (await store.snapshot()).paragraphs;
    const first = firstParagraph(paragraphs)!;
    expect(first.text).toBe(prose);
    const basis = { id: first.id, version: first.version, order: first.order };
    expect(openingMatches(basis, paragraphs, true)).toBe(true);
    await store.saveNotebook(`${prose}\n\n${heading}`, 6000);
    expect(openingMatches(basis, (await store.snapshot()).paragraphs, true)).toBe(false);
  } finally { store.close(); }
});
