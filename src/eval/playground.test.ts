import { expect, it } from 'vitest';
import { practiceInput, prompts, sizeInCharacters, type PromptName } from './playground';

it('fills all five practice prompt templates from their expected fields', () => {
  for (const name of Object.keys(prompts) as PromptName[]) {
    const input = practiceInput(name, 'd1', 'A');
    expect(input).not.toMatch(
      /\{(?:paragraph|title|item\.text|item\.quote|concern|angle|question)\}/,
    );
    expect(sizeInCharacters(name, input)).toBeGreaterThan(input.length);
  }
  expect(practiceInput('extract', 'd1', 'A')).toContain('Sign-in will be magic links only');
  expect(practiceInput('angles', 'd1', 'A')).toContain('1. (decision)');
  expect(practiceInput('whynote', 'd1', 'A')).toContain('[A-');
});
