import type { Job } from '../ai/localModel';
import { extractV1 } from './prompts/extract.v1';
import { extractV2 } from './prompts/extract.v2';
import { bindTemplate } from './bindTemplate';
import { extractionParts } from '../structure/planStructure';
import { LocalError } from '../ai/localModel';
import { createFormattingMatcher, supportsFormattingRecovery } from './formatQuote';

export type Item = { kind: string; text: string; quote: string; topics: string[] };
export type Extraction = { items: Item[] };
export type LocalRunner = <T>(job: Job<T>) => Promise<{
  data: T;
  latencyMs: number;
  source: string;
  raw: string;
}>;
export const extractionPrompts = { 'extract.v1': extractV1, 'extract.v2': extractV2 } as const;
export type ExtractVersion = keyof typeof extractionPrompts;
export const extractVersion = extractV1.version;
export const normalizeQuote = (value: string) =>
  value.toLocaleLowerCase('en').replace(/\s+/g, ' ').trim();
export function extractInput(title: string, paragraph: string): string {
  return bindTemplate(extractV1.inputTemplate, { '{title}': title, '{paragraph}': paragraph });
}
export async function extractStructured(
  runner: LocalRunner, title: string, paragraph: string, signal?: AbortSignal,
  version: ExtractVersion = 'extract.v1', split = true,
) {
  const units = split && version === 'extract.v2' ? extractionParts(paragraph) :
    [{ input: paragraph, quoteSource: paragraph }];
  if (units.length === 1) return extract(runner, title, paragraph, signal, version);
  const seen = new Set<string>();
  const items: Item[] = [];
  let source: string | undefined;
  for (const unit of units) {
    if (signal?.aborted) throw new LocalError('cancelled', 'Cancelled before dispatch.');
    const result = await extract(runner, title, unit.input, signal, version, paragraph, unit.quoteSource);
    if (source !== undefined && source !== result.source) {
      throw new LocalError('privacy-fault', 'Extraction sources did not match.');
    }
    source = result.source;
    for (const item of result.items) {
      const quote = normalizeQuote(item.quote);
      if (!paragraph.includes(item.quote) || seen.has(quote)) continue;
      seen.add(quote); items.push(item);
    }
  }
  return { items, source: source ?? '' };
}

export async function extract(
  runner: LocalRunner,
  title: string,
  paragraph: string,
  signal?: AbortSignal,
  version: ExtractVersion = 'extract.v1',
  exactParagraph?: string,
  quoteSource = paragraph,
) {
  const prompt = extractInput(title, paragraph);
  const definition = extractionPrompts[version];
  const response = await runner<Extraction>({
    prompt,
    schema: extractV1.schema,
    instructions: definition,
    signal,
  });
  const seen = new Set<string>();
  const items: Item[] = [];
  let quoteExact = 0;
  let droppedBadQuotes = 0;
  let droppedDuplicates = 0;
  const recover = supportsFormattingRecovery(exactParagraph ?? paragraph)
    ? createFormattingMatcher(quoteSource, exactParagraph === undefined ? 'normalized' : 'exact') : () => null;
  for (const item of response.data.items) {
    if (item.quote && paragraph.includes(item.quote)) {
      quoteExact++;
    }
    const normalized = normalizeQuote(item.quote);
    const legacyMatch = Boolean(normalized) && normalizeQuote(paragraph).includes(normalized) &&
      (exactParagraph === undefined || (quoteSource.includes(item.quote) && exactParagraph.includes(item.quote)));
    const mapped = legacyMatch ? item.quote : recover(item.quote);
    if (!mapped || (!legacyMatch && !(exactParagraph ?? paragraph).includes(mapped))) {
      droppedBadQuotes++;
      continue;
    }
    const key = normalizeQuote(mapped);
    if (seen.has(key)) {
      droppedDuplicates++;
      continue;
    }
    seen.add(key);
    items.push({ ...item, quote: mapped, topics: item.topics.length ? item.topics : ['other'] });
  }
  return {
    ...response,
    promptVersion: version,
    prompt,
    items,
    beforeDrop: response.data.items.length,
    quoteExact,
    droppedBadQuotes,
    droppedDuplicates,
  };
}
