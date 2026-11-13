import type { Dependency, LineageVersion } from './index';
export type StaleReason = { lineageId: string; was: number; now: number;
  kind: 'changed' | 'removed' | 'needsConfirmation' };
export function calculateStaleness(
  consumerId: string, dependencies: Dependency[], versions: LineageVersion[],
): { stale: boolean; reasons: StaleReason[] } {
  const reasons: StaleReason[] = [];
  for (const dependency of dependencies.filter(entry => entry.consumerId === consumerId)) {
    const newer = versions.filter(version => version.lineageId === dependency.lineageId &&
      version.version > dependency.version).sort((a, b) => a.version - b.version);
    if (!newer.length) continue;
    const latest = newer[newer.length - 1];
    const kind = latest.status === 'removed' ? 'removed' : latest.needsConfirmation
      ? 'needsConfirmation' : 'changed';
    reasons.push({ lineageId: dependency.lineageId, was: dependency.version, now: latest.version, kind });
  }
  return { stale: reasons.length > 0, reasons };
}
