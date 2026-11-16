import { expect, it } from 'vitest';
import { practiceInput, prompts, sizeInCharacters, type PromptName } from './playground';

it('fills all active v2.1 practice templates and refuses a why-note', () => {
  for (const name of (Object.keys(prompts) as PromptName[]).filter(value => value !== 'whynote')) {
    const input = practiceInput(name, 'd1', 'A');
    expect(input).not.toMatch(
      /\{(?:paragraph|title|item\.text|item\.quote|concern|angle|question)\}/,
    );
    expect(sizeInCharacters(name, input)).toBeGreaterThan(input.length);
  }
  expect(practiceInput('extract', 'd1', 'A')).toContain('Sign-in will be magic links only');
  expect(practiceInput('angles', 'd1', 'A')).toContain('1. (decision)');
  expect(() => practiceInput('whynote', 'd1', 'A')).toThrow('does not call why-note');
});
