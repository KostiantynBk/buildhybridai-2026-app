type MarkerPair = { open: number; close: number; width: number };
type VisibleText = { text: string; positions: number[]; pairs: MarkerPair[] };
// Recovery is advisory; legacy matches remain available beyond this conservative work bound.
const MAX_RECOVERY_UNITS = 4096;
const MAX_CANDIDATES = 64;
const word = (char: string | undefined) => !!char && /[\p{L}\p{M}\p{N}_]/u.test(char);
const punctuation = (char: string | undefined) => !!char && /[\p{P}\p{S}]/u.test(char);
const whitespace = (char: string | undefined) => !char || /\s/u.test(char);
const before = (text: string, index: number) => Array.from(text.slice(0, index)).at(-1);
const after = (text: string, index: number) =>
  index < text.length ? String.fromCodePoint(text.codePointAt(index)!) : '';

export function supportsFormattingRecovery(value: string): boolean {
  return !value.includes('\\') && !value.includes('\r') && !value.includes('](') && !value.includes('![') &&
    !/<[A-Za-z/!]/u.test(value) &&
    !/^(?: {0,3})(?:`{3,}|~{3,})/mu.test(value) && !/^(?: {4}|\t)/mu.test(value);
}

function hasTableRows(value: string): boolean {
  const lines = value.split('\n');
  return lines.filter(line => line.includes('|')).length >= 2 ||
    lines.some(line => /^\s*\|/u.test(line) || /\|\s*$/u.test(line));
}

/** Conservative balanced markup subset; code contents are always literal. */
function visible(value: string, tableContext = false): VisibleText | null {
  if (value.length > MAX_RECOVERY_UNITS || !supportsFormattingRecovery(value)) return null;
  const removed = new Uint8Array(value.length);
  const code = new Uint8Array(value.length);
  const pairs: MarkerPair[] = [];
  const escaped = (index: number) => {
    let count = 0;
    for (let i = index - 1; i >= 0 && value[i] === '\\'; i--) count++;
    return count % 2 === 1;
  };
  const boundaries = new Uint8Array(value.length + 1);
  const lines = value.split('\n');
  const tableRows = tableContext || hasTableRows(value);
  let lineStart = 0;
  for (const line of lines) {
    const tableRow = tableRows && line.includes('|');
    if (lineStart && (tableRow || /^\s*(?:[-+*]|\d+[.)])[ \t]+\S/u.test(line))) boundaries[lineStart] = 1;
    if (tableRow) for (let i = 0; i < line.length; i++) {
      const at = lineStart + i;
      if (line[i] === '|' && !escaped(at)) boundaries[at] = 1;
    }
    lineStart += line.length + 1;
  }
  const sums = new Uint32Array(value.length + 2);
  for (let i = 0; i <= value.length; i++) sums[i + 1] = sums[i] + boundaries[i];
  const crossesBoundary = (open: number, close: number) => sums[close + 1] > sums[open];
  const add = (open: number, close: number, width: number) => {
    for (let k = 0; k < width; k++) { removed[open + k] = 1; removed[close + k] = 1; }
    pairs.push({ open, close, width });
  };
  for (let i = 0; i < value.length;) {
    if (value[i] !== '`' || escaped(i)) { i++; continue; }
    let end = i;
    while (value[end] === '`') end++;
    const width = end - i;
    let close = value.indexOf('`', end);
    while (close >= 0) {
      let stop = close;
      while (value[stop] === '`') stop++;
      if (stop - close === width) break;
      close = value.indexOf('`', stop);
    }
    if (close < 0) { i = end; continue; }
    if (close === end || crossesBoundary(i, close)) return null;
    add(i, close, width);
    code.fill(1, end, close);
    i = close + width;
  }
  const stack: Array<{ pos: number; marker: string }> = [];
  const active = new Map<string, number>();
  for (let i = 0; i < value.length;) {
    const char = value[i];
    if (removed[i] || code[i] || (char !== '*' && char !== '_') || escaped(i)) { i++; continue; }
    let end = i + 1;
    while (value[end] === char && !removed[end] && !code[end]) end++;
    const width = end - i;
    if (width > 2) return null;
    const marker = char.repeat(width);
    if (active.has(width === 1 ? char.repeat(2) : char)) return null;
    const left = before(value, i); const right = after(value, end);
    if (word(left) && word(right)) { i = end; continue; }
    const leftFlanking = !whitespace(right) &&
      (!punctuation(right) || whitespace(left) || punctuation(left));
    const rightFlanking = !whitespace(left) &&
      (!punctuation(left) || whitespace(right) || punctuation(right));
    // Only equal-width runs are paired below, so their lengths never trigger the rule of three.
    const canOpen = leftFlanking && (char === '*' || !rightFlanking || punctuation(left));
    const canClose = rightFlanking && (char === '*' || !leftFlanking || punctuation(right));
    const top = stack.at(-1);
    if (canClose && top?.marker === marker) {
      if (top.pos + width === i || crossesBoundary(top.pos, i)) return null;
      const inner = value.slice(top.pos + width, i);
      // A single dunder identifier is indistinguishable from Markdown; do not reinterpret it.
      if (marker === '__' && /^[\p{L}\p{M}\p{N}_]+$/u.test(inner)) return null;
      stack.pop(); active.delete(marker); add(top.pos, i, width);
    } else if (canClose && active.has(marker)) {
      return null; // Crossing spans are ambiguous.
    } else if (canOpen) {
      stack.push({ pos: i, marker }); active.set(marker, i);
    } else if (canClose && width === 2) {
      return null;
    }
    i = end;
  }
  if (stack.length) return null;
  let text = '';
  const positions: number[] = [];
  for (let i = 0; i < value.length; i++) if (!removed[i]) { text += value[i]; positions.push(i); }
  return { text, positions, pairs };
}

/** Whole-string lowercasing preserves contextual Unicode rules, including Greek final sigma. */
function normalized(input: VisibleText): VisibleText | null {
  const lowered = input.text.toLocaleLowerCase('en');
  const lowerPositions: number[] = [];
  let source = 0;
  for (const char of input.text) {
    const width = char.toLocaleLowerCase('en').length;
    for (let i = 0; i < width; i++) lowerPositions.push(input.positions[source + Math.min(i, char.length - 1)]);
    source += char.length;
  }
  if (lowerPositions.length !== lowered.length) return null;
  let text = '';
  const positions: number[] = [];
  let pendingSpace = -1;
  for (let i = 0; i < lowered.length; i++) {
    if (/\s/u.test(lowered[i])) { if (text) pendingSpace = lowerPositions[i]; continue; }
    if (pendingSpace >= 0) { text += ' '; positions.push(pendingSpace); pendingSpace = -1; }
    text += lowered[i]; positions.push(lowerPositions[i]);
  }
  return { text, positions, pairs: input.pairs };
}

export function createFormattingMatcher(source: string, whitespace: 'exact' | 'normalized' = 'exact') {
  const transform = (input: VisibleText | null) => input && (whitespace === 'normalized' ? normalized(input) : input);
  const tableContext = hasTableRows(source);
  const body = transform(visible(source, tableContext));
  return (quote: string): string | null => {
    const view = transform(visible(quote, tableContext));
    if (!body || !view || !view.text) return null;
    // This helper is only for matches made possible by removing formatting.
    const legacy = whitespace === 'normalized'
      ? source.toLocaleLowerCase('en').replace(/\s+/g, ' ').trim().includes(
        quote.toLocaleLowerCase('en').replace(/\s+/g, ' ').trim())
      : source.includes(quote);
    if (legacy) return null;
    const needle = view.text;
    let from = 0;
    for (let count = 0; count < MAX_CANDIDATES && from <= body.text.length - needle.length; count++) {
      const at = body.text.indexOf(needle, from);
      if (at < 0) return null;
      const end = at + needle.length;
      from = at + 1;
      if ((word(before(body.text, at)) && word(after(body.text, at))) ||
          (word(before(body.text, end)) && word(after(body.text, end)))) continue;
      let startRaw = body.positions[at];
      let endRaw = body.positions[end - 1] + 1;
      // Expand only over complete adjacent delimiter pairs; the input cap bounds this loop.
      let changed = true;
      while (changed) {
        changed = false;
        for (const pair of body.pairs) {
          if (pair.open + pair.width === startRaw && pair.close >= startRaw && pair.close + pair.width <= endRaw) {
            startRaw = pair.open; changed = true;
          }
          if (pair.close === endRaw && pair.open >= startRaw && pair.open + pair.width <= endRaw) {
            endRaw = pair.close + pair.width; changed = true;
          }
          if (pair.open + pair.width === startRaw && pair.close === endRaw) {
            startRaw = pair.open; endRaw = pair.close + pair.width; changed = true;
          }
        }
      }
      const balanced = body.pairs.every(pair => {
        const hasOpen = pair.open >= startRaw && pair.open + pair.width <= endRaw;
        const hasClose = pair.close >= startRaw && pair.close + pair.width <= endRaw;
        return hasOpen === hasClose;
      });
      const found = source.slice(startRaw, endRaw);
      const foundView = transform(visible(found, tableContext));
      if (balanced && foundView?.text === needle) return found;
    }
    return null;
  };
}
export function formattingQuote(source: string, quote: string, whitespace: 'exact' | 'normalized' = 'exact'):
  string | null {
  return createFormattingMatcher(source, whitespace)(quote);
}
