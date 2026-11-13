import { extractV1 } from '../pipeline/prompts/extract.v1';
import { extractV2 } from '../pipeline/prompts/extract.v2';
import { compareV1 } from '../pipeline/prompts/compare.v1';
import { anglesV1 } from '../pipeline/prompts/angles.v1';
import { questionV1 } from '../pipeline/prompts/question.v1';
import { whynoteV1 } from '../pipeline/prompts/whynote.v1';
import type { PromptSet } from './defaults';

const shared = { compare: compareV1, angles: anglesV1, question: questionV1, whynote: whynoteV1 };
export const bundledPromptSets = {
  v1: { ...shared, extract: extractV1 },
  v2: { ...shared, extract: extractV2 },
} as const;
export function isBundledPromptSet(value: string): value is PromptSet {
  if (value !== 'v1' && value !== 'v2') return false;
  const set = bundledPromptSets[value];
  return Object.values(set).every((prompt) => Boolean(prompt.system && prompt.exampleInput && prompt.schema));
}
