import practice from '../../eval/set-v1/dev-examples.json';
import profiles from '../../eval/set-v1/profiles.json';
import { extractV1 } from '../pipeline/prompts/extract.v1';
import { compareV1 } from '../pipeline/prompts/compare.v1';
import { anglesV1 } from '../pipeline/prompts/angles.v1';
import { questionV1 } from '../pipeline/prompts/question.v1';
import { whynoteV1 } from '../pipeline/prompts/whynote.v1';
import { bindTemplate } from '../pipeline/bindTemplate';
import { extractionPrompts, type ExtractVersion } from '../pipeline/extract';

export const prompts = {
  extract: extractV1,
  compare: compareV1,
  angles: anglesV1,
  question: questionV1,
  whynote: whynoteV1,
};
export type PromptName = keyof typeof prompts;
export type PracticeId = (typeof practice.examples)[number]['id'];
export type ProfileId = 'A' | 'B';
export const examples = practice.examples;
export function promptFor(name: PromptName, version: ExtractVersion = 'extract.v1') {
  return name === 'extract' ? extractionPrompts[version] : prompts[name];
}

function recordsFor(topics: string[], profile: ProfileId): string {
  const records = profiles.profiles[profile].records;
  const rank = (record: (typeof records)[number]) => {
    if (record.type === 'lesson') return 0;
    if (record.type === 'skill' && 'depth' in record && record.depth === 'none') return 1;
    if (record.type === 'project') return 2;
    if (record.type === 'skill') return 3;
    return 4;
  };
  const matches = records
    .map((record, index) => ({
      record,
      index,
      shared: record.topics.filter((topic) => topics.includes(topic)).length,
    }))
    .filter((item) => item.shared > 0)
    .sort((a, b) => b.shared - a.shared || rank(a.record) - rank(b.record) || a.index - b.index)
    .slice(0, 3);
  return (
    matches
      .map(({ record }) => {
        const depth = 'depth' in record ? ` (${record.depth})` : '';
        return `[${record.id}] ${record.type}${depth}: ${record.text}`;
      })
      .join('\n') || 'none'
  );
}
export function practiceInput(name: PromptName, id: PracticeId, profile: ProfileId): string {
  const example = examples.find((item) => item.id === id) ?? examples[0];
  const item = example.expected[0];
  const concern = example.blindSpots[0];
  const quote = item?.span ?? '';
  const text = item?.span ?? '';
  const angle = concern?.angle ?? '';
  const description = concern?.description ?? '';
  const numbered = example.expected
    .filter((entry) => ['assumption', 'decision', 'constraint'].includes(entry.kind))
    .map((entry, index) => `${index + 1}. (${entry.kind}) ${entry.span}`)
    .join('\n');
  const fields: Record<string, string> = {
    '{title}': example.title,
    '{paragraph}': example.text,
    '{item.text}': text,
    '{item.quote}': quote,
    '{angle}': angle,
    '{concern}': description,
    '{question}': concern
      ? `What should a builder check about ${concern.questionKeywords.join(', ')}?`
      : '',
    '{numbered list: "{n}. ({kind}) {text}" for each item of kind assumption, decision or constraint}':
      numbered,
    '{one line per record: "[{id}] {type}{" (" + depth + ")" for skills}: {text}", or the single word "none"}':
      recordsFor(item?.topics ?? [], profile),
  };
  return bindTemplate(prompts[name].inputTemplate, fields);
}
export function sizeInCharacters(
  name: PromptName,
  input: string,
  version: ExtractVersion = 'extract.v1',
): number {
  const p = promptFor(name, version);
  const extra = 'additionalExamples' in p ? p.additionalExamples : [];
  return (
    p.system.length +
    p.exampleInput.length +
    p.exampleOutput.length +
    extra.reduce((total, example) => total + example.input.length + example.output.length, 0) +
    input.length +
    JSON.stringify(p.schema).length
  );
}
