import { normalizeQuote } from './extract';
import type { ProfileRecord } from '../store';

export type Angle = 'end-user' | 'cost-at-scale' | 'limits-operations' | 'security-privacy' | 'alternatives';
export type DisplayAngle = Angle | 'track-record';
export interface SelectionItem { lineageId: string; version: number; kind: string; quote: string; topics: string[] }
export interface Concern { item: number; angle: Angle; concern: string; checkable: boolean }
export interface Pair { lineageId: string; version: number; angle: DisplayAngle; sourceAngle?: Angle }
export interface Pick { item: SelectionItem; concern: Concern; angle: DisplayAngle; score: number;
  lessonId: string | null; modelOrder: number; brief: boolean }
export type HeldReason = 'invalid-item' | 'unverified-quote' | 'only-you' | 'repeat' | 'over-limit';
export interface Held { concern: Concern; modelOrder: number; reason: HeldReason }

const levels = { new: 2, some: 1, deep: 0 } as const;
export function unfamiliarity(topics: readonly string[], profile: readonly ProfileRecord[]): number {
  if (!topics.length) return 1;
  return Math.max(...topics.map(topic => {
    const skills = profile.filter(record => record.type === 'skill' && record.topics.includes(topic));
    if (!skills.length) return 1;
    return Math.min(...skills.map(record => record.depth ? levels[record.depth] : 1));
  }));
}
function hasPair(pairs: readonly Pair[], item: SelectionItem, angle: DisplayAngle, sourceAngle: Angle): boolean {
  return pairs.some(pair => pair.lineageId === item.lineageId && pair.version === item.version &&
    (pair.angle === angle || pair.angle === sourceAngle || pair.sourceAngle === sourceAngle));
}
export function selectConcerns(options: {
  paragraph: string; items: readonly SelectionItem[]; concerns: readonly Concern[]; profile: readonly ProfileRecord[];
  used: readonly Pair[]; angleCounts: Partial<Record<DisplayAngle, number>>; alreadyShown?: number;
}): { picked: Pick[]; held: Held[] } {
  const held: Held[] = [];
  const candidates: Pick[] = [];
  const body = normalizeQuote(options.paragraph);
  options.concerns.forEach((concern, modelOrder) => {
    const item = Number.isInteger(concern.item) && concern.item > 0 ? options.items[concern.item - 1] : undefined;
    if (!item || !['assumption', 'decision', 'constraint'].includes(item.kind)) {
      held.push({ concern, modelOrder, reason: 'invalid-item' }); return;
    }
    const quote = normalizeQuote(item.quote);
    if (!quote || !body.includes(quote)) { held.push({ concern, modelOrder, reason: 'unverified-quote' }); return; }
    if (!concern.checkable) { held.push({ concern, modelOrder, reason: 'only-you' }); return; }
    const shared = (record: ProfileRecord) => new Set(record.topics.filter(topic => item.topics.includes(topic))).size;
    const lesson = options.profile.filter(record => record.type === 'lesson' && shared(record) > 0)
      .sort((a, b) => shared(b) - shared(a) || a.id.localeCompare(b.id))[0];
    const angle = lesson ? 'track-record' : concern.angle;
    if (hasPair(options.used, item, angle, concern.angle)) {
      held.push({ concern, modelOrder, reason: 'repeat' }); return;
    }
    const score = unfamiliarity(item.topics, options.profile) + (lesson ? 1 : 0);
    candidates.push({ item, concern, angle, score, lessonId: lesson?.id ?? null, modelOrder, brief: score === 0 });
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
