import demos from './demoProfiles.json';
import type { Depth, ProfileRecord, ProfileType } from '../store';
import { validateNeverSend } from '../privacy/terms';

export const TOPICS = ['hosting', 'backend', 'frontend', 'mobile', 'auth', 'payments', 'messaging',
  'data-storage', 'ai-api', 'pricing', 'marketing', 'legal-privacy', 'security', 'performance',
  'support', 'analytics', 'other'] as const;
const types = new Set<ProfileType>(['skill', 'project', 'lesson', 'preference']);
const depths = new Set<Depth>(['new', 'some', 'deep']);
export function validateRecord(value: unknown, now = Date.now()): ProfileRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid profile record.');
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(raw.id) ||
      typeof raw.type !== 'string' || !types.has(raw.type as ProfileType) ||
      typeof raw.text !== 'string' || !raw.text.trim()) throw new Error('Invalid profile record.');
  if (!Array.isArray(raw.topics) || !raw.topics.every(t => typeof t === 'string' &&
      (TOPICS as readonly string[]).includes(t))) throw new Error('Invalid topics.');
  if (!Array.isArray(raw.tags) || !raw.tags.every(t => typeof t === 'string')) throw new Error('Invalid tags.');
  const tags = [...new Set((raw.tags as string[]).map(t => t.trim().toLocaleLowerCase('en')).filter(Boolean))];
  if (tags.length > 5) throw new Error('Use up to five tags.');
  const type = raw.type as ProfileType;
  if (type === 'skill' && (typeof raw.depth !== 'string' || !depths.has(raw.depth as Depth))) {
    throw new Error('Choose a skill depth.');
  }
  if (type !== 'skill' && raw.depth !== undefined) throw new Error('Depth is for skills only.');
  return { id: raw.id, type, text: raw.text.trim(), ...(type === 'skill' ? { depth: raw.depth as Depth } : {}),
    topics: [...new Set(raw.topics as string[])], tags,
    updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : now };
}
export function profileWarnings(records: ProfileRecord[]): string[] {
  const warnings: string[] = [];
  if (records.length > 40) warnings.push('More than 40 records; consider keeping the profile compact.');
  if (records.reduce((sum, record) => sum + record.text.length +
    record.tags.reduce((total, tag) => total + tag.length, 0), 0) > 6000) {
    warnings.push('More than 6,000 characters; consider keeping the profile compact.');
  }
  return warnings;
}
export function importProfileBundle(text: string): { records: ProfileRecord[]; neverSend: string[] } {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error('Invalid profile JSON.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid profile JSON.');
  const data = parsed as Record<string, unknown>;
  if (data.version !== 1 || !Array.isArray(data.records)) throw new Error('Unsupported profile format.');
  const records = data.records.map(record => validateRecord(record));
  if (new Set(records.map(record => record.id)).size !== records.length) throw new Error('Duplicate record IDs.');
  return { records, neverSend: validateNeverSend(data.neverSend ?? []) };
}
export function importProfile(text: string): ProfileRecord[] { return importProfileBundle(text).records; }
export function exportProfile(records: ProfileRecord[], neverSend: string[] = []): string {
  return JSON.stringify({ version: 1, records, neverSend: validateNeverSend(neverSend) }, null, 2);
}
export function demoNeverSend(which: 'A' | 'B'): string[] {
  return validateNeverSend(demos.profiles[which].privateTokens);
}
export function demoProfile(which: 'A' | 'B', now = Date.now()): ProfileRecord[] {
  return demos.profiles[which].records.map(record => {
    const depth = 'depth' in record ? ({ none: 'new', some: 'some', strong: 'deep' } as const)[
      record.depth as 'none' | 'some' | 'strong'] : undefined;
    return validateRecord({ ...record, ...(depth ? { depth } : {}), tags: [], updatedAt: now }, now);
  });
}
