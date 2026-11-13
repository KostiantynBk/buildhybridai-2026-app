export function validateNeverSend(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every(term => typeof term === 'string')) throw new Error('Invalid terms.');
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of value as string[]) {
    const term = raw.trim();
    if (!term) continue;
    if (term.length > 100) throw new Error('A term exceeds 100 characters.');
    const key = term.toLocaleLowerCase('en');
    if (!seen.has(key)) { seen.add(key); result.push(term); }
  }
  if (result.length > 200) throw new Error('The list exceeds 200 terms.');
  return result;
}
