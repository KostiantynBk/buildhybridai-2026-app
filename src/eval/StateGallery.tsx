import { IdeaPanel } from '../ui/IdeaPanel';
import { NotebookPanel } from '../ui/NotebookPanel';
import { Notices } from '../ui/Notices';
import { StorageNotice } from '../ui/App';
import type { IdeaRecord, Snapshot, StoredItem, StoredJob } from '../store';
import type { OutboxEntry, ThoughtCard } from '../store/triageTypes';

const paragraph = { id: 'fake-p', projectId: 'default', order: 0, version: 1, updatedAt: 1,
  text: 'FAKE sample plan: visitors browse a small imaginary catalogue with fictional prices and delivery options.' };
const items: StoredItem[] = ['assumption', 'decision', 'constraint', 'open-question'].map((kind, index) => ({
  id: `fake-i${index}`, paragraphId: paragraph.id, paragraphVersion: 1, kind, text: `FAKE statement ${index + 1}`,
  quote: 'imaginary catalogue', topics: [], status: 'current', promptVersion: 'extract.v2', createdAt: 1,
  lineageId: `fake-l${index}`,
}));
const extract: StoredJob = { key: 'fake-extract', paragraphId: paragraph.id, paragraphVersion: 1, step: 'extract',
  promptVersion: 'extract.v2', status: 'done', attempts: 1, createdAt: 1, nextRunAt: 1 };
const snapshot: Snapshot = { paragraphs: [paragraph], items, profile: [], jobs: [extract],
  lineages: items.map(item => ({
  lineageId: item.lineageId!, version: 1, itemId: item.id, paragraphId: paragraph.id, paragraphVersion: 1,
  status: 'current',
})) };
const card: ThoughtCard = { id: 'fake-card', paragraphId: paragraph.id, paragraphVersion: 1, itemLineageId: 'fake-l0',
  itemVersion: 1, itemText: 'FAKE statement 1', itemQuote: 'imaginary catalogue', topics: [], score: 0, lessonId: null,
  brief: true, sessionId: 'fake', questionStatus: 'ready', draftQuestion: 'FAKE public question?', createdAt: 1,
  angle: 'end-user', sourceAngle: 'end-user' };
const entry: OutboxEntry = { id: 'fake-entry', cardId: card.id, itemLineageId: 'fake-l0', itemVersion: 1,
  question: 'FAKE public question?', keptOut: [], status: 'approved', createdAt: 1 };
const idea: IdeaRecord = { id: 'fake-idea', status: 'ready', draft: 'FAKE public idea description.', keptOut: [],
  statements: items.slice(0, 3).map(item => item.text),
  basis: items.slice(0, 3).map(item => ({ lineageId: item.lineageId!, version: 1 })),
  mode: 'on_device', describePromptVersion: 'describe.v1', researchPromptVersion: 'research.idea.v1',
  describeJobKey: 'fake-job', createdAt: 1, updatedAt: 1 };
const actions = { start: async () => {}, send: async () => {}, retry: async () => {}, decline: async () => {} };
const fakeResult = { result: { text: 'FAKE placeholder research text.', parts: ['FAKE placeholder research text.'],
  sources: [], supports: [], suggestions: '', grounded: false }, sentAt: 1, latencyMs: 1, attempts: 1,
  changedAfterSend: false };
type CheckCase = 'marked' | 'blocked' | 'waiting' | 'ready' | 'declined' | 'no-checkable' | 'private-held' |
  'pending' | 'withdrawn' | 'rejected' | 'sent' | 'checking' | 'searching' | 'failed' | 'completed-no-result' |
  'result' | 'confirmed' | 'uncertain';
const checkCases: CheckCase[] = ['marked', 'blocked', 'waiting', 'ready', 'declined', 'no-checkable', 'private-held',
  'pending', 'withdrawn', 'rejected', 'sent', 'checking', 'searching', 'failed', 'completed-no-result', 'result',
  'confirmed',
  'uncertain'];
function checkSnapshot(state: CheckCase): Snapshot {
  const selected: ThoughtCard = { ...card, questionStatus: state === 'marked' ? 'marked' :
    state === 'blocked' || state === 'private-held' ? 'blocked' : state === 'waiting' ? 'waiting' :
      state === 'declined' ? 'declined' : 'ready',
    ...(state === 'private-held' ? { questionReason: 'private detail' as const } : {}),
    ...(state === 'no-checkable' ? { noCheckable: true } : {}),
    ...(['pending', 'withdrawn', 'rejected', 'sent', 'checking', 'searching', 'failed', 'completed-no-result', 'result',
      'confirmed', 'uncertain'].includes(state)
      ? { outboxId: entry.id } : {}) };
  const hasEntry = !!selected.outboxId;
  const changed = state === 'confirmed' || state === 'uncertain';
  return { ...snapshot, cards: [selected], outbox: hasEntry ? [{ ...entry,
    status: state === 'rejected' ? 'rejected' : state === 'withdrawn' ? 'withdrawn' :
      state === 'pending' ? 'pending' : 'approved' }] : [],
    dependencies: changed ? [{ consumerId: card.id, lineageId: 'fake-l0', version: 1 }] : [],
    lineages: changed ? [...snapshot.lineages!, { ...snapshot.lineages![0], version: 2, status: 'changed',
      needsConfirmation: state === 'uncertain' }] : snapshot.lineages,
    researchReceipts: state === 'failed' ? [{ entryId: entry.id, sentAt: 1, status: 'failed', failureCode: 'unknown' }]
      : state === 'sent' ? [{ entryId: entry.id, sentAt: 1, status: 'sent' }]
        : ['completed-no-result', 'result', 'confirmed', 'uncertain'].includes(state)
        ? [{ entryId: entry.id, sentAt: 1, status: 'completed' }] : [] };
}
export function StateGallery() {
  return <main><h1>DEV state gallery · invented fixtures only</h1>
    {(['unsupported', 'unavailable', 'downloadable', 'ready'] as const).map(kind => <section key={kind}>
      <h2>Notice: {kind}</h2><Notices configured state={{ kind }} cloudEnabled chooseCloud={() => {}} /></section>)}
    <section><h2>Notice: downloading</h2><Notices configured state={{ kind: 'downloading', progress: 0.4 }}
      cloudEnabled chooseCloud={() => {}} /></section>
    <section><h2>Notice: unconfigured</h2><Notices configured={false} state={{ kind: 'unsupported' }} /></section>
    <section><h2>Notice: cloud disabled</h2><Notices configured state={{ kind: 'unsupported' }}
      cloudEnabled={false} chooseCloud={() => {}} /></section>
    <section><h2>Notice: storage error</h2><StorageNotice notice="FAKE storage error for design review." /></section>
    {checkCases.map(state => <section key={state}><h2>Check: {state}</h2><NotebookPanel text={paragraph.text}
      save={() => {}} snapshot={checkSnapshot(state)} storageStatus="saved" configured ready cardOnly controlsDisabled
      sendDraft={async () => {}} declineDraft={async () => {}} reopenDraft={async () => {}}
      searching={{ [entry.id]: state === 'searching' }} checkingSend={{ [entry.id]: state === 'checking' }}
      researchAgain={async () => {}}
      checkThis={async () => {}} research={['result', 'confirmed', 'uncertain'].includes(state)
        ? { [entry.id]: fakeResult } : {}} /></section>)}
    {(['pending', 'running', 'done', 'failed', 'superseded'] as const).map(status => <section key={status}>
      <h2>Idea draft: {status}</h2><IdeaPanel idea={idea} busy snapshot={{ ...snapshot, jobs: [...snapshot.jobs, {
        key: 'fake-job', paragraphId: paragraph.id, paragraphVersion: 1, step: 'describe',
        promptVersion: 'describe.v1', status, attempts: 1, createdAt: 1, nextRunAt: 1,
        ...(status === 'superseded' ? { errorName: 'ModeChanged' } : {}) }] }} {...actions} /></section>)}
    {(['approved', 'declined', 'sent', 'failed', 'withdrawn', 'completed-no-result', 'searching',
      'confirmed', 'uncertain'] as const).map(status => {
      const changed = status === 'confirmed' || status === 'uncertain';
      const outbox: OutboxEntry = { ...entry, kind: 'idea', ideaId: idea.id,
        status: status === 'withdrawn' ? 'withdrawn' : 'approved' };
      const data: Snapshot = { ...snapshot, outbox: [outbox], lineages: changed ? [...snapshot.lineages!,
        { ...snapshot.lineages![0], version: 2, status: 'changed', needsConfirmation: status === 'uncertain' }]
        : snapshot.lineages, researchReceipts: status === 'failed'
        ? [{ entryId: entry.id, sentAt: 1, status: 'failed', failureCode: 'unknown' }]
        : status === 'completed-no-result' ? [{ entryId: entry.id, sentAt: 1, status: 'completed' }] : [] };
      return <section key={status}><h2>Idea outcome: {status}</h2><IdeaPanel busy idea={{ ...idea,
        status: status === 'declined' ? 'declined' : status === 'withdrawn' ? 'withdrawn' : 'approved',
        outboxId: entry.id }} snapshot={data} searching={status === 'searching'}
        view={status === 'sent' || changed ? fakeResult : undefined} {...actions} /></section>;
    })}
  </main>;
}
export default StateGallery;
