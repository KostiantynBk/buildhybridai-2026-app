import { LocalError } from '../ai/localModel';
import { normalizeQuote, type LocalRunner } from './extract';
import { bindTemplate } from './bindTemplate';
import { compareV1 } from './prompts/compare.v1';

export type ComparisonStatus = 'unchanged' | 'changed' | 'removed';
export interface Comparison {
  status: ComparisonStatus;
  newQuote: string;
  newQuoteFound: boolean | null;
  needsConfirmation: boolean;
  source: 'code' | 'on_device' | 'in_cloud';
  latencyMs: number;
  promptVersion: 'compare.v1';
}
export function containsQuote(paragraph: string, quote: string): boolean {
  const normalized = normalizeQuote(quote);
  return Boolean(normalized) && normalizeQuote(paragraph).includes(normalized);
}
export async function compare(
  runner: LocalRunner, item: { text: string; quote: string }, paragraph: string, signal?: AbortSignal,
  onDispatch?: () => void, expectedSource: 'on_device' | 'in_cloud' = 'on_device',
): Promise<Comparison> {
  if (containsQuote(paragraph, item.quote)) return { status: 'unchanged', newQuote: '', newQuoteFound: null,
    needsConfirmation: false, source: 'code', latencyMs: 0, promptVersion: 'compare.v1' };
  const prompt = bindTemplate(compareV1.inputTemplate, {
    '{item.text}': item.text, '{item.quote}': item.quote, '{paragraph}': paragraph,
  });
  const result = await runner<{ status: ComparisonStatus; newQuote: string }>({
    prompt, schema: compareV1.schema, instructions: compareV1, signal, onDispatch,
  });
  if (result.source !== expectedSource) throw new LocalError('privacy-fault', 'Comparison source was not verified.');
  const found = result.data.status === 'changed' ? containsQuote(paragraph, result.data.newQuote) : null;
  return { status: result.data.status, newQuote: result.data.newQuote, newQuoteFound: found,
    needsConfirmation: result.data.status === 'changed' && !found, source: expectedSource,
    latencyMs: result.latencyMs, promptVersion: 'compare.v1' };
}
