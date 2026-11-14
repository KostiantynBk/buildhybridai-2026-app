import type { Angle, DisplayAngle } from '../pipeline/selectConcerns';
import type { RecordFingerprint } from './fingerprint';
import type { TriageVersion } from '../pipeline/triageVersion';

export type Feedback = 'useful' | 'already knew' | 'not relevant' | 'wrong';
export interface ThoughtCard {
  id: string; paragraphId: string; paragraphVersion: number; itemLineageId: string; itemVersion: number;
  itemText: string; itemQuote: string; itemKind?: string; triageVersion?: TriageVersion;
  topics: string[]; angle: DisplayAngle; sourceAngle: Angle;
  concern: string; score: number; lessonId: string | null; brief: boolean; sessionId: string;
  questionStatus: 'waiting' | 'blocked' | 'ready';
  questionReason?: 'private detail' | 'local-step-failed' | 'stale' | 'revalidation-failed';
  recheckFailedVersion?: number;
  why?: { seeing: string; why: string; used: string[] } | null;
  whyFingerprints?: RecordFingerprint[]; whyRefreshCount?: number;
  outboxId?: string; feedback?: Feedback; createdAt: number;
}
export interface OutboxEntry {
  id: string; question: string; keptOut: string[]; cardId: string; itemLineageId: string; itemVersion: number;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn'; createdAt: number; decidedAt?: number;
  withdrawReason?: 'listed-term' | 'stale' | 'private-detail';
}
export interface FunnelEvent {
  id: string; paragraphId: string; paragraphVersion: number; event: 'considered' | 'held' | 'picked' |
    'question' | 'outbox' | 'feedback' | 'why'; at: number; reason?: string; score?: number; angle?: DisplayAngle;
  sourceAngle?: Angle; lessonId?: string; cardId?: string; concern?: string; itemLineageId?: string;
  itemVersion?: number; modelOrder?: number; itemIndex?: number; checkable?: boolean;
  promptVersions?: { angles: string; question: string; whynote: string };
}
