import type { ProfileRecord } from './index';
export interface RecordFingerprint { id: string; hash: string }
export function recordSemantics(record: ProfileRecord): string {
  return JSON.stringify([record.type, record.text, record.depth ?? null, [...record.topics].sort()]);
}
export async function fingerprintRecords(records: readonly ProfileRecord[]): Promise<RecordFingerprint[]> {
  return Promise.all(records.map(async record => {
    const bytes = new TextEncoder().encode(recordSemantics(record));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    return { id: record.id, hash };
  }));
}
export async function fingerprintsMatch(fingerprints: readonly RecordFingerprint[], records: readonly ProfileRecord[]) {
  const selected = fingerprints.map(fingerprint => records.find(record => record.id === fingerprint.id));
  if (selected.some(record => !record)) return false;
  const current = await fingerprintRecords(selected as ProfileRecord[]);
  return fingerprints.every((fingerprint, index) => fingerprint.hash === current[index].hash);
}
