/// <reference types="node" />
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { prompts } from '../../eval/playground';
import { extractV1 } from './extract.v1';
import { extractV2 } from './extract.v2';

const hashes = {
  extract: '10f748957d507d1c6a99f8a4ed691df0dff4ddd643dcceaec2626bea8ee8aa76',
  compare: 'f5dd0885842089686af50e72ac3ca02bd168890fdaf8a678ea9192900be08f5b',
  angles: '4cd305bb7b0956588f9b66699fc86fa7424fdb1081664249a47bbeded0ec3b7f',
  question: '6b0f69fc0a473a3eda5ebc40acc52a3e15a33ab2c8a0ca0e00ea601a54cd30f0',
  whynote: '891cdf947ac933251be89bcc651da703381e8e9f16ce22c960881cbb1e828945',
};
it('preserves the exact v1 system, example, input template and schema text', () => {
  for (const name of Object.keys(hashes) as (keyof typeof hashes)[]) {
    const p = prompts[name];
    const content = [p.system, p.exampleInput, p.exampleOutput, p.inputTemplate, p.schemaText].join(
      '\0',
    );
    expect(createHash('sha256').update(content).digest('hex')).toBe(hashes[name]);
  }
});

it('preserves the approved v2 system and first example and reuses v1 for the rest', () => {
  const text = [extractV2.system, extractV2.exampleInput, extractV2.exampleOutput].join('\0');
  expect(createHash('sha256').update(text).digest('hex')).toBe(
    '2d5f70c0256ca7c5af5d1061feb97d73d06ff826bd9cdf7762339474a7eadf23',
  );
  expect(extractV2.additionalExamples).toEqual([
    { input: extractV1.exampleInput, output: extractV1.exampleOutput },
  ]);
  expect(extractV2.inputTemplate).toBe(extractV1.inputTemplate);
  expect(extractV2.schemaText).toBe(extractV1.schemaText);
  expect(extractV2.schema).toBe(extractV1.schema);
});
