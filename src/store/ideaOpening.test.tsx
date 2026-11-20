import 'fake-indexeddb/auto';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { researchIdea, UngroundedIdeaError } from '../ai/researchFlow';
import { stubSafeSuggestionParser } from '../ai/testSuggestionParser';
import { openDB } from 'idb';
import { openLocalStore } from './index';
import { sentenceBoundedOpening } from './ideaBasis';
import { IdeaPanel } from '../ui/IdeaPanel';
import { OutboxPage } from '../ui/OutboxPage';

const opening = 'Restaurants lose money when guests do not show.';
const later = 'The booking page accepts deposits and sends a reminder to each guest before their reservation.';
const statements = [
  { kind: 'decision', text: 'Send a reminder', quote: 'sends a reminder', topics: [] },
  { kind: 'assumption', text: 'Guests may not attend', quote: 'each guest', topics: [] },
  { kind: 'constraint', text: 'Accept deposits', quote: 'accepts deposits', topics: [] },
];
afterEach(() => vi.unstubAllGlobals());
async function setup() {
  const store = await openLocalStore(`opening-${crypto.randomUUID()}`);
  await store.saveNotebook(`${opening}\n\n${later}`, 0);
  await store.enqueueSettled(4000, 'extract.v2');
  const job = await store.claim(4000);
  await store.complete(job!.job, statements, 4000, 'on_device');
  await store.finalizeReady();
  return store;
}
it('truncates long openings at the last sentence boundary within 120 words', () => {
  const text = `${Array(70).fill('one').join(' ')}. ${Array(70).fill('two').join(' ')}.`;
  const result = sentenceBoundedOpening(text);
  expect(result.split(/\s+/)).toHaveLength(70);
  expect(result.endsWith('.')).toBe(true);
  expect(sentenceBoundedOpening(Array(121).fill('word').join(' '))).toBe('');
});
it('ignores titles, initials and abbreviations when finding complete sentence boundaries', () => {
  for (const abbreviation of ['Dr.', 'Mr.', 'Mrs.', 'Ms.', 'St.', 'e.g.', 'i.e.', 'A.']) {
    const incomplete = `${Array(59).fill('word').join(' ')} ${abbreviation} ${Array(65).fill('word').join(' ')}.`;
    expect(sentenceBoundedOpening(incomplete)).toBe('');
  }
  expect(sentenceBoundedOpening('Dr. Rivera helps. An unfinished fragment')).toBe('Dr. Rivera helps.');
  expect(sentenceBoundedOpening('A. Person said “Ready!” Another fragment')).toBe('A. Person said “Ready!”');
});
it('does not cut at bracketed initials, ellipses or No. in a long sentence', () => {
  for (const phrase of ['[J. Lee]', '(J. Lee)', '“J. Lee”', 'catalogue... and', 'catalogue… and',
    'intake form No. 7']) {
    const longSentence = `The team expects ${phrase} ${Array(145).fill('word').join(' ')}.`;
    expect(sentenceBoundedOpening(longSentence)).toBe('');
    expect(sentenceBoundedOpening(`An earlier sentence. ${longSentence}`)).toBe('An earlier sentence.');
  }
});
it('captures an opening with no extracted lineage and sorts the remaining evidence', async () => {
  const store = await setup();
  try {
    const snapshot = await store.snapshot();
    const first = snapshot.paragraphs.find(p => p.order === 0)!;
    expect(snapshot.items.some(item => item.paragraphId === first.id)).toBe(false);
    const idea = (await store.startIdea(5000)).idea!;
    expect(idea.openingBasis).toEqual({ id: first.id, version: first.version, order: 0 });
    expect(idea).not.toHaveProperty('openingText');
    expect(idea.describePromptVersion).toBe('describe.v2');
    expect(idea.statements).toEqual(['Guests may not attend', 'Send a reminder', 'Accept deposits']);
    const job = (await store.claim(5000))!.job;
    expect(job.promptVersion).toBe('describe.v2');
    expect((await store.ideaForJob(job))?.openingText).toBe(opening);
  } finally { store.close(); }
});
it.each(['edited', 'removed', 'reordered'] as const)('rejects a %s opening on restart', async change => {
  const store = await setup();
  try {
    const idea = (await store.startIdea(5000)).idea!;
    const job = (await store.claim(5000))!.job;
    const description = 'A booking page helps restaurants reduce missed reservations by collecting deposits.';
    await store.finishIdeaDraft(job, description, [], 5000);
    const approved = await store.approveIdea(idea.id, description, 5000);
    expect(approved.entryId).toBeDefined();
    expect((await store.snapshot()).outbox![0].openingBasis).toEqual(idea.openingBasis);
    await store.setCloudConsent(true);
    const changed = change === 'edited' ? `${opening} Another change.\n\n${later}` :
      change === 'removed' ? later : `${later}\n\n${opening}`;
    await store.saveNotebook(changed, 6000);
    const before = await store.snapshot();
    const html = renderToStaticMarkup(<IdeaPanel snapshot={before} idea={before.ideas![0]} start={async () => {}}
      send={async () => {}} retry={async () => {}} decline={async () => {}} />);
    expect(html).toContain('Research again');
    await store.resume();
    const resumed = await store.snapshot();
    expect(resumed.outbox![0]).toMatchObject({ status: 'withdrawn', withdrawReason: 'stale' });
    expect((await store.preSendIdeaCheck(idea.id)).allowed).toBe(false);
  } finally { store.close(); }
});
it('resumes a legacy v1 idea without requiring an opening snapshot', async () => {
  const name = `legacy-opening-${crypto.randomUUID()}`;
  const store = await openLocalStore(name);
  try {
    await store.saveNotebook(`${opening}\n\n${later}`, 0);
    await store.enqueueSettled(4000, 'extract.v2');
    const extraction = await store.claim(4000);
    await store.complete(extraction!.job, statements, 4000, 'on_device');
    await store.finalizeReady();
    const idea = (await store.startIdea(5000)).idea!;
    const raw = await openDB(name, 7);
    const legacy = await raw.get('ideas', idea.id);
    delete legacy.openingBasis;
    legacy.describePromptVersion = 'describe.v1';
    await raw.put('ideas', legacy);
    const job = await raw.get('jobs', idea.describeJobKey);
    job.promptVersion = 'describe.v1';
    await raw.put('jobs', job);
    raw.close();
    await store.resume();
    const claimed = (await store.claim(5000))!.job;
    expect((await store.ideaForJob(claimed))?.describePromptVersion).toBe('describe.v1');
    const description = 'A booking page helps restaurants reduce missed reservations by collecting deposits.';
    expect(await store.finishIdeaDraft(claimed, description, [], 5000)).toBe(true);
    const entryId = (await store.approveIdea(idea.id, description, 5000)).entryId!;
    await store.setCloudConsent(true);
    stubSafeSuggestionParser();
    const adapter = vi.fn().mockResolvedValue({ source: 'in_cloud', result: {
      text: 'FAKE legacy result', parts: ['FAKE legacy result'], sources: [], supports: [], grounded: true,
      suggestions: '<a href="https://google.com/search?q=test">Search</a>',
    } });
    const view = await researchIdea(store, adapter, idea.id, 'model', { budget: 10 });
    await store.finishIdeaResearch(idea.id, 'sent');
    const before = await store.snapshot();
    await store.deleteOutbox(entryId);
    const after = await store.snapshot();
    expect(after.paragraphs).toEqual(before.paragraphs);
    expect(after.lineages).toEqual(before.lineages);
    const html = renderToStaticMarkup(<IdeaPanel snapshot={after} idea={after.ideas![0]} view={view}
      start={async () => {}} send={async () => {}} retry={async () => {}} decline={async () => {}} />);
    expect(html).toContain('FAKE legacy result');
    expect(html).not.toContain('Your plan changed since this was checked.');
    expect((await store.preSendIdeaCheck(idea.id)).allowed).toBe(false);
    expect(adapter).toHaveBeenCalledOnce();
  } finally { store.close(); }
});
it('does not strand a parked draft when its opening is reordered', async () => {
  const store = await setup();
  try {
    const idea = (await store.startIdea(5000)).idea!;
    await store.saveNotebook(`${later}\n\n${opening}`, 6000);
    const snapshot = await store.snapshot();
    const html = renderToStaticMarkup(<IdeaPanel snapshot={snapshot} idea={idea} start={async () => {}}
      send={async () => {}} retry={async () => {}} decline={async () => {}} />);
    expect(html).not.toContain('Drafting a description');
    expect(html).toContain('Your plan changed since this was checked.');
    expect(html).toMatch(/<button class="primary">Research again<\/button>/);
    const next = await store.startIdea(7000);
    expect(next.created).toBe(true);
  } finally { store.close(); }
});
it.each([false, true])('rechecks the opening after a held response (grounded=%s)', async grounded => {
  if (grounded) stubSafeSuggestionParser();
  const store = await setup();
  try {
    const idea = (await store.startIdea(5000)).idea!;
    const job = (await store.claim(5000))!.job;
    const description = 'A booking page helps restaurants reduce missed reservations by collecting deposits.';
    await store.finishIdeaDraft(job, description, [], 5000);
    await store.approveIdea(idea.id, description, 5000);
    await store.setCloudConsent(true);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const adapter = vi.fn(async () => { await gate; return { source: 'in_cloud', result: {
      text: 'FAKE_RESULT', parts: ['FAKE_RESULT'], sources: [], supports: [], grounded,
      suggestions: grounded ? '<a href="https://google.com/search?q=test">Search</a>' : '',
    } }; });
    const pending = researchIdea(store, adapter, idea.id, 'model', { budget: 10 });
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledOnce());
    await store.saveNotebook(`${later}\n\n${opening}`, 6000);
    release();
    if (grounded) expect((await pending).changedAfterSend).toBe(true);
    else await expect(pending).rejects.toBeInstanceOf(UngroundedIdeaError);
    const state = await store.snapshot();
    expect(state.outbox![0]).toMatchObject({ status: 'withdrawn', withdrawReason: 'stale' });
    expect(state.researchReceipts![0]).toMatchObject(grounded ? { status: 'completed' } :
      { status: 'completed', failureCode: 'ungrounded' });
    expect(JSON.stringify(state)).not.toContain('FAKE_RESULT');
    const outbox = renderToStaticMarkup(<OutboxPage entries={state.outbox!} snapshot={state}
      decide={async () => false} remove={async () => {}} />);
    expect(outbox).toContain('Withdrawn:');
    expect(outbox).toContain(grounded ? 'Research completed.' : 'Sent; no web sources were provided.');
  } finally { store.close(); }
});
it('rejects a changed opening at pre-send without requiring restart', async () => {
  const store = await setup();
  try {
    const idea = (await store.startIdea(5000)).idea!;
    const job = (await store.claim(5000))!.job;
    const description = 'A booking page helps restaurants reduce missed reservations by collecting deposits.';
    await store.finishIdeaDraft(job, description, [], 5000);
    await store.approveIdea(idea.id, description, 5000);
    await store.setCloudConsent(true);
    await store.saveNotebook(`${opening} Another change.\n\n${later}`, 6000);
    expect(await store.preSendIdeaCheck(idea.id)).toEqual({ allowed: false, reason: 'stale' });
    expect((await store.snapshot()).outbox![0]).toMatchObject({ status: 'withdrawn', withdrawReason: 'stale' });
  } finally { store.close(); }
});
it('rejects an opening changed before approval and still enforces Never send on the final text', async () => {
  const store = await setup();
  try {
    const idea = (await store.startIdea(5000)).idea!;
    const job = (await store.claim(5000))!.job;
    const description = 'A booking page helps restaurants reduce missed reservations by collecting deposits.';
    await store.finishIdeaDraft(job, description, [], 5000);
    await store.putNeverSend(['PrivateName']);
    expect((await store.approveIdea(idea.id, 'A booking page for PrivateName and their restaurant')).reason)
      .toContain('never-send');
    await store.saveNotebook(`${opening} Another change.\n\n${later}`, 6000);
    expect((await store.approveIdea(idea.id, description)).reason).toContain('plan changed');
    expect((await store.snapshot()).outbox).toHaveLength(0);
  } finally { store.close(); }
});
