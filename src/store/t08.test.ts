import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { expect, it, vi } from 'vitest';
import { CloudProcessingService, type CloudProcessingAdapter } from '../ai/cloudProcessing';
import { questionV21 } from '../pipeline/prompts/question.v2.1';
import { anglesV21 } from '../pipeline/prompts/angles.v2.1';
import { Scheduler, type LocalService } from './scheduler';
import { openLocalStore, STORE_VERSION, type LocalStore } from './index';

const paragraph = 'The hosting plan supports fifty visitors while another payment service handles each purchase.';
const items = [
  { kind: 'assumption', text: 'Hosting supports fifty visitors', quote: 'The hosting plan supports fifty visitors',
    topics: ['hosting'] },
  { kind: 'decision', text: 'Payment service handles purchase', quote: 'another payment service handles each purchase',
    topics: ['payments'] },
];
async function setup() {
  const name = `t08-${crypto.randomUUID()}`;
  const store = await openLocalStore(name);
  await store.saveNotebook(paragraph, 0);
  await store.enqueueSettled(4000, 'extract.v2');
  const extraction = await store.claim(4000);
  if (!extraction) throw new Error('Missing extraction');
  await store.complete(extraction.job, items, 4000, 'on_device');
  await store.finalizeReady();
  return { store, name };
}
async function makeMark(store: LocalStore) {
  await store.enqueueAngles(5000);
  const claimed = await store.claim(5000);
  if (!claimed) throw new Error('Missing angles job');
  const input = await store.anglesInput(claimed.job);
  if (!input) throw new Error('Missing angles input');
  await store.completeAngles(claimed.job, input, [{ item: 1, angle: 'end-user',
    concern: 'What are the real hosting limits?', checkable: true }], 's', 5000, 'on_device');
}
it('creates a quiet mark, one mode-pinned question on double click, and no pending Outbox entry', async () => {
  const { store, name } = await setup();
  const second = await openLocalStore(name);
  try {
    await makeMark(store);
    const before = await store.snapshot();
    const mark = before.cards![0];
    expect(mark.questionStatus).toBe('marked');
    expect(before.dependencies).toHaveLength(1);
    expect(before.jobs.filter(job => job.step === 'question')).toHaveLength(0);
    expect(before.outbox).toEqual([]);
    const item = before.items.find(value => value.lineageId === mark.itemLineageId)!;
    const results = await Promise.all([store.requestCheck(item.id, 6000), second.requestCheck(item.id, 6000)]);
    expect(results.every(value => value.cardId === mark.id)).toBe(true);
    const after = await store.snapshot();
    expect(after.jobs.filter(job => job.step === 'question')).toHaveLength(1);
    expect(after.jobs.find(job => job.step === 'question')).toMatchObject({ promptVersion: 'question.v2.1',
      runMode: 'on_device' });
  } finally { store.close(); second.close(); }
});
it.each(['on_device', 'in_cloud'] as const)('recovers pending and running requested jobs in %s', async mode => {
  for (const running of [false, true]) {
    const { store, name } = await setup();
    const other = await openLocalStore(name);
    try {
      if (mode === 'in_cloud') await store.setCloudModeConsent(true);
      const before = await store.snapshot();
      const item = before.items.find(value => value.kind === 'assumption')!;
      const requested = await store.requestCheck(item.id, 5000);
      const old = running ? (await store.claim(5000, mode))!.job : (await store.snapshot()).jobs
        .find(job => job.cardId === requested.cardId)!;
      const oldInput = running ? await store.anglesInput(old) : null;
      await store.saveNotebook(`${paragraph} Another unrelated sentence.`, 6000);
      await store.enqueueSettled(11000, 'extract.v2');
      const extract = await store.claim(11000, mode);
      expect(extract?.job.step).toBe('extract');
      await store.complete(extract!.job, items, 11000, mode);
      await store.finalizeReady();
      let after = await store.snapshot();
      const current = after.items.find(value => value.lineageId === item.lineageId && value.status === 'current')!;
      const results = await Promise.all([store.requestCheck(current.id), other.requestCheck(current.id)]);
      expect(results.every(result => result.cardId === requested.cardId)).toBe(true);
      after = await store.snapshot();
      const jobs = after.jobs.filter(job => job.cardId === requested.cardId &&
        (job.status === 'pending' || job.status === 'running'));
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ step: 'angles', requested: true, runMode: mode, attempts: running ? 1 : 0 });
      if (running) {
        expect(await store.completeAngles(old, oldInput!, [], 'old', 12000, mode)).toBe(false);
        expect((await store.snapshot()).cards!.find(card => card.id === requested.cardId)?.questionStatus)
          .toBe('waiting');
      }
    } finally { store.close(); other.close(); }
  }
});
it('requeues one orphaned waiting request across two connections without resetting attempts', async () => {
  const { store, name } = await setup();
  const second = await openLocalStore(name);
  try {
    const item = (await store.snapshot()).items[0];
    const request = await store.requestCheck(item.id, 5000);
    const job = (await store.claim(5000))!.job;
    const db = await openDB(name, STORE_VERSION);
    try { await db.put('jobs', { ...job, status: 'superseded' }); } finally { db.close(); }
    const clicks = await Promise.all([store.requestCheck(item.id), second.requestCheck(item.id)]);
    expect(clicks.every(result => result.cardId === request.cardId)).toBe(true);
    const live = (await store.snapshot()).jobs.filter(value => value.cardId === request.cardId &&
      (value.status === 'pending' || value.status === 'running'));
    expect(live).toHaveLength(1);
    expect(live[0].attempts).toBe(1);
  } finally { store.close(); second.close(); }
});
it('marks a requested check stale when its source paragraph is deleted', async () => {
  const { store } = await setup();
  try {
    const item = (await store.snapshot()).items[0];
    const request = await store.requestCheck(item.id, 5000);
    await store.saveNotebook('', 6000);
    expect((await store.snapshot()).cards!.find(card => card.id === request.cardId))
      .toMatchObject({ questionStatus: 'blocked', questionReason: 'stale' });
  } finally { store.close(); }
});
it('blocks an interrupted request when comparison confirms a changed lineage', async () => {
  const { store } = await setup();
  try {
    const item = (await store.snapshot()).items.find(value => value.kind === 'assumption')!;
    const request = await store.requestCheck(item.id, 5000);
    await store.saveNotebook(paragraph.replace('fifty', 'twenty'), 6000);
    await store.enqueueSettled(11000, 'extract.v2');
    const extract = await store.claim(11000);
    await store.complete(extract!.job, [{ ...items[0], text: 'Hosting supports twenty visitors',
      quote: items[0].quote.replace('fifty', 'twenty') }, items[1]], 11000, 'on_device');
    const compare = await store.claim(11000);
    await store.completeComparison(compare!.job, { status: 'changed', newQuote: items[0].quote.replace('fifty',
      'twenty'), newQuoteFound: true, needsConfirmation: false, source: 'on_device', latencyMs: 1,
      promptVersion: 'compare.v1' });
    await store.finalizeReady();
    const after = await store.snapshot();
    expect(after.cards!.find(card => card.id === request.cardId))
      .toMatchObject({ questionStatus: 'blocked', questionReason: 'stale' });
    expect(after.jobs.filter(job => job.cardId === request.cardId &&
      (job.status === 'pending' || job.status === 'running'))).toHaveLength(0);
  } finally { store.close(); }
});
it('does not start a marked check while its statement is being revalidated', async () => {
  const { store } = await setup();
  try {
    await makeMark(store);
    const before = await store.snapshot();
    const item = before.items.find(value => value.lineageId === before.cards![0].itemLineageId)!;
    await store.saveNotebook(`${paragraph} Another sentence.`, 6000);
    expect((await store.requestCheck(item.id, 7000)).reason).toBeDefined();
    expect((await store.snapshot()).jobs.filter(job => job.step === 'question')).toHaveLength(0);
  } finally { store.close(); }
});
it('keeps final text editable, blocks private terms, atomically approves once, and records decline only in funnel',
  async () => {
    const { store, name } = await setup();
    const other = await openLocalStore(name);
    try {
      await makeMark(store);
      let snapshot = await store.snapshot();
      const item = snapshot.items.find(value => value.lineageId === snapshot.cards![0].itemLineageId)!;
      await store.requestCheck(item.id, 6000);
      const claimed = await store.claim(6000);
      if (!claimed) throw new Error('Missing question');
      await store.completeQuestion(claimed.job, 'What are hosting limits?', [], true, 7000, 'on_device');
      snapshot = await store.snapshot();
      expect(snapshot.cards![0]).toMatchObject({ questionStatus: 'ready', questionPromptVersion: 'question.v2.1' });
      expect(snapshot.outbox).toEqual([]);
      await store.putNeverSend(['SECRET_NAME']);
      expect((await store.approveDraft(snapshot.cards![0].id, 'What about SECRET_NAME?')).reason)
        .toContain('never-send term');
      expect((await store.snapshot()).outbox).toEqual([]);
      const accepted = await Promise.all([store.approveDraft(snapshot.cards![0].id, 'What are hosting limits today?'),
        other.approveDraft(snapshot.cards![0].id, 'What are hosting limits today?')]);
      expect(accepted.filter(value => value.entryId)).toHaveLength(1);
      const entries = (await store.snapshot()).outbox!;
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ status: 'approved', edited: true, question: 'What are hosting limits today?',
        questionPromptVersion: 'question.v2.1' });
    } finally { store.close(); other.close(); }
  });
it('reopens a declined manual question and approves it once without recording the refusal in Outbox', async () => {
  const { store } = await setup();
  try {
    const initial = await store.snapshot();
    const target = initial.items.find(value => value.kind === 'decision')!;
    const requested = await store.requestCheck(target.id, 5000);
    const angles = await store.claim(5000);
    const input = await store.anglesInput(angles!.job);
    await store.completeAngles(angles!.job, input!, [], 's', 6000, 'on_device');
    const cardId = requested.cardId!;
    expect(await store.declineDraft(cardId)).toBe(true);
    expect((await store.snapshot()).outbox).toEqual([]);
    expect((await store.funnel()).some(event => event.event === 'outbox' && event.reason === 'rejected')).toBe(true);
    expect(await store.reopenDraft(cardId)).toBe(true);
    const text = 'What are payment service limits?';
    const first = await store.approveDraft(cardId, text, ['PRIVATE_TOKEN']);
    expect(first.entryId).toBeDefined();
    expect((await store.snapshot()).outbox![0]).toMatchObject({ question: text, edited: true, status: 'approved' });
    expect((await store.approveDraft(cardId, text)).entryId).toBeUndefined();
  } finally { store.close(); }
});
it('blocks an unlisted private token when explicitly supplied to the final filter', async () => {
  const { store } = await setup();
  try {
    await makeMark(store);
    const snapshot = await store.snapshot();
    const card = snapshot.cards![0];
    const item = snapshot.items.find(value => value.lineageId === card.itemLineageId)!;
    await store.requestCheck(item.id, 6000);
    const job = await store.claim(6000);
    await store.completeQuestion(job!.job, 'What are hosting limits?', [], true, 7000, 'on_device');
    const blocked = await store.approveDraft(card.id, 'What is PRIVATE_TOKEN?', ['PRIVATE_TOKEN']);
    expect(blocked.reason).toContain('private token');
    expect((await store.snapshot()).outbox).toEqual([]);
    const approved = await store.approveDraft(card.id, 'What are hosting limits?');
    expect(approved.entryId).toBeDefined();
    expect((await store.snapshot()).outbox![0]).toMatchObject({ edited: false, question: 'What are hosting limits?' });
  } finally { store.close(); }
});
it('refuses a send while an edit is being checked without creating an entry', async () => {
  const { store } = await setup();
  try {
    await makeMark(store);
    const snapshot = await store.snapshot();
    const card = snapshot.cards![0];
    const item = snapshot.items.find(value => value.lineageId === card.itemLineageId)!;
    await store.requestCheck(item.id, 6000);
    const question = await store.claim(6000);
    await store.completeQuestion(question!.job, 'What are hosting limits?', [], true, 7000, 'on_device');
    await store.saveNotebook(`${paragraph} Another sentence.`, 8000);
    expect((await store.approveDraft(card.id, 'What are hosting limits?')).reason).toContain('Checking');
    expect((await store.snapshot()).outbox).toEqual([]);
    await store.saveNotebook(paragraph.replace('fifty', 'twenty'), 9000);
    await store.enqueueSettled(14000, 'extract.v2');
    const extraction = await store.claim(14000);
    await store.complete(extraction!.job, [{ ...items[0], text: 'Hosting supports twenty visitors',
      quote: items[0].quote.replace('fifty', 'twenty') }, items[1]], 14000, 'on_device');
    const comparison = await store.claim(14000);
    await store.completeComparison(comparison!.job, { status: 'changed', newQuote: items[0].quote.replace('fifty',
      'twenty'), newQuoteFound: true, needsConfirmation: false, source: 'on_device', latencyMs: 1,
      promptVersion: 'compare.v1' });
    await store.finalizeReady();
    expect((await store.approveDraft(card.id, 'What are hosting limits?')).reason).toContain('plan changed');
    expect((await store.snapshot()).outbox).toEqual([]);
  } finally { store.close(); }
});
it('runs single-item angles for an unmarked statement and supports a typed question when nothing is checkable',
  async () => {
    const { store } = await setup();
    try {
      const initial = await store.snapshot();
      const target = initial.items.find(value => value.kind === 'decision')!;
      const requested = await store.requestCheck(target.id, 5000);
      expect(requested.cardId).toBeDefined();
      const job = await store.claim(5000);
      if (!job) throw new Error('Missing requested angles');
      const input = await store.anglesInput(job.job);
      expect(input?.items).toHaveLength(1);
      expect(input?.items[0].text).toBe(target.text);
      expect(JSON.stringify(input?.items)).not.toContain('Hosting supports fifty visitors');
      await store.completeAngles(job.job, input!, [
        { item: 2, angle: 'end-user', concern: 'An invalid numbered item', checkable: true },
        { item: 1, angle: 'end-user', concern: 'Too short', checkable: true },
        { item: 1, angle: 'alternatives', concern: 'A competing option for this decision', checkable: true },
      ], 's', 6000, 'on_device');
      const card = (await store.snapshot()).cards!.find(value => value.id === requested.cardId)!;
      expect(card).toMatchObject({ questionStatus: 'ready', askedDirectly: true, noCheckable: true });
      expect(card.angle).toBeUndefined();
      expect(card.concern).toBeUndefined();
      expect((await store.approveDraft(card.id, 'What are payment service limits?')).entryId).toBeDefined();
    } finally { store.close(); }
  });
it('sends a single requested item in cloud mode without profile, list or unrelated item sentinels', async () => {
  const { store, name } = await setup();
  try {
    const before = await store.snapshot();
    const other = before.items.find(item => item.kind === 'assumption')!;
    const target = before.items.find(item => item.kind === 'decision')!;
    const db = await openDB(name, STORE_VERSION);
    try { await db.put('items', { ...other, text: 'OTHER_ITEM_SENTINEL' }); } finally { db.close(); }
    await store.putProfile({ id: 'private', type: 'skill', depth: 'new', text: 'PROFILE_SENTINEL',
      topics: ['payments'], tags: [], updatedAt: 0 });
    await store.putNeverSend(['NEVER_SEND_SENTINEL']);
    await store.setCloudModeConsent(true);
    await store.requestCheck(target.id, 6000);
    const adapter = vi.fn<CloudProcessingAdapter>(async job => ({ source: 'in_cloud', text: JSON.stringify(
      job.instructions === anglesV21 ? { concerns: [{ item: 1, angle: 'end-user',
        concern: 'What are the payment service requirements?', checkable: true }] }
        : { question: 'What are payment service requirements?', keptOut: [] }) }));
    const cloud = new CloudProcessingService(store, adapter, () => true, () => 'model', () => {});
    const service = { state: { kind: 'ready' }, subscribe: cloud.subscribe, runLocal: cloud.runLocal.bind(cloud) };
    const scheduler = new Scheduler(store, service, () => 'extract.v2', () => {}, () => 6000);
    try { await scheduler.start(); await scheduler.tick(); } finally { scheduler.stop(); }
    expect(adapter).toHaveBeenCalledTimes(2);
    expect(adapter.mock.calls[0][0].instructions).toBe(anglesV21);
    for (const [job] of adapter.mock.calls) {
      expect(job.prompt).not.toContain('OTHER_ITEM_SENTINEL');
      expect(job.prompt).not.toContain('PROFILE_SENTINEL');
      expect(job.prompt).not.toContain('NEVER_SEND_SENTINEL');
    }
    expect(adapter.mock.calls[0][0].prompt).toContain(paragraph);
    expect((await store.snapshot()).cards!.find(card => card.itemLineageId === target.lineageId))
      .toMatchObject({ askedDirectly: true, questionStatus: 'ready' });
  } finally { store.close(); }
});
it('ignores prior pairs and per-moment card limits for an explicitly requested statement', async () => {
  const { store, name } = await setup();
  try {
    await makeMark(store);
    const snapshot = await store.snapshot();
    const target = snapshot.items.find(item => item.kind === 'decision')!;
    const head = snapshot.lineages!.find(lineage => lineage.lineageId === target.lineageId)!;
    const original = snapshot.cards![0];
    const db = await openDB(name, STORE_VERSION);
    try {
      for (let i = 0; i < 3; i++) await db.put('cards', { ...original, id: `old-${i}`, itemLineageId: head.lineageId,
        itemVersion: head.version, itemText: target.text, itemQuote: target.quote, itemKind: target.kind,
        angle: 'end-user', sourceAngle: 'end-user', supersededMark: true });
    } finally { db.close(); }
    const requested = await store.requestCheck(target.id, 6000);
    const job = await store.claim(6000);
    const input = await store.anglesInput(job!.job);
    await store.completeAngles(job!.job, input!, [{ item: 1, angle: 'end-user',
      concern: 'What are the public payment requirements?', checkable: true }], 's', 7000, 'on_device');
    const after = await store.snapshot();
    expect(after.jobs.find(value => value.cardId === requested.cardId && value.step === 'question'))
      .toMatchObject({ promptVersion: 'question.v2.1', status: 'pending' });
  } finally { store.close(); }
});
it('suppresses an automatic mark racing a requested check for the same pair', async () => {
  const { store } = await setup();
  try {
    await store.enqueueAngles(5000);
    const initial = await store.snapshot();
    const target = initial.items.find(item => item.kind === 'assumption')!;
    const automatic = await store.claim(6000);
    const automaticInput = await store.anglesInput(automatic!.job);
    const requested = await store.requestCheck(target.id, 6000);
    const concern = { item: 1, angle: 'end-user' as const, concern: 'What are the public hosting limits?',
      checkable: true };
    await store.completeAngles(automatic!.job, automaticInput!, [concern], 's', 6000, 'on_device');
    const request = await store.claim(6000);
    expect(request?.job.requested).toBe(true);
    const requestInput = await store.anglesInput(request!.job);
    await store.completeAngles(request!.job, requestInput!, [concern], 's', 7000, 'on_device');
    const cards = (await store.snapshot()).cards!;
    expect(cards.find(card => card.id === requested.cardId)?.sourceAngle).toBe('end-user');
    expect(cards.find(card => card.id !== requested.cardId)?.supersededMark).toBe(true);
  } finally { store.close(); }
});
it('creates an editable manual state without a model job for an ineligible legacy item', async () => {
  const { store, name } = await setup();
  try {
    const snapshot = await store.snapshot();
    const item = snapshot.items[0];
    const db = await openDB(name, STORE_VERSION);
    try { await db.put('items', { ...item, kind: 'legacy-unknown' }); } finally { db.close(); }
    const requested = await store.requestCheck(item.id, 6000);
    const after = await store.snapshot();
    expect(after.cards!.find(card => card.id === requested.cardId)).toMatchObject({
      askedDirectly: true, noCheckable: true, questionStatus: 'ready' });
    expect(after.jobs.filter(job => job.requested)).toHaveLength(0);
  } finally { store.close(); }
});
it.each(['on_device', 'in_cloud'] as const)('uses question.v2.1 on a legacy mark in %s mode', async mode => {
  const { store, name } = await setup();
  try {
    await makeMark(store);
    const snapshot = await store.snapshot();
    const mark = snapshot.cards![0];
    await store.putProfile({ id: 'private', type: 'skill', depth: 'new', text: 'PROFILE_SENTINEL',
      topics: ['hosting'], tags: [], updatedAt: 0 });
    const db = await openDB(name, STORE_VERSION);
    try { await db.put('cards', { ...mark, triageVersion: 'v1' }); } finally { db.close(); }
    if (mode === 'in_cloud') await store.setCloudModeConsent(true);
    const item = snapshot.items.find(value => value.lineageId === mark.itemLineageId)!;
    await store.requestCheck(item.id, 6000);
    const job = (await store.snapshot()).jobs.find(value => value.step === 'question');
    expect(job).toMatchObject({ promptVersion: 'question.v2.1', runMode: mode });
    const adapter = vi.fn<CloudProcessingAdapter>().mockResolvedValue({ source: 'in_cloud',
      text: JSON.stringify({ question: 'What are the hosting limits?', keptOut: [] }) });
    const cloud = new CloudProcessingService(store, adapter, () => true, () => 'model', () => {});
    const localRun = vi.fn().mockResolvedValue({ source: 'on_device', latencyMs: 1,
      data: { question: 'What are the hosting limits?', keptOut: [] }, raw: '{}' });
    const service = mode === 'in_cloud'
      ? { state: { kind: 'ready' }, subscribe: cloud.subscribe, runLocal: cloud.runLocal.bind(cloud) }
      : { state: { kind: 'ready' }, subscribe: () => () => {}, runLocal: localRun } as LocalService;
    const scheduler = new Scheduler(store, service, () => 'extract.v2', () => {}, () => 6000);
    try { await scheduler.start(); } finally { scheduler.stop(); }
    if (mode === 'in_cloud') {
      expect(adapter).toHaveBeenCalledOnce();
      expect(adapter.mock.calls[0][0].instructions).toBe(questionV21);
      expect(JSON.stringify(adapter.mock.calls)).not.toContain('PROFILE_SENTINEL');
    } else {
      expect(localRun.mock.calls[0][0].instructions).toBe(questionV21);
      expect(adapter).not.toHaveBeenCalled();
    }
    const card = (await store.snapshot()).cards!.find(value => value.id === mark.id)!;
    expect(card).toMatchObject({ triageVersion: 'v1', questionPromptVersion: 'question.v2.1' });
    const result = await store.approveDraft(card.id, card.draftQuestion!);
    expect((await store.snapshot()).outbox!.find(value => value.id === result.entryId))
      .toMatchObject({ triageVersion: 'v1', questionPromptVersion: 'question.v2.1' });
  } finally { store.close(); }
});
it('rechecks a legacy decision-alternatives mark without relitigating the decision', async () => {
  const { store, name } = await setup();
  try {
    await makeMark(store);
    const snapshot = await store.snapshot();
    const decision = snapshot.items.find(item => item.kind === 'decision')!;
    const head = snapshot.lineages!.find(value => value.lineageId === decision.lineageId)!;
    const mark = snapshot.cards![0];
    const db = await openDB(name, STORE_VERSION);
    try {
      await db.put('cards', { ...mark, itemLineageId: head.lineageId, itemVersion: head.version,
        itemKind: 'decision', itemText: decision.text, itemQuote: decision.quote, triageVersion: 'v1',
        angle: 'alternatives', sourceAngle: 'alternatives', concern: 'Is there a better alternative?' });
    } finally { db.close(); }
    await store.requestCheck(decision.id, 6000);
    const job = await store.claim(6000);
    expect(job!.job).toMatchObject({ step: 'angles', promptVersion: 'angles.v2.1', requested: true });
    const input = await store.anglesInput(job!.job);
    await store.completeAngles(job!.job, input!, [{ item: 1, angle: 'alternatives',
      concern: 'Is there a different service worth choosing?', checkable: true }], 's', 7000, 'on_device');
    const after = await store.snapshot();
    expect(after.jobs.filter(value => value.step === 'question')).toHaveLength(0);
    expect(after.cards!.find(value => value.id === mark.id)).toMatchObject({
      triageVersion: 'v1', concern: 'Is there a better alternative?', supersededMark: true });
    expect(after.cards!.find(value => value.askedDirectly)).toMatchObject({ noCheckable: true });
  } finally { store.close(); }
});
it.each(['missing concern', 'unsupported angle'])('falls back to one v2.1 angles job for %s', async issue => {
  const { store, name } = await setup();
  try {
    await makeMark(store);
    const snapshot = await store.snapshot();
    const mark = snapshot.cards![0];
    const db = await openDB(name, STORE_VERSION);
    try {
      await db.put('cards', { ...mark, triageVersion: 'v2',
        ...(issue === 'missing concern' ? { concern: '' } : { sourceAngle: 'legacy-unknown' }) });
    } finally { db.close(); }
    const item = snapshot.items.find(value => value.lineageId === mark.itemLineageId)!;
    await store.requestCheck(item.id, 6000);
    const requested = (await store.snapshot()).jobs.filter(job => job.requested);
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatchObject({ step: 'angles', promptVersion: 'angles.v2.1', lineageId: item.lineageId });
  } finally { store.close(); }
});
