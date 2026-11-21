import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractionUnits, isHeadingBlock, paragraphLabel } from './planStructure';
import type { Paragraph } from '../store/matcher';

const paragraph = (id: string, order: number, text: string): Paragraph => ({ id, order, text,
  projectId: 'default', version: 1, updatedAt: 0 });
it('recognizes only a single Markdown heading line', () => {
  for (const value of ['# Title', '## 4. How it works', '###### Deep heading', '  ### Padded  ']) {
    expect(isHeadingBlock(value)).toBe(true);
  }
  for (const value of ['Title', '#NoSpace', '####### Too deep', '# ', '# Title\nBody', '# One\n# Two']) {
    expect(isHeadingBlock(value)).toBe(false);
  }
});
it('labels paragraphs by the nearest preceding heading and opening words', () => {
  const parts = [paragraph('h1', 0, '## First'), paragraph('h2', 1, '### 4. How it works'),
    paragraph('p', 2, '- Heartbeat: A–C run after an edit with extra words beyond the preview')];
  expect(paragraphLabel(parts[2], parts)).toBe('Under “4. How it works”: “- Heartbeat: A–C run after an edit with…”');
  expect(paragraphLabel(parts[2], [parts[2]])).toBe('“- Heartbeat: A–C run after an edit with…”');
});
it('splits table data rows with the header and skips the separator', () => {
  const table = '| Risk | Check |\n|---|---|\n| Alpha | One |\n| Beta | Two |\n| Gamma | Three |';
  expect(extractionUnits(table)).toEqual(['| Risk | Check |\n| Alpha | One |',
    '| Risk | Check |\n| Beta | Two |', '| Risk | Check |\n| Gamma | Three |']);
  expect(extractionUnits('| Risk | Check |\n|---|---|\n| Alpha | One |'))
    .toEqual(['| Risk | Check |\n|---|---|\n| Alpha | One |']);
  expect(extractionUnits('| Risk | Check |\n|---|---|\n| Alpha | One |\n| Beta | Two |')).toHaveLength(2);
});
it('supports one-column GFM tables and rejects inconsistent widths', () => {
  const single = '| Risk |\n| --- |\n| Alpha |\n| Beta |';
  expect(extractionUnits(single)).toEqual(['| Risk |\n| Alpha |', '| Risk |\n| Beta |']);
  const wrongHeader = '| One column |\n|---|---|\n| Alpha | One |\n| Beta | Two |';
  expect(extractionUnits(wrongHeader)).toEqual([wrongHeader]);
  const wrongRow = '| A | B |\n|---|---|\n| Alpha |\n| Beta | Two |';
  expect(extractionUnits(wrongRow)).toEqual([wrongRow]);
  const escaped = '| Name | Detail |\n|:-|--:|\n| One | A \\| B |\n| Two | C |';
  expect(extractionUnits(escaped)).toEqual(['| Name | Detail |\n| One | A \\| B |',
    '| Name | Detail |\n| Two | C |']);
});
it('splits lists with a preamble and preserves item continuation lines', () => {
  const list = 'Problems:\n1. First item\n   more detail\n2. Second item\n3. Third item';
  expect(extractionUnits(list)).toEqual(['1. First item\n   more detail', '2. Second item', '3. Third item']);
  expect(extractionUnits('- one\n- two')).toEqual(['- one\n- two']);
  expect(extractionUnits('- one\n- two\n- three\nNot an item')).toEqual(['- one\n- two\n- three\nNot an item']);
});
it('does not split any frozen Run 1 or Run 3 note', () => {
  const set = JSON.parse(readFileSync('eval/set-v1/notes.json', 'utf8')) as { notes: Array<{ text: string }> };
  expect(set.notes).toHaveLength(20);
  for (const note of set.notes) expect(extractionUnits(note.text)).toEqual([note.text]);
});
