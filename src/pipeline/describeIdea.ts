import { LocalError, type Job } from '../ai/localModel';
import { describeV1 } from './prompts/describe.v1';
import { describeV2 } from './prompts/describe.v2';

type Description = { description: string; keptOut: string[] };
export const IDEA_DRAFT_HINT = 'Describe your idea in two or three sentences: what it is, who it is for, how it works.';
export async function describeIdea(run: <T>(job: Job<T>) => Promise<{ data: T; source: string }>,
  statements: string[], mode: 'on_device' | 'in_cloud', signal?: AbortSignal, onDispatch?: () => void,
  opening?: string, version: 'describe.v1' | 'describe.v2' = 'describe.v1'):
  Promise<{ description: string; keptOut: string[]; source?: string }> {
  try {
    const instructions = version === 'describe.v2' ? describeV2 : describeV1;
    const lines = statements.map((text, index) => `${index + 1}. ${text}`).join('\n');
    const prompt = version === 'describe.v2'
      ? `Plan opening:\n${opening ?? ''}\n\nSelected statements:\n${lines}` : lines;
    const result = await run<Description>({ prompt,
      schema: instructions.schema, instructions, requiredMode: mode, signal, onDispatch });
    if (result.source !== mode) throw new LocalError('privacy-fault', 'Description source was not verified.');
    if (typeof result.data?.description !== 'string' || !Array.isArray(result.data.keptOut) ||
        !result.data.keptOut.every(value => typeof value === 'string')) return { description: '', keptOut: [] };
    const count = result.data.description.trim().split(/\s+/).filter(Boolean).length;
    return count >= 8 && count <= 60 ? { ...result.data, source: result.source } :
      { description: '', keptOut: [], source: result.source };
  } catch (error) {
    if (error instanceof LocalError && error.code === 'invalid-output') return { description: '', keptOut: [] };
    throw error;
  }
}
