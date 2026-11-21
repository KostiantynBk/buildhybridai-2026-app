import { expect, it } from 'vitest';
import { formattingQuote } from './formatQuote';

it.each([
  ['The **on-device** model runs locally.', 'on-device model', '**on-device** model'],
  ['The _private_ profile stays local.', 'private profile', '_private_ profile'],
  ['The `on_device` step is local.', 'on_device step', '`on_device` step'],
  ['A **bold** and *italic* example.', 'bold and italic', '**bold** and *italic*'],
  ['A __bold phrase__ word.', 'bold phrase word', '__bold phrase__ word'],
])('maps formatting-only quote %s to an exact source substring', (source, quote, expected) => {
  const result = formattingQuote(source, quote);
  expect(result).toBe(expected);
  expect(source.includes(result!)).toBe(true);
});
it('rejects changed words, reorderings and partial words', () => {
  const source = 'The **private** profile stays local.';
  for (const quote of ['private account', 'profile private', 'rivat', 'local profile']) {
    expect(formattingQuote(source, quote)).toBeNull();
  }
});
it('keeps code literal, rejects ambiguous markers and handles double backticks', () => {
  expect(formattingQuote('Keep `a*b*c` as the literal formula.', 'Keep abc as the literal formula.')).toBeNull();
  expect(formattingQuote('Keep `__init__` as the name.', 'Keep init as the name.')).toBeNull();
  expect(formattingQuote('Keep abc as the literal formula.', 'Keep `a*b*c` as the literal formula.')).toBeNull();
  expect(formattingQuote('The **private profile stays local.', 'The private profile')).toBeNull();
  expect(formattingQuote('The **budget _rules** by today_.', 'The budget rules by today.')).toBeNull();
  expect(formattingQuote('Use ``a`b`` as the literal text.', 'Use a`b as the literal text.'))
    .toBe('Use ``a`b`` as the literal text.');
  expect(formattingQuote('Use __init__ as the name.', 'Use init as the name.')).toBeNull();
});
it('does not remove arithmetic operators beside punctuation, in either direction', () => {
  for (const [literal, altered] of [
    ['Use 20*(2+3)*4 for the estimate.', 'Use 20(2+3)4 for the estimate.'],
    ['Use a*-b/c*-d for the estimate.', 'Use a-b/c-d for the estimate.'],
  ]) {
    expect(formattingQuote(literal, altered)).toBeNull();
    expect(formattingQuote(altered, literal)).toBeNull();
  }
});
it('declines recovery for backslashes in either the source or returned quote', () => {
  const source = 'Use `x\\` and `y` as the values.';
  expect(formattingQuote(source, 'Use x\\ and y as the values.')).toBeNull();
  expect(formattingQuote(source, 'Use x\\` and y` as the values.')).toBeNull();
  expect(formattingQuote('Use x\\ and y as the values.', source)).toBeNull();
});
it('declines competing widths and unsupported Markdown contexts in both directions', () => {
  const cases = [
    ['Use **alpha* beta** for the next estimate.', 'Use alpha* beta for the next estimate.'],
    ['Keep [local plan](/estimate/*literal*/raw) for the review.',
      'Keep [local plan](/estimate/literal/raw) for the review.'],
    ['~~~txt\nUse **alpha** right now.\n~~~', '~~~txt\nUse alpha right now.\n~~~'],
    ['A **bold** sentence followed by ![image](local).', 'A bold sentence followed by ![image](local).'],
    ['A **bold** sentence with <span>markup</span>.', 'A bold sentence with <span>markup</span>.'],
    ['A **bold** sentence.\n    code here', 'A bold sentence.\n    code here'],
    ['A **bold** sentence.\n\tcode here', 'A bold sentence.\n\tcode here'],
  ];
  for (const [source, quote] of cases) {
    expect(formattingQuote(source, quote)).toBeNull();
    expect(formattingQuote(quote, source)).toBeNull();
  }
});
it('conservatively declines otherwise-valid mixed-width nesting', () => {
  expect(formattingQuote('A **bold *italic* words** here.', 'bold italic words here')).toBeNull();
});
it('continues to recover supported BRIEF-style prose, list and numbered cases', () => {
  const cases = [
    ['An **on-device** model quietly reads along.', 'on-device model quietly', '**on-device** model quietly'],
    ['- **Heartbeat:** A–C run after an edit pause.', 'Heartbeat: A–C run', '**Heartbeat:** A–C run'],
    ['4. **Measured usefulness:** a small, honest evaluation.', 'Measured usefulness: a small',
      '**Measured usefulness:** a small'],
  ];
  for (const [source, quote, expected] of cases) expect(formattingQuote(source, quote)).toBe(expected);
});
it('never pairs emphasis or code across Markdown table cells', () => {
  const cases = [
    ['| *draft | review* **stays local** |', '| draft | review stays local |'],
    ['| `draft | review` **stays local** |', '| draft | review stays local |'],
  ];
  for (const [source, quote] of cases) {
    expect(formattingQuote(source, quote)).toBeNull();
    expect(formattingQuote(quote, source)).toBeNull();
  }
  const noEdges = 'Pattern | Result\n---|---\ndraft | review stays local';
  expect(formattingQuote(noEdges, '*draft | review* stays local')).toBeNull();
  expect(formattingQuote(noEdges, '`draft | review` stays local')).toBeNull();
  const valid = '| **draft item** | *review* `code` |';
  expect(formattingQuote(valid, '| draft item | review code |')).toBe(valid);
  const escaped = '| **A \\| B** | plain |';
  expect(formattingQuote(escaped, '| A \\| B | plain |')).toBeNull();
});
it('declines the escaped-pipe role-swap repro in both directions', () => {
  const source = '| path `a\\`| next `b\\| text` here |';
  const quote = '| path `a\\| next b\\`| text **here** |';
  expect(formattingQuote(source, quote)).toBeNull();
  expect(formattingQuote(quote, source)).toBeNull();
  const safe = '| **draft item** | *review* `code` |';
  expect(formattingQuote(safe, '| draft item | review code |')).toBe(safe);
});
it('does not pair spans across list items or table rows', () => {
  for (const [source, quote] of [
    ['- *draft\n- review* **stays**', '- draft\n- review stays'],
    ['- `draft\n- review` **stays**', '- draft\n- review stays'],
    ['first | *draft\nreview* | **stays**', 'first | draft\nreview | stays'],
  ]) {
    expect(formattingQuote(source, quote)).toBeNull();
    expect(formattingQuote(quote, source)).toBeNull();
  }
  expect(formattingQuote('A **draft\nreview** stays local.', 'A draft\nreview stays local.'))
    .toBe('A **draft\nreview** stays local.');
});
it('preserves whole-text normalization and supplementary word boundaries', () => {
  expect(formattingQuote('The ΟΔΟΣ route is local here.', 'οδοσ route is local', 'normalized')).toBeNull();
  expect(formattingQuote('The **ΟΔΟΣ** route is local here.', 'οδος route is local', 'normalized'))
    .toBe('**ΟΔΟΣ** route is local');
  expect(formattingQuote('Use 𐐨𐐩 **ready** model.', '𐐩 ready model')).toBeNull();
  expect(formattingQuote('Use **ready** 𐐨𐐩 model.', 'ready 𐐨')).toBeNull();
});
it('bounds work on repeated unmatched openers', () => {
  const text = '*pending '.repeat(2048) + 'last words';
  const start = performance.now();
  expect(formattingQuote(text, 'not present')).toBeNull();
  expect(performance.now() - start).toBeLessThan(1000);
});
it('does not turn identifier underscores into formatting', () => {
  expect(formattingQuote('The on_device mode is enabled.', 'ondevice mode')).toBeNull();
  expect(formattingQuote('The on_device mode is enabled.', 'on_device mode')).toBeNull();
});
