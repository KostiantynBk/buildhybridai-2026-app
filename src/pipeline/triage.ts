import { LocalError } from '../ai/localModel';
import type { ProfileRecord } from '../store';
import { bindTemplate } from './bindTemplate';
import { normalizeQuote, type LocalRunner } from './extract';
import { filterQuestion, type LeakResult } from './leakFilter';
import { anglesV1 } from './prompts/angles.v1';
import { questionV1 } from './prompts/question.v1';
import { whynoteV1 } from './prompts/whynote.v1';
import { anglesV2 } from './prompts/angles.v2';
import { questionV2 } from './prompts/question.v2';
import { whynoteV2 } from './prompts/whynote.v2';
import { anglesV21 } from './prompts/angles.v2.1';
import { questionV21 } from './prompts/question.v2.1';
import { TRIAGE_PROMPT_SET, type TriageVersion } from './triageVersion';
import type { Concern, DisplayAngle, SelectionItem } from './selectConcerns';

export interface TriageItem extends SelectionItem { text: string }
export interface LocalOutput<T> { data: T; latencyMs: number; source: string }
async function checked<T>(runner: LocalRunner, prompt: string,
  definition: typeof anglesV1 | typeof questionV1 | typeof whynoteV1 |
    typeof anglesV2 | typeof questionV2 | typeof whynoteV2 | typeof anglesV21 | typeof questionV21,
  signal?: AbortSignal,
  onDispatch?: () => void, expectedSource: 'on_device' | 'in_cloud' = 'on_device'): Promise<LocalOutput<T>> {
  const result = await runner<T>({ prompt, schema: definition.schema, instructions: definition, signal, onDispatch });
  if (result.source !== expectedSource) throw new LocalError('privacy-fault', 'Inference source not verified.',
    { source: result.source === 'in_cloud' ? 'in_cloud' : 'not reported' });
  return { data: result.data, latencyMs: result.latencyMs, source: result.source };
}
export function eligibleItems(paragraph: string, items: readonly TriageItem[],
  version: TriageVersion = TRIAGE_PROMPT_SET): TriageItem[] {
  const body = normalizeQuote(paragraph);
  const kinds = version !== 'v1' ? ['assumption', 'decision', 'constraint', 'open-question']
    : ['assumption', 'decision', 'constraint'];
  return items.filter(item => kinds.includes(item.kind) &&
    normalizeQuote(item.quote).length > 0 && body.includes(normalizeQuote(item.quote)));
}
export async function runAngles(runner: LocalRunner, paragraph: string, items: readonly TriageItem[],
  signal?: AbortSignal, onDispatch?: () => void, version: TriageVersion = TRIAGE_PROMPT_SET,
  expectedSource: 'on_device' | 'in_cloud' = 'on_device'):
  Promise<{ items: TriageItem[]; concerns: Concern[]; latencyMs: number; source: string }> {
  const eligible = eligibleItems(paragraph, items, version);
  if (!eligible.length) return { items: [], concerns: [], latencyMs: 0, source: 'code' };
  const numbered = eligible.map((item, index) => `${index + 1}. (${item.kind}) ${item.text}`).join('\n');
  const definition = version === 'v2.1' ? anglesV21 : version === 'v2' ? anglesV2 : anglesV1;
  const key = version !== 'v1'
    ? '{numbered list: "{n}. ({kind}) {text}" for each item of kind assumption, decision, constraint or open-question}'
    : '{numbered list: "{n}. ({kind}) {text}" for each item of kind assumption, decision or constraint}';
  const prompt = bindTemplate(definition.inputTemplate, { '{paragraph}': paragraph, [key]: numbered });
  const result = await checked<{ concerns: Concern[] }>(runner, prompt, definition, signal, onDispatch,
    expectedSource);
  return { items: eligible, concerns: result.data.concerns, latencyMs: result.latencyMs, source: result.source };
}
export async function runQuestion(runner: LocalRunner, item: Pick<TriageItem, 'text' | 'quote'>,
  angle: DisplayAngle, concern: string, neverSend: readonly string[], privateTokens: readonly string[] = [],
  signal?: AbortSignal, onDispatch?: () => void, version: TriageVersion = TRIAGE_PROMPT_SET,
  expectedSource: 'on_device' | 'in_cloud' = 'on_device'):
  Promise<{ question: string; keptOut: string[]; leak: LeakResult;
    latencyMs: number; source: string }> {
  const definition = version === 'v2.1' ? questionV21 : version === 'v2' ? questionV2 : questionV1;
  const prompt = bindTemplate(definition.inputTemplate, { '{item.text}': item.text, '{item.quote}': item.quote,
    '{angle}': angle, '{concern}': concern });
  const result = await checked<{ question: string; keptOut: string[] }>(runner, prompt, definition, signal,
    onDispatch, expectedSource);
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
  triggeringLessonId?: string | null, onDispatch?: () => void, kind = 'assumption',
  version: TriageVersion = TRIAGE_PROMPT_SET):
  Promise<{ note: { seeing: string; why: string; used: string[] } | null; whyDropped: boolean;
    latencyMs: number; source: string }> {
  if (version === 'v2.1') throw new Error('The v2.1 prompt set does not call why-note.');
  const records = chooseProfileRecords(topics, profile, angle === 'track-record' ? triggeringLessonId : undefined);
  const lines = records.map(record => `[${record.id}] ${record.type}` +
    `${record.type === 'skill' && record.depth ? ` (${record.depth})` : ''}: ${record.text}`).join('\n') || 'none';
  const definition = version === 'v2' ? whynoteV2 : whynoteV1;
  const key = version === 'v2' ? '{one line per record, as in whynote.v1, or the single word "none"}'
    : '{one line per record: "[{id}] {type}{" (" + depth + ")" for skills}: {text}", ' +
      'or the single word "none"}';
  const prompt = bindTemplate(definition.inputTemplate, { '{item.quote}': quote, '{item.kind}': kind, '{angle}': angle,
    '{concern}': concern, '{question}': question, [key]: lines });
  const result = await checked<{ seeing: string; why: string; used: string[] }>(runner, prompt, definition, signal,
    onDispatch);
  const valid = new Set(records.map(record => record.id));
  const citations = result.data.used.filter(id => valid.has(id));
  const used = version === 'v2' ? [...new Set(citations)] : citations;
  const negativeClaim = new RegExp('(?<![\\p{L}\\p{M}\\p{N}_])' +
    "(?:have\\s+not|haven['’]t|has\\s+not|never|without\\s+you)(?![\\p{L}\\p{M}\\p{N}_])", 'iu');
  const negativeEvidence = /(?<![\p{L}\p{M}\p{N}_])(?:not|never|[\p{L}\p{M}]+n['’]t)(?![\p{L}\p{M}\p{N}_])/iu;
  const whyDropped = version === 'v2' && negativeClaim.test(result.data.why) &&
    !records.some(record => used.includes(record.id) && negativeEvidence.test(record.text));
  const note = result.data.seeing.startsWith('You') ? { ...result.data, used,
    why: whyDropped ? '' : result.data.why } : null;
  return { note, whyDropped: Boolean(note && whyDropped), latencyMs: result.latencyMs, source: result.source };
}
