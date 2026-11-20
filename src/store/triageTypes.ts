import type { Angle, DisplayAngle } from '../pipeline/selectConcerns';
import type { RecordFingerprint } from './fingerprint';
import type { TriageVersion } from '../pipeline/triageVersion';

export type Feedback = 'useful' | 'already knew' | 'not relevant' | 'wrong';
export interface ThoughtCard {
  id: string; paragraphId: string; paragraphVersion: number; itemLineageId: string; itemVersion: number;
  itemText: string; itemQuote: string; itemKind?: string; triageVersion?: TriageVersion;
  profileRecordIds?: string[];
  topics: string[]; angle?: DisplayAngle; sourceAngle?: Angle;
  concern?: string; score: number; lessonId: string | null; brief: boolean; sessionId: string;
  questionStatus: 'marked' | 'waiting' | 'blocked' | 'ready' | 'declined';
  askedDirectly?: boolean; noCheckable?: boolean; draftQuestion?: string; draftKeptOut?: string[];
  questionPromptVersion?: string; markAngleJobKey?: string; supersededMark?: boolean;
  questionReason?: 'private detail' | 'local-step-failed' | 'stale' | 'revalidation-failed';
  recheckFailedVersion?: number;
  why?: { seeing: string; why: string; used: string[] } | null;
  whyFingerprints?: RecordFingerprint[]; whyRefreshCount?: number;
  outboxId?: string; feedback?: Feedback; createdAt: number;
}
export interface OutboxEntry {
  id: string; question: string; keptOut: string[]; cardId?: string; itemLineageId?: string; itemVersion?: number;
  kind?: 'question' | 'idea'; ideaId?: string; basis?: Array<{ lineageId: string; version: number }>;
  openingBasis?: { id: string; version: number; order: number };
  describePromptVersion?: string; researchPromptVersion?: string;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn'; createdAt: number; decidedAt?: number;
  withdrawReason?: 'listed-term' | 'stale' | 'private-detail'; edited?: boolean;
  triageVersion?: TriageVersion; questionPromptVersion?: string; questionOrigin?: 'manual' | 'model';
}
export interface FunnelEvent {
  id: string; paragraphId: string; paragraphVersion: number; event: 'considered' | 'held' | 'picked' |
    'question' | 'outbox' | 'feedback' | 'why'; at: number; reason?: string; score?: number; angle?: DisplayAngle;
  sourceAngle?: Angle; lessonId?: string; cardId?: string; concern?: string; itemLineageId?: string;
  itemVersion?: number; modelOrder?: number; itemIndex?: number; checkable?: boolean;
  promptVersions?: { angles: string; question: string | null; whynote: string | null };
}
