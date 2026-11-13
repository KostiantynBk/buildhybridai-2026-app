import type { LineageVersion, StoredJob } from './index';
import type { Paragraph } from './matcher';
import { lineageHeads } from './lineage';

export type Eligibility = 'eligible' | 'checking' | 'terminal' | 'stale';
export function lineageEligibility(lineageId: string, version: number, paragraphs: readonly Paragraph[],
  versions: readonly LineageVersion[], jobs: readonly StoredJob[]): Eligibility {
  const head = lineageHeads([...versions]).find(value => value.lineageId === lineageId);
  if (!head || head.version !== version || head.status === 'removed' || head.needsConfirmation) return 'stale';
  const paragraph = paragraphs.find(value => value.id === head.paragraphId);
  if (!paragraph) return 'stale';
  const currentJobs = jobs.filter(job => job.paragraphId === paragraph.id &&
    job.paragraphVersion === paragraph.version);
  const extraction = currentJobs.find(job => job.step === 'extract');
  const comparison = currentJobs.find(job => job.step === 'compare' && job.lineageId === lineageId);
  if (extraction?.status === 'failed' || comparison?.status === 'failed' ||
      (head.unchecked && head.paragraphVersion === paragraph.version)) return 'terminal';
  if (head.paragraphVersion !== paragraph.version || extraction?.status !== 'done' ||
      (comparison && (comparison.status === 'pending' || comparison.status === 'running')) || head.unchecked) {
    return 'checking';
  }
  return 'eligible';
}
