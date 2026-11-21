const wordPattern = /[\p{L}\p{M}\p{N}_]+(?:['’\-][\p{L}\p{M}\p{N}_]+)*/gu;

type Token = { word: string; start: number; end: number };
function withoutPossessive(word: string): string {
  return word.replace(/['’]s$/u, '');
}
function tokenize(text: string): Token[] {
  const result: Token[] = [];
  for (const match of text.matchAll(wordPattern)) {
    const start = match.index!;
    result.push({ word: withoutPossessive(match[0]), start, end: start + match[0].length });
  }
  return result;
}
function isCapitalized(word: string): boolean {
  return /^\p{Lu}/u.test(word) && /\p{Ll}/u.test(word) && /^[\p{L}\p{M}]+(?:['’\-][\p{L}\p{M}]+)*$/u.test(word);
}
function containsSequence(haystack: readonly string[], needle: readonly string[]): boolean {
  if (!needle.length || needle.length > haystack.length) return false;
  for (let start = 0; start <= haystack.length - needle.length; start++) {
    let offset = 0;
    while (offset < needle.length && haystack[start + offset] === needle[offset]) offset++;
    if (offset === needle.length) return true;
  }
  return false;
}

/** Local-only warning heuristic; not a complete detector or an approval/privacy boundary. */
export function findPlanNames(outboundText: string, planParagraphTexts: readonly string[]): string[] {
  const tokens = tokenize(outboundText);
  const paragraphs = planParagraphTexts.map(paragraph => tokenize(paragraph).map(token => token.word));
  const found: string[] = [];
  const seen = new Set<string>();
  let run: string[] = [];
  let hasNonInitial = false;
  let previousEnd = 0;
  const finish = () => {
    if (run.length && hasNonInitial && paragraphs.some(paragraph => containsSequence(paragraph, run))) {
      const name = run.join(' ');
      if (!seen.has(name)) { seen.add(name); found.push(name); }
    }
    run = []; hasNonInitial = false;
  };
  tokens.forEach((token, index) => {
    const between = outboundText.slice(previousEnd, token.start);
    if (!isCapitalized(token.word)) { finish(); previousEnd = token.end; return; }
    if (run.length && !/^\s+$/u.test(between)) finish();
    run.push(token.word);
    if (index > 0 && !/[.!?:]\s+$/u.test(between)) hasNonInitial = true;
    previousEnd = token.end;
  });
  finish();
  return found;
}

export function nameWarning(names: readonly string[]): string {
  return names.length === 1 ? `This looks like a name from your plan: ${names[0]}. Edit it out, or send anyway.` :
    `These look like names from your plan: ${names.join(', ')}. Edit them out, or send anyway.`;
}

/** Display-only list cleanup; original records remain untouched. */
export function dedupeKeptOut(values: readonly string[]): string[] {
  const unique = values.filter((value, index) => values.findIndex(other =>
    other.toLocaleLowerCase('en') === value.toLocaleLowerCase('en')) === index);
  const tokens = unique.map(value => tokenize(value.toLocaleLowerCase('en')).map(token => token.word));
  return unique.filter((value, index) => !unique.some((other, otherIndex) => otherIndex !== index &&
    other.length > value.length && containsSequence(tokens[otherIndex], tokens[index])));
}
