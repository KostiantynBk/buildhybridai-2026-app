/// <reference types="node" />
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { anglesV1 } from './angles.v1';
import { anglesV2 } from './angles.v2';
import { questionV1 } from './question.v1';
import { questionV2 } from './question.v2';
import { whynoteV1 } from './whynote.v1';
import { whynoteV2 } from './whynote.v2';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
it('preserves each canonical v2 block and the approved identical v1 fields', () => {
  expect(hash(anglesV2.system)).toBe('f95d000ae3333b0769b037c87b0974cfc8deb7e1443fdcdbff7feb0c591e6164');
  expect(hash(anglesV2.exampleInput)).toBe('795944a97a5114a6ad29872d17ca4bc40528459683f5d4cadc5a24e67c7e8f83');
  expect(hash(anglesV2.exampleOutput)).toBe('943eb9023d6214fa09f8eb69d6ffe8bafed77523cc9901700bef2b062e0d3db3');
  expect(hash(anglesV2.inputTemplate)).toBe('013094b96a690a2d5245f69cb7b3ce45eb9c04da09bd011ade7a05036ea22d4c');
  expect(anglesV2.schemaText).toBe(anglesV1.schemaText);
  expect(anglesV2.schema).toBe(anglesV1.schema);
  expect(hash(questionV2.system)).toBe('2754f995140635d951a2a5f2b2c56c1ff1acbbf6b35fbde886d17fb4091baa7a');
  expect(questionV2.exampleInput).toBe(questionV1.exampleInput);
  expect(questionV2.exampleOutput).toBe(questionV1.exampleOutput);
  expect(questionV2.inputTemplate).toBe(questionV1.inputTemplate);
  expect(questionV2.schemaText).toBe(questionV1.schemaText);
  expect(questionV2.schema).toBe(questionV1.schema);
  expect(hash(whynoteV2.system)).toBe('36b4cabf91b18681f51c89085744c1aaf6ad4685b898857f53cb1e08cb271255');
  expect(hash(whynoteV2.exampleInput)).toBe('516397726926cb11bda7fce002b4bf65fb8537c24da6cf930ec8f07d4f738748');
  expect(hash(whynoteV2.exampleOutput)).toBe('29f9a582a6a9a29bfc2f15806c42a23c5d922c0e8ff471ad5efb85398a8a6d0a');
  expect(hash(whynoteV2.inputTemplate)).toBe('9aeba9df50c1bd08b9deeacd351ca5bfb1da68e0d3f2fef51baaf0dffed4220e');
  expect(whynoteV2.schemaText).toBe(whynoteV1.schemaText);
  expect(whynoteV2.schema).toBe(whynoteV1.schema);
});
