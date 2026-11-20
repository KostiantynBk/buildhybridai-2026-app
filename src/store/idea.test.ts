import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';
import { openLocalStore } from './index';
import { researchIdea } from '../ai/researchFlow';
import { CloudProcessingService } from '../ai/cloudProcessing';
import { Scheduler } from './scheduler';
import { modeRouter } from '../ui/modeRouter';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { IdeaPanel } from '../ui/IdeaPanel';

const paragraph = 'Builders use this notebook to plan products and keep assumptions, limits and decisions visible.';
const items = [
  { kind: 'assumption', text: 'Builders plan products', quote: 'Builders use this notebook', topics: [] },
  { kind: 'decision', text: 'Keep decisions visible', quote: 'decisions visible', topics: [] },
  { kind: 'constraint', text: 'Keep limits visible', quote: 'limits and decisions', topics: [] },
];
async function setup() {
  const name = `idea-${crypto.randomUUID()}`;
  const store = await openLocalStore(name);
  await store.saveNotebook(paragraph, 0); await store.enqueueSettled(4000, 'extract.v2');
  const job = await store.claim(4000);
  await store.complete(job!.job, items, 4000, 'on_device'); await store.finalizeReady();
  return { store, name };
}
it('limits an idea basis to twelve ordered current statements', async () => {
  const store = await openLocalStore(`idea-limit-${crypto.randomUUID()}`);
  try {
    const phrases = Array.from({ length: 15 }, (_, index) => `This statement number ${index} has clear words`);
    await store.saveNotebook(phrases.join('. '), 0); await store.enqueueSettled(4000, 'extract.v2');
    const extraction = await store.claim(4000);
    const values = phrases.map((quote, index) => ({ kind: index < 5 ? 'assumption' : 'decision',
      text: `Item ${index}`, quote, topics: [] }));
    await store.complete(extraction!.job, values, 4000, 'on_device'); await store.finalizeReady();
    const idea = (await store.startIdea(5000)).idea!;
    expect(idea.basis).toHaveLength(12);
    expect(idea.statements.slice(0, 10)).toEqual(Array.from({ length: 10 }, (_, index) => `Item ${index + 5}`));
  } finally { store.close(); }
});
it('selects ordered current statements and serializes drafting and approval across tabs', async () => {
  const { store, name } = await setup(); const other = await openLocalStore(name);
  try {
    const starts = await Promise.all([store.startIdea(5000), other.startIdea(5000)]);
    expect(starts.filter(value => value.created)).toHaveLength(1);
    const idea = starts[0].idea!;
    expect((await store.startIdea(5000)).created).toBeUndefined();
    expect((await store.snapshot()).jobs.filter(job => job.step === 'describe')).toHaveLength(1);
    expect(idea.statements).toEqual(['Keep decisions visible', 'Keep limits visible', 'Builders plan products']);
    expect(idea.mode).toBe('on_device');
    const text = 'A notebook helps builders write down the decisions and limits in their product plans.';
    const job = await store.claim(5000);
    await store.finishIdeaDraft(job!.job, text, [], 6000);
    const approvals = await Promise.all([store.approveIdea(idea.id, text), other.approveIdea(idea.id, text)]);
    expect(approvals.filter(value => value.entryId)).toHaveLength(1);
    expect((await store.snapshot()).outbox).toMatchObject([{ kind: 'idea', question: text, edited: false }]);
  } finally { store.close(); other.close(); }
});
it.each([false, true])('supersedes a pending description and redrafts after mode switch (cloud=%s)',
  async fromCloud => {
    const { store } = await setup();
    try {
      if (fromCloud) await store.setCloudModeConsent(true);
      const idea = (await store.startIdea(5000)).idea!;
      await store.setCloudModeConsent(!fromCloud);
      const previous = (await store.snapshot()).jobs.find(job => job.ideaId === idea.id);
      expect(previous).toMatchObject({ status: 'superseded', errorName: 'ModeChanged',
        runMode: fromCloud ? 'in_cloud' : 'on_device' });
      const next = await store.startIdea(6000);
      expect(next.created).toBe(true);
      const jobs = (await store.snapshot()).jobs.filter(job => job.step === 'describe' && job.status === 'pending');
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ ideaId: next.idea!.id, runMode: fromCloud ? 'on_device' : 'in_cloud' });
    } finally { store.close(); }
  });
it('discards a running description result after an explicit mode switch', async () => {
  const { store } = await setup();
  try {
    const idea = (await store.startIdea(5000)).idea!;
    const running = (await store.claim(5000))!.job;
    await store.setCloudModeConsent(true);
    expect(await store.finishIdeaDraft(running, 'A notebook helps people make decisions about their plans.', []))
      .toBe(false);
    expect((await store.snapshot()).jobs.find(job => job.ideaId === idea.id))
      .toMatchObject({ status: 'superseded', errorName: 'ModeChanged' });
  } finally { store.close(); }
});
it('pauses hidden cloud description jobs and sends no profile or never-send list', async () => {
  const { store } = await setup();
  try {
    await store.putProfile({ id: 'private', type: 'skill', depth: 'new', text: 'PROFILE_SENTINEL',
      topics: [], tags: [], updatedAt: 0 });
    await store.putNeverSend(['NEVER_SEND_SENTINEL']);
    await store.setCloudModeConsent(true);
    const idea = (await store.startIdea(5000)).idea!;
    let visible = false;
    const adapter = vi.fn().mockResolvedValue({ source: 'in_cloud', text: JSON.stringify({
      description: 'A notebook helps builders document their product plans and decisions.', keptOut: [] }) });
    const cloud = new CloudProcessingService(store, adapter, () => true, () => 'model', () => {}, Date.now,
      () => visible);
    const local = { state: { kind: 'ready' }, subscribe: () => () => {}, runLocal: vi.fn() };
    const router = modeRouter(local, cloud, () => store.cloudModeConsent(), () => true, () => visible);
    const scheduler = new Scheduler(store, router, () => 'extract.v2', () => {}, Date.now);
    try {
      await scheduler.start();
      expect(adapter).not.toHaveBeenCalled();
      visible = true; await scheduler.tick();
      expect(adapter).toHaveBeenCalledOnce();
      expect(JSON.stringify(adapter.mock.calls)).not.toContain('PROFILE_SENTINEL');
      expect(JSON.stringify(adapter.mock.calls)).not.toContain('NEVER_SEND_SENTINEL');
      expect((await store.snapshot()).jobs.find(job => job.ideaId === idea.id))
        .toMatchObject({ status: 'done', runMode: 'in_cloud' });
    } finally { scheduler.stop(); }
  } finally { store.close(); }
});
it('recovers interrupted descriptions and adopts only the newest same-key attempt', async () => {
  const { store, name } = await setup(); const other = await openLocalStore(name);
  try {
    const idea = (await store.startIdea(5000)).idea!;
    const first = (await store.claim(5000))!.job;
    await other.resume();
    const second = (await other.claim(5000))!.job;
    expect(second.attempts).toBe(first.attempts + 1);
    expect(await store.finishIdeaDraft(first, 'A notebook helps people write clearer plans and decisions.', []))
      .toBe(false);
    await store.fail(first, 'Error', false, 6000);
    expect((await other.snapshot()).jobs.find(job => job.key === second.key)).toMatchObject({
      status: 'running', attempts: second.attempts });
    expect(await other.finishIdeaDraft(second, 'A notebook helps people write clearer plans and decisions.', []))
      .toBe(true);
    expect((await store.snapshot()).ideas!.find(value => value.id === idea.id)?.draft)
      .toBe('A notebook helps people write clearer plans and decisions.');
  } finally { store.close(); other.close(); }
});
it('keeps independent idea entries out of lineage handlers and rechecks before sending', async () => {
  const { store } = await setup();
  try {
    const idea = (await store.startIdea()).idea!;
    const text = 'A notebook helps builders document their product plans and decisions.';
    const job = await store.claim(Date.now());
    await store.finishIdeaDraft(job!.job, text, []);
    const entryId = (await store.approveIdea(idea.id, text)).entryId!;
    await store.setCloudConsent(true);
    expect(await store.preSendCheck(entryId)).toMatchObject({ allowed: false });
    expect(await store.decideOutbox(entryId, 'rejected')).toBe(false);
    await store.reconcileOutbox();
    expect(await store.preSendIdeaCheck(idea.id)).toMatchObject({ allowed: true });
    await store.putNeverSend(['builders']);
    expect(await store.preSendIdeaCheck(idea.id)).toMatchObject({ allowed: false });
    expect((await store.snapshot()).outbox![0]).toMatchObject({ kind: 'idea', status: 'withdrawn' });
  } finally { store.close(); }
});
it('withdraws a confirmed removed basis before any SDK call', async () => {
  const { store } = await setup();
  try {
    const idea = (await store.startIdea()).idea!;
    const job = await store.claim(Date.now());
    const text = 'A notebook helps builders document their product plans and decisions.';
    await store.finishIdeaDraft(job!.job, text, []);
    await store.approveIdea(idea.id, text); await store.setCloudConsent(true);
    await store.saveNotebook('', Date.now());
    const adapter = vi.fn();
    await expect(researchIdea(store, adapter, idea.id, 'model', { budget: 10 })).rejects.toThrow('cannot be sent');
    expect(adapter).not.toHaveBeenCalled();
    expect((await store.snapshot()).outbox![0]).toMatchObject({ status: 'withdrawn', withdrawReason: 'stale' });
  } finally { store.close(); }
});
it('does not send when the basis starts revalidation, and notices edits during a response', async () => {
  for (const beforeSend of [true, false]) {
    const { store } = await setup();
    try {
      const idea = (await store.startIdea()).idea!;
      const job = await store.claim(Date.now());
      const text = 'A notebook helps builders document their product plans and decisions.';
      await store.finishIdeaDraft(job!.job, text, []);
      await store.approveIdea(idea.id, text);
      await store.setCloudConsent(true);
      if (beforeSend) await store.saveNotebook(`${paragraph} More text.`, Date.now());
      const adapter = vi.fn(async () => {
        await store.saveNotebook(`${paragraph} More text.`, Date.now());
        return { source: 'in_cloud', result: { text: 'Example result', parts: ['Example result'], sources: [],
          supports: [], suggestions: '', grounded: false } };
      });
      const attempt = researchIdea(store, adapter, idea.id, 'model', { budget: 10 });
      if (beforeSend) {
        await expect(attempt).rejects.toThrow('cannot be sent');
        expect(adapter).not.toHaveBeenCalled();
      } else {
        expect((await attempt).changedAfterSend).toBe(true);
        expect(adapter).toHaveBeenCalledOnce();
      }
    } finally { store.close(); }
  }
});
it('records edited approval once and rejects declines without an Outbox entry', async () => {
  const { store } = await setup();
  try {
    let idea = (await store.startIdea()).idea!;
    let job = await store.claim(Date.now());
    await store.finishIdeaDraft(job!.job, 'A notebook helps builders document their plans and decisions.', []);
    expect(await store.declineIdea(idea.id)).toBe(true);
    expect((await store.snapshot()).outbox).toEqual([]);
    idea = (await store.startIdea()).idea!;
    job = await store.claim(Date.now());
    await store.finishIdeaDraft(job!.job, 'A notebook helps builders document their plans and decisions.', []);
    const edited = 'A notebook helps solo founders track their plans and assumptions.';
    const result = await store.approveIdea(idea.id, edited);
    expect(result.entryId).toBeDefined();
    expect((await store.snapshot()).outbox![0]).toMatchObject({ kind: 'idea', question: edited, edited: true });
  } finally { store.close(); }
});
it('retains a neutral warning when basis extraction becomes terminal after a result', async () => {
  const { store } = await setup();
  try {
    const idea = (await store.startIdea(5000)).idea!;
    const job = (await store.claim(5000))!.job;
    const text = 'A notebook helps builders document their product plans and decisions.';
    await store.finishIdeaDraft(job, text, []);
    const approval = await store.approveIdea(idea.id, text);
    const reservation = await store.reserveResearch(approval.entryId!, 20);
    await store.finishResearch(reservation!, 'completed'); await store.finishIdeaResearch(idea.id, 'sent');
    await store.saveNotebook(`${paragraph} A new note was added.`, 6000);
    await store.enqueueSettled(11000, 'extract.v2');
    const extraction = (await store.claim(11000))!.job;
    const view = { result: { text: 'Public result', parts: ['Public result'], sources: [], supports: [],
      suggestions: '', grounded: false }, sentAt: 1, latencyMs: 1, attempts: 1, changedAfterSend: false };
    const render = async () => {
      const snapshot = await store.snapshot();
      return renderToStaticMarkup(createElement(IdeaPanel, { snapshot,
        idea: snapshot.ideas!.find(value => value.id === idea.id), view, start: async () => {},
        send: async () => {}, retry: async () => {}, decline: async () => {} }));
    };
    expect(await render()).toContain('Checking your latest change');
    await store.fail(extraction, 'Error', false, 11000, true);
    await store.reconcileOutbox();
    const html = await render();
    expect(html).toContain('We couldn&#x27;t confirm this still matches your plan');
    expect(html).toContain('Public result');
    expect(html).toContain('Research again');
    expect(html).not.toContain('Your plan changed since this was checked');
  } finally { store.close(); }
});
it('checks final text against the latest never-send terms before approval', async () => {
  const { store } = await setup();
  try {
    const idea = (await store.startIdea()).idea!;
    const job = await store.claim(Date.now());
    await store.finishIdeaDraft(job!.job, 'A notebook helps builders document their plans and decisions.', []);
    await store.putNeverSend(['PrivateName']);
    expect((await store.approveIdea(idea.id, 'A notebook for PrivateName')).reason).toContain('never-send');
    expect((await store.snapshot()).outbox).toEqual([]);
  } finally { store.close(); }
});
