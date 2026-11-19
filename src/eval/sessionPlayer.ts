import sessions from '../../eval/sessions-v1/sessions.json';
import { validateNeverSend } from '../privacy/terms';
import { demoNeverSend, demoProfile } from '../profile/profile';
import type { ProfileRecord, Snapshot } from '../store';
import type { FunnelEvent } from '../store/triageTypes';
import { calculateStaleness } from '../store/staleness';

export interface SessionTerms { before: number; after: number; added: string[]; removed?: boolean;
  profileError?: boolean }
export async function addSessionTerms(current: string[], tokens: string[], confirm: (message: string) => boolean,
  write: (terms: string[]) => Promise<void>, profileWarning = ''): Promise<SessionTerms | null> {
  const before = validateNeverSend(current);
  const union = validateNeverSend([...before, ...tokens]);
  const existing = new Set(before.map(term => term.toLocaleLowerCase('en')));
  const added = union.filter(term => !existing.has(term.toLocaleLowerCase('en')));
  const short = added.some(term => term.length < 4) ? '\nWarning: short terms can match unrelated text.' : '';
  const lines = added.length ? added.map(term => `• ${term}`).join('\n') : '(none)';
  const message = `Add these invented test terms to Never send?\n${lines}\n` +
    'They remain until removed. Matching pending or approved Outbox entries will be withdrawn. ' +
    'Removing terms later does not restore withdrawn entries.' + short + profileWarning;
  if (!confirm(message)) return null;
  await write(union);
  return { before: before.length, after: union.length, added };
}
function sameProfile(left: ProfileRecord[], right: ProfileRecord[]): boolean {
  const canonical = (records: ProfileRecord[]) => records.map(({ id, type, text, depth, topics, tags }) =>
    ({ id, type, text, depth, topics, tags })).sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}
export async function prepareSessionStart(profile: 'A' | 'B' | 'own', records: ProfileRecord[], current: string[],
  tokens: string[], confirm: (message: string) => boolean, writeTerms: (terms: string[]) => Promise<void>,
  writeProfile: (records: ProfileRecord[]) => Promise<void>): Promise<SessionTerms | null> {
  const demo = profile === 'own' ? null : demoProfile(profile);
  const replace = demo !== null && !sameProfile(records, demo);
  const warning = replace && records.length ? '\nThis replaces your current profile: skills, projects and lessons. ' +
    'Cancel and use Profile → Export first if you want a backup.' : '';
  const allTokens = profile === 'own' ? tokens : [...tokens, ...demoNeverSend(profile)];
  const result = await addSessionTerms(current, allTokens, confirm, writeTerms, warning);
  if (result && replace && demo) {
    try { await writeProfile(demo); } catch { result.profileError = true; }
  }
  return result;
}
export async function removeSessionTerms(current: string[], added: string[],
  write: (terms: string[]) => Promise<void>) {
  const remove = new Set(added.map(term => term.toLocaleLowerCase('en')));
  await write(validateNeverSend(current).filter(term => !remove.has(term.toLocaleLowerCase('en'))));
}

export function buildSessionStepLog(step: number, startedAt: number, finishedAt: number, timedOut: boolean,
  baseline: Snapshot, snapshot: Snapshot, baselineEvents: string[], latestEvents: FunnelEvent[]) {
  const changed = snapshot.paragraphs.filter(paragraph => !baseline.paragraphs.some(previous =>
    previous.id === paragraph.id && previous.version === paragraph.version));
  const ids = new Set(changed.map(paragraph => paragraph.id));
  const events = new Set(baselineEvents);
  const cards = (snapshot.cards ?? []).filter(card => ids.has(card.paragraphId));
  const cardIds = new Set(cards.map(card => card.id));
  return { step, startedAt, finishedAt, elapsedMs: finishedAt - startedAt, timedOut,
    paragraphs: changed.map(p => ({ id: p.id, version: p.version })),
    items: snapshot.items.filter(item => ids.has(item.paragraphId)).map(item => ({ kind: item.kind, text: item.text,
      quote: item.quote, topics: item.topics, status: item.status, lineageId: item.lineageId,
      lineageVersion: snapshot.lineages?.find(lineage => lineage.itemId === item.id)?.version })),
    cards: cards.map(card => ({ id: card.id, itemQuote: card.itemQuote, angle: card.angle,
      sourceAngle: card.sourceAngle, concern: card.concern, score: card.score, brief: card.brief,
      why: card.why, profileRecordIds: (card.profileRecordIds ?? [])
        .filter(id => snapshot.profile.some(record => record.id === id)),
      feedback: card.feedback, questionStatus: card.questionStatus, triageVersion: card.triageVersion,
      questionPromptVersion: card.questionPromptVersion, askedDirectly: card.askedDirectly,
      draftQuestion: card.draftQuestion, draftKeptOut: card.draftKeptOut,
      staleness: calculateStaleness(card.id, snapshot.dependencies ?? [], snapshot.lineages ?? []) })),
    outbox: (snapshot.outbox ?? []).filter(entry => cardIds.has(entry.cardId)).map(entry => ({ id: entry.id,
      cardId: entry.cardId, question: entry.question, keptOut: entry.keptOut, status: entry.status,
      withdrawReason: entry.withdrawReason, edited: entry.edited, triageVersion: entry.triageVersion,
      questionPromptVersion: entry.questionPromptVersion, questionOrigin: entry.questionOrigin })),
    funnel: latestEvents.filter(event => !events.has(event.id)),
    jobs: snapshot.jobs.filter(job => ids.has(job.paragraphId)).map(job => ({ step: job.step,
      promptVersion: job.promptVersion, status: job.status, attempts: job.attempts, errorName: job.errorName })) };
}
// Change only in the T10 unlock ticket; there is no runtime or UI override.
export const ALLOW_HELD_BACK = false;
export function sessionForPlay(id: string) {
  if (id !== 'S1' && !ALLOW_HELD_BACK) throw new Error('This session is held back.');
  const session = sessions.sessions.find(value => value.id === id);
  if (!session) throw new Error('Unknown session.');
  return session;
}
export function applySessionEdit(next: { text: string }, save: (text: string) => void): void {
  save(next.text);
}
export function nextSessionEdit(id: string, stepNumber: number, current: string,
  blocks: Readonly<Record<number, string>>): { text: string; blocks: Record<number, string> } {
  const session = sessionForPlay(id);
  const step = session.steps.find(value => value.n === stepNumber);
  if (!step) throw new Error('Unknown session step.');
  const block = `${step.title}\n${step.text}`;
  const next = { ...blocks };
  if (step.action === 'write') {
    next[step.n] = block;
    return { text: current.trim() ? `${current.trimEnd()}\n\n${block}` : block, blocks: next };
  }
  if (step.action === 'edit' && 'replacesStep' in step && typeof step.replacesStep === 'number') {
    const previous = next[step.replacesStep];
    if (!previous || current.indexOf(previous) < 0 || current.indexOf(previous) !== current.lastIndexOf(previous)) {
      throw new Error('The original session paragraph is missing or ambiguous.');
    }
    next[step.replacesStep] = block;
    return { text: current.replace(previous, () => block), blocks: next };
  }
  throw new Error('Unsupported session action.');
}
