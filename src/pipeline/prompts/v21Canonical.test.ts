/// <reference types="node" />
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { anglesV2 } from './angles.v2';
import { anglesV21 } from './angles.v2.1';
import { questionV2 } from './question.v2';
import { questionV21 } from './question.v2.1';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
it('matches the canonical v2.1 system blocks and reuses all unchanged v2 fields', () => {
  expect(hash(anglesV21.system)).toBe('6df60579b6db81c332a05dba61a6a21f6503f97a0cf9c961dd9c6287c318b5ba');
  expect(hash(questionV21.system)).toBe('4b776cc49e6170ca2b8c14521a7ebb4c556695d6fcbeee4a9dbfe040e281a117');
  expect(anglesV21.system).toBe(anglesV2.system.replace('- If nothing matters,',
    '- Write plain sentences. No formulas, symbols or markup, and no calculations.\n- If nothing matters,'));
  expect(questionV21.system).toBe(questionV2.system.replace('Stay on the subject',
    'If the statement names or implies a product, service, platform or law, name it in the question and ' +
    'ask about one concrete thing. Avoid "typical" and "general" questions.\n\nStay on the subject'));
  for (const [next, previous] of [[anglesV21, anglesV2], [questionV21, questionV2]] as const) {
    expect(next.exampleInput).toBe(previous.exampleInput);
    expect(next.exampleOutput).toBe(previous.exampleOutput);
    expect(next.inputTemplate).toBe(previous.inputTemplate);
    expect(next.schemaText).toBe(previous.schemaText);
    expect(next.schema).toBe(previous.schema);
  }
});
