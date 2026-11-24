import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { openLocalStore } from './index';

async function readyStore() {
  const store = await openLocalStore(`consent-${crypto.randomUUID()}`);
  const paragraph = 'The hosting plan supports visitors while a payment service handles purchases for people.';
  await store.saveNotebook(paragraph, 0); await store.enqueueSettled(4000, 'extract.v2');
  const extract = await store.claim(4000);
  await store.complete(extract!.job, [
    { kind: 'assumption', text: 'Hosting supports visitors', quote: 'The hosting plan supports visitors', topics: [] },
    { kind: 'decision', text: 'Payment handles purchases', quote: 'a payment service handles purchases', topics: [] },
    { kind: 'constraint', text: 'Purchases are for people', quote: 'purchases for people', topics: [] },
  ], 4000); await store.finalizeReady();
  return store;
}

it('grants question consent only for the exact approved turn after the existing gates pass', async () => {
  const store = await readyStore();
  try {
    const check = await store.requestCheck((await store.snapshot()).items[0].id, 5000);
    const angles = await store.claim(5000);
    await store.completeAngles(angles!.job, (await store.anglesInput(angles!.job))!, [], 's', 5000, 'on_device');
    const text = 'What are hosting limits?';
    const entry = await store.approveDraft(check.cardId!, text);
    expect((await store.preSendCheck(entry.entryId!)).allowed).toBe(true);
    expect(await store.cloudConsent()).toBe(false);
    expect((await store.preSendCheck(entry.entryId!, text + ' ')).allowed).toBe(false);
    expect(await store.cloudConsent()).toBe(false);
    expect((await store.preSendCheck(entry.entryId!, text)).allowed).toBe(true);
    expect(await store.cloudConsent()).toBe(true);
  } finally { store.close(); }
});

it('grants description consent only for the same approved entry and exact turn', async () => {
  const store = await readyStore();
  try {
    const idea = (await store.startIdea(5000)).idea!;
    const text = 'A notebook helps builders understand their product plans.';
    await store.finishIdeaDraft((await store.claim(5000))!.job, text, []);
    const entry = await store.approveIdea(idea.id, text);
    expect(await store.preSendIdeaCheck(idea.id)).toMatchObject({ allowed: false, reason: 'no-consent' });
    expect((await store.preSendIdeaCheck(idea.id, { entryId: 'different', text })).allowed).toBe(false);
    expect((await store.preSendIdeaCheck(idea.id, { entryId: entry.entryId!, text: text + ' ' })).allowed).toBe(false);
    expect(await store.cloudConsent()).toBe(false);
    expect((await store.preSendIdeaCheck(idea.id, { entryId: entry.entryId!, text })).allowed).toBe(true);
    expect(await store.cloudConsent()).toBe(true);
  } finally { store.close(); }
});
