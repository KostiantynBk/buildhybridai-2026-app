import { LocalError } from '../ai/localModel';
import type { ProfileRecord } from '../store';
import { bindTemplate } from './bindTemplate';
import { normalizeQuote, type LocalRunner } from './extract';
import { filterQuestion, type LeakResult } from './leakFilter';
import { anglesV1 } from './prompts/angles.v1';
import { questionV1 } from './prompts/question.v1';
import { whynoteV1 } from './prompts/whynote.v1';
import type { Concern, DisplayAngle, SelectionItem } from './selectConcerns';

export interface TriageItem extends SelectionItem { text: string }
export interface LocalOutput<T> { data: T; latencyMs: number; source: string }
async function checked<T>(runner: LocalRunner, prompt: string,
  definition: typeof anglesV1 | typeof questionV1 | typeof whynoteV1, signal?: AbortSignal,
  onDispatch?: () => void): Promise<LocalOutput<T>> {
  const result = await runner<T>({ prompt, schema: definition.schema, instructions: definition, signal, onDispatch });
  if (result.source !== 'on_device') throw new LocalError('privacy-fault', 'Local inference source not verified.',
    { source: result.source === 'in_cloud' ? 'in_cloud' : 'not reported' });
  return { data: result.data, latencyMs: result.latencyMs, source: result.source };
}
export function eligibleItems(paragraph: string, items: readonly TriageItem[]): TriageItem[] {
  const body = normalizeQuote(paragraph);
  return items.filter(item => ['assumption', 'decision', 'constraint'].includes(item.kind) &&
    normalizeQuote(item.quote).length > 0 && body.includes(normalizeQuote(item.quote)));
}
export async function runAngles(runner: LocalRunner, paragraph: string, items: readonly TriageItem[],
  signal?: AbortSignal, onDispatch?: () => void):
  Promise<{ items: TriageItem[]; concerns: Concern[]; latencyMs: number; source: string }> {
  const eligible = eligibleItems(paragraph, items);
  if (!eligible.length) return { items: [], concerns: [], latencyMs: 0, source: 'code' };
  const numbered = eligible.map((item, index) => `${index + 1}. (${item.kind}) ${item.text}`).join('\n');
  const key = '{numbered list: "{n}. ({kind}) {text}" for each item of kind assumption, decision or constraint}';
  const prompt = bindTemplate(anglesV1.inputTemplate, { '{paragraph}': paragraph, [key]: numbered });
  const result = await checked<{ concerns: Concern[] }>(runner, prompt, anglesV1, signal, onDispatch);
  return { items: eligible, concerns: result.data.concerns, latencyMs: result.latencyMs, source: result.source };
}
export async function runQuestion(runner: LocalRunner, item: Pick<TriageItem, 'text' | 'quote'>,
  angle: DisplayAngle, concern: string, neverSend: readonly string[], privateTokens: readonly string[] = [],
  signal?: AbortSignal, onDispatch?: () => void): Promise<{ question: string; keptOut: string[]; leak: LeakResult;
    latencyMs: number; source: string }> {
  const prompt = bindTemplate(questionV1.inputTemplate, { '{item.text}': item.text, '{item.quote}': item.quote,
    '{angle}': angle, '{concern}': concern });
  const result = await checked<{ question: string; keptOut: string[] }>(runner, prompt, questionV1, signal,
    onDispatch);
  const leak = filterQuestion(result.data.question, neverSend, privateTokens);
  const keptOut = result.data.keptOut.filter(value => filterQuestion(value, neverSend, privateTokens).passed);
  return { question: result.data.question, keptOut, leak, latencyMs: result.latencyMs, source: result.source };
}
export function chooseProfileRecords(topics: readonly string[], profile: readonly ProfileRecord[],
  triggeringLessonId?: string | null): ProfileRecord[] {
  const rank = (record: ProfileRecord) => record.type === 'lesson' ? 0 : record.type === 'skill' ? 1 : 2;
  const ranked = profile.map(record => ({ record,
    shared: new Set(record.topics.filter(topic => topics.includes(topic))).size }))
    .filter(entry => entry.shared > 0)
    .sort((a, b) => b.shared - a.shared || rank(a.record) - rank(b.record) || a.record.id.localeCompare(b.record.id));
  const lesson = ranked.find(entry => entry.record.id === triggeringLessonId && entry.record.type === 'lesson');
  return lesson ? [lesson.record, ...ranked.filter(entry => entry !== lesson).slice(0, 2).map(entry => entry.record)]
    : ranked.slice(0, 3).map(entry => entry.record);
}
export async function runWhyNote(runner: LocalRunner, quote: string, angle: DisplayAngle, concern: string,
  question: string, topics: readonly string[], profile: readonly ProfileRecord[], signal?: AbortSignal,
  triggeringLessonId?: string | null, onDispatch?: () => void):
  Promise<{ note: { seeing: string; why: string; used: string[] } | null; latencyMs: number; source: string }> {
  const records = chooseProfileRecords(topics, profile, angle === 'track-record' ? triggeringLessonId : undefined);
  const lines = records.map(record => `[${record.id}] ${record.type}` +
    `${record.type === 'skill' && record.depth ? ` (${record.depth})` : ''}: ${record.text}`).join('\n') || 'none';
  const key = '{one line per record: "[{id}] {type}{" (" + depth + ")" for skills}: {text}", ' +
    'or the single word "none"}';
  const prompt = bindTemplate(whynoteV1.inputTemplate, { '{item.quote}': quote, '{angle}': angle,
    '{concern}': concern, '{question}': question, [key]: lines });
  const result = await checked<{ seeing: string; why: string; used: string[] }>(runner, prompt, whynoteV1, signal,
    onDispatch);
  const valid = new Set(records.map(record => record.id));
  const note = result.data.seeing.startsWith('You') ? { ...result.data,
    used: result.data.used.filter(id => valid.has(id)) } : null;
  return { note, latencyMs: result.latencyMs, source: result.source };
}
