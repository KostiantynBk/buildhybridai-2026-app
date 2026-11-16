import { normalizeQuote } from './extract';
import type { ProfileRecord } from '../store';
import { TRIAGE_PROMPT_SET, type TriageVersion } from './triageVersion';

export type Angle = 'end-user' | 'cost-at-scale' | 'limits-operations' | 'security-privacy' | 'alternatives';
export type DisplayAngle = Angle | 'track-record';
export interface SelectionItem { lineageId: string; version: number; kind: string; quote: string; topics: string[] }
export interface Concern { item: number; angle: Angle; concern: string; checkable: boolean }
export interface Pair { lineageId: string; version: number; angle: DisplayAngle; sourceAngle?: Angle }
export interface PriorLiveCard { quote: string; angle: DisplayAngle; sourceAngle: Angle }
export interface Pick { item: SelectionItem; concern: Concern; angle: DisplayAngle; score: number;
  lessonId: string | null; modelOrder: number; brief: boolean; profileRecordIds?: string[] }
export type HeldReason = 'invalid-item' | 'unverified-quote' | 'only-you' | 'repeat' | 'over-limit' |
  'held back: decision respected' | 'held back: incomplete';
export interface Held { concern: Concern; modelOrder: number; reason: HeldReason }

const levels = { new: 2, some: 1, deep: 0 } as const;
export function unfamiliarityDetail(topics: readonly string[], profile: readonly ProfileRecord[]):
  { score: number; skillId: string | null } {
  if (!topics.length) return { score: 1, skillId: null };
  const perTopic = topics.map(topic => {
    const skills = profile.filter(record => record.type === 'skill' && record.topics.includes(topic))
      .sort((a, b) => (a.depth ? levels[a.depth] : 1) - (b.depth ? levels[b.depth] : 1) || a.id.localeCompare(b.id));
    const skill = skills[0];
    return { score: skill?.depth ? levels[skill.depth] : 1, skill };
  });
  const score = Math.max(...perTopic.map(value => value.score));
  const skill = perTopic.filter(value => value.score === score && value.skill &&
    (value.skill.depth === 'new' || value.skill.depth === 'some'))
    .map(value => value.skill!).sort((a, b) => a.id.localeCompare(b.id))[0];
  return { score, skillId: skill?.id ?? null };
}
export function unfamiliarity(topics: readonly string[], profile: readonly ProfileRecord[]): number {
  return unfamiliarityDetail(topics, profile).score;
}
function hasPair(pairs: readonly Pair[], item: SelectionItem, angle: DisplayAngle, sourceAngle: Angle): boolean {
  return pairs.some(pair => pair.lineageId === item.lineageId && pair.version === item.version &&
    (pair.angle === angle || pair.angle === sourceAngle || pair.sourceAngle === sourceAngle));
}
export function selectConcerns(options: {
  paragraph: string; items: readonly SelectionItem[]; concerns: readonly Concern[]; profile: readonly ProfileRecord[];
  used: readonly Pair[]; angleCounts: Partial<Record<DisplayAngle, number>>; alreadyShown?: number;
  priorLiveCards?: readonly PriorLiveCard[]; version?: TriageVersion;
}): { picked: Pick[]; held: Held[] } {
  const held: Held[] = [];
  const candidates: Pick[] = [];
  const body = normalizeQuote(options.paragraph);
  options.concerns.forEach((concern, modelOrder) => {
    const item = Number.isInteger(concern.item) && concern.item > 0 ? options.items[concern.item - 1] : undefined;
    const version = options.version ?? TRIAGE_PROMPT_SET;
    const kinds = version !== 'v1' ? ['assumption', 'decision', 'constraint', 'open-question']
      : ['assumption', 'decision', 'constraint'];
    if (!item || !kinds.includes(item.kind)) {
      held.push({ concern, modelOrder, reason: 'invalid-item' }); return;
    }
    const quote = normalizeQuote(item.quote);
    if (!quote || !body.includes(quote)) { held.push({ concern, modelOrder, reason: 'unverified-quote' }); return; }
    if (version === 'v2.1' && concern.concern.trim().length < 20) {
      held.push({ concern, modelOrder, reason: 'held back: incomplete' }); return;
    }
    if (version !== 'v1' && item.kind === 'decision' && concern.angle === 'alternatives') {
      held.push({ concern, modelOrder, reason: 'held back: decision respected' }); return;
    }
    if (!concern.checkable) { held.push({ concern, modelOrder, reason: 'only-you' }); return; }
    const shared = (record: ProfileRecord) => new Set(record.topics.filter(topic => item.topics.includes(topic))).size;
    const lesson = options.profile.filter(record => record.type === 'lesson' && shared(record) > 0)
      .sort((a, b) => shared(b) - shared(a) || a.id.localeCompare(b.id))[0];
    const angle = lesson ? 'track-record' : concern.angle;
    const duplicate = options.priorLiveCards?.some(card => {
      const priorQuote = normalizeQuote(card.quote);
      return priorQuote && (quote.includes(priorQuote) || priorQuote.includes(quote)) &&
        (card.sourceAngle === concern.angle || card.angle === angle);
    });
    if (duplicate || hasPair(options.used, item, angle, concern.angle)) {
      held.push({ concern, modelOrder, reason: 'repeat' }); return;
    }
    const detail = unfamiliarityDetail(item.topics, options.profile);
    const score = detail.score + (lesson ? 1 : 0);
    const preference = options.profile.filter(record => record.type === 'preference' && shared(record) > 0)
      .sort((a, b) => shared(b) - shared(a) || a.id.localeCompare(b.id))[0];
    const selectedRecords = [lesson?.id, detail.skillId].filter((id): id is string => Boolean(id));
    if (!selectedRecords.length && preference) selectedRecords.push(preference.id);
    candidates.push({ item, concern, angle, score, lessonId: lesson?.id ?? null, modelOrder, brief: score === 0,
      ...(version === 'v2.1' ? { profileRecordIds: score === 0 ? [] : selectedRecords } : {}) });
  });
  const picked: Pick[] = [];
  const counts = { ...options.angleCounts };
  const pairs = [...options.used];
  const cap = Math.max(0, 2 - Math.max(0, options.alreadyShown ?? 0));
  while (candidates.length) {
    candidates.sort((a, b) => b.score - a.score || (counts[a.angle] ?? 0) - (counts[b.angle] ?? 0) ||
      a.modelOrder - b.modelOrder);
    const candidate = candidates.shift()!;
    if (hasPair(pairs, candidate.item, candidate.angle, candidate.concern.angle)) {
      held.push({ concern: candidate.concern, modelOrder: candidate.modelOrder, reason: 'repeat' }); continue;
    }
    if (picked.length >= cap) {
      held.push({ concern: candidate.concern, modelOrder: candidate.modelOrder, reason: 'over-limit' }); continue;
    }
    picked.push(candidate);
    pairs.push({ lineageId: candidate.item.lineageId, version: candidate.item.version, angle: candidate.angle,
      sourceAngle: candidate.concern.angle });
    counts[candidate.angle] = (counts[candidate.angle] ?? 0) + 1;
  }
  return { picked, held: held.sort((a, b) => a.modelOrder - b.modelOrder) };
}
