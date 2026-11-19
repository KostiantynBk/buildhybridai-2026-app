import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';
import { CloudProcessingService, type CloudProcessingAdapter } from '../ai/cloudProcessing';
import { anglesV21 } from '../pipeline/prompts/angles.v2.1';
import { questionV21 } from '../pipeline/prompts/question.v2.1';
import { openLocalStore } from './index';
import { Scheduler, type LocalService } from './scheduler';
import { modeRouter } from '../ui/modeRouter';
import { checkFirstMark } from './t08Fixtures';

it('pauses hidden work, preserves a raced reservation, and resumes once without a duplicate', async () => {
  const store = await openLocalStore(`cloud-visibility-${crypto.randomUUID()}`);
  await store.saveNotebook('This paragraph has enough words to test cloud dispatch while the tab is hidden.', 0);
  await store.setCloudModeConsent(true);
  let visible = false;
  let race = true;
  const reservations = { cloudModeConsent: () => store.cloudModeConsent(),
    reserveCloudProcessing: async (now: number) => {
      const key = await store.reserveCloudProcessing(now);
      if (race) { visible = false; race = false; }
      return key;
    }, cancelCloudProcessingReservation: (key: number) => store.cancelCloudProcessingReservation(key) };
  const adapter = vi.fn<CloudProcessingAdapter>().mockResolvedValue({ source: 'in_cloud', text: '{"items":[]}' });
  const cloud = new CloudProcessingService(reservations, adapter, () => true, () => 'model', () => {},
    () => 20000, () => visible);
  const local = { state: { kind: 'ready' }, subscribe: () => () => {}, runLocal: vi.fn() } as LocalService;
  const router = modeRouter(local, cloud, () => store.cloudModeConsent(), () => true, () => visible);
  const scheduler = new Scheduler(store, router, () => 'extract.v2', () => {}, () => 20000);
  try {
    await scheduler.start();
    expect(adapter).not.toHaveBeenCalled();
    expect((await store.snapshot()).jobs[0].status).toBe('pending');
    visible = true;
    await scheduler.tick();
    const paused = await store.snapshot();
    expect(adapter).not.toHaveBeenCalled();
    expect(paused.jobs[0]).toMatchObject({ status: 'pending', attempts: 0 });
    expect(paused.cloudProcessingSends).toHaveLength(1);
    visible = true;
    await scheduler.tick(); await scheduler.tick();
    expect(adapter).toHaveBeenCalledTimes(1);
    const completed = await store.snapshot();
    expect(completed.jobs[0]).toMatchObject({ status: 'done', runMode: 'in_cloud' });
    expect(completed.cloudProcessingSends).toHaveLength(2);
  } finally { scheduler.stop(); store.close(); }
});
it('adopts an already dispatched response even if the tab hides afterward', async () => {
  const store = await openLocalStore(`cloud-hide-flight-${crypto.randomUUID()}`);
  await store.saveNotebook('This paragraph contains enough words to begin a permitted cloud extraction job.', 0);
  await store.setCloudModeConsent(true);
  let visible = true;
  let finish!: (value: { source: string; text: string }) => void;
  const adapter = vi.fn<CloudProcessingAdapter>(() => new Promise(resolve => { finish = resolve; }));
  const cloud = new CloudProcessingService(store, adapter, () => true, () => 'model', () => {}, () => 20000,
    () => visible);
  const local = { state: { kind: 'ready' }, subscribe: () => () => {}, runLocal: vi.fn() } as LocalService;
  const router = modeRouter(local, cloud, () => store.cloudModeConsent(), () => true, () => visible);
  const scheduler = new Scheduler(store, router, () => 'extract.v2', () => {}, () => 20000);
  try {
    const starting = scheduler.start();
    await vi.waitFor(() => expect(finish).toBeDefined());
    visible = false;
    finish({ source: 'in_cloud', text: '{"items":[]}' });
    await starting;
    expect((await store.snapshot()).jobs[0]).toMatchObject({ status: 'done', measuredSource: 'in_cloud' });
    expect(adapter).toHaveBeenCalledOnce();
  } finally { scheduler.stop(); store.close(); }
});
it('discards an in-flight response after opt-out and cancels the running job', async () => {
  const store = await openLocalStore(`cloud-opt-out-${crypto.randomUUID()}`);
  await store.saveNotebook('This paragraph has enough words to begin a cloud extraction job after approval.', 0);
  await store.setCloudModeConsent(true);
  let active = true;
  let finish!: (value: { source: string; text: string }) => void;
  const adapter = vi.fn<CloudProcessingAdapter>(() => new Promise(resolve => { finish = resolve; }));
  const cloud = new CloudProcessingService(store, adapter, () => active, () => 'model', () => {});
  const service = { state: { kind: 'ready' }, subscribe: cloud.subscribe, runLocal: cloud.runLocal.bind(cloud) };
  const scheduler = new Scheduler(store, service, () => 'extract.v2', () => {}, () => 20000);
  try {
    const starting = scheduler.start();
    await vi.waitFor(() => expect(finish).toBeDefined());
    active = false; scheduler.modeChanged();
    await store.setCloudModeConsent(false);
    finish({ source: 'in_cloud', text: '{"items":[]}' });
    await starting;
    expect((await store.snapshot()).items).toEqual([]);
    expect((await store.snapshot()).jobs.find(job => job.step === 'extract')?.status).toBe('failed');
    expect(cloud.message).toContain('discarded');
  } finally { scheduler.stop(); store.close(); }
});
it('runs the v2.1 cloud pipeline end to end without sending local profile, terms or unrelated paragraphs', async () => {
  const store = await openLocalStore(`cloud-scheduler-${crypto.randomUUID()}`);
  const paragraph = 'The hosted service supports fifty visitors at once and provides a simple early catalogue.';
  const quote = 'The hosted service supports fifty visitors at once';
  await store.putProfile({ id: 's', type: 'skill', depth: 'new', text: 'PROFILE_SENTINEL', topics: ['hosting'],
    tags: [], updatedAt: 0 });
  await store.putNeverSend(['NEVER_SEND_SENTINEL']);
  await store.saveNotebook(`${paragraph}\n\nUNRELATED_PARAGRAPH_SENTINEL`, 0);
  await store.setCloudModeConsent(true);
  const adapter = vi.fn<CloudProcessingAdapter>(async job => ({ source: 'in_cloud', text: JSON.stringify(
    job.instructions === anglesV21 ? { concerns: [{ item: 1, angle: 'end-user',
      concern: 'Can visitors reach this hosting service reliably?', checkable: true }] } :
      job.instructions === questionV21 ? { question: 'What are the hosting limits?', keptOut: [] } :
        { items: [{ kind: 'assumption', text: 'Fifty visitors', quote, topics: ['hosting'] }] }) }));
  const cloud = new CloudProcessingService(store, adapter, () => true, () => 'model', () => {});
  const service = { state: { kind: 'ready' }, subscribe: cloud.subscribe, runLocal: cloud.runLocal.bind(cloud) };
  const scheduler = new Scheduler(store, service, () => 'extract.v2', () => {}, () => 20000);
  try {
    await scheduler.start(); for (let i = 0; i < 3; i++) await scheduler.tick();
    expect((await store.snapshot()).outbox).toHaveLength(0);
    await checkFirstMark(store);
    for (let i = 0; i < 3; i++) await scheduler.tick();
    const snapshot = await store.snapshot();
    expect(snapshot.cards).toHaveLength(1);
    expect(snapshot.cards![0].questionStatus).toBe('ready');
    expect(snapshot.outbox).toHaveLength(0);
    expect(snapshot.jobs.filter(job => job.status === 'done').map(job => job.measuredSource))
      .toEqual(['in_cloud', 'in_cloud', 'in_cloud']);
    expect(snapshot.cloudProcessingSends).toHaveLength(3);
    for (const call of adapter.mock.calls) {
      const prompt = call[0].prompt;
      expect(prompt).not.toContain('PROFILE_SENTINEL');
      expect(prompt).not.toContain('NEVER_SEND_SENTINEL');
      expect(prompt).not.toContain('UNRELATED_PARAGRAPH_SENTINEL');
    }
  } finally { scheduler.stop(); store.close(); }
});
