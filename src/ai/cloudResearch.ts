import { getGenerativeModel, InferenceMode } from 'firebase/ai';
import type { AppConfig } from '../config';
import { firebaseAI } from './firebase';
import { isGrounded, safeSuggestions } from './suggestionsSafety';
export { isGrounded, safeSuggestions } from './suggestionsSafety';

// research.v2, frozen in hackathon-entry/test-plan/prompts.md §6b.
export const RESEARCH_SYSTEM =
  "You answer one practical question from a solo software builder who is planning a product" +
  ". Use Google Search and base the answer on what you find.\n\nWrite plain text in exactly t" +
  "his shape:\nAnswer: 2 to 4 sentences with the specific facts (numbers, limits, prices, ru" +
  "les, dates). Write \"as of <month year>\" for anything that changes over time.\nCheck yours" +
  "elf: one sentence naming what the builder should confirm on the official page, because i" +
  "t may have changed or may depend on their case.\nAlso worth knowing: one sentence from yo" +
  "ur sources that the question did not ask about. Either a specific related fact that peop" +
  "le in this situation often miss, or how a named product, team or community handled the s" +
  "ame situation, whichever is more useful. Write \"Nothing else worth noting.\" if there is " +
  "neither.\n\nIf sources disagree or you cannot find a reliable answer, say so plainly inste" +
  "ad of guessing. Do not suggest replacing a choice the question takes as given. Do not as" +
  "k follow-up questions. At most 140 words.";

export type ResearchSource = { uri: string; title: string };
export type ResearchSupport = { partIndex: number; startIndex: number; endIndex: number; indices: number[] };
export type ResearchResult = {
  text: string; parts: string[]; sources: Array<ResearchSource | null>; supports: ResearchSupport[];
  suggestions: string; grounded?: boolean;
};
export type CloudReply = { source?: string; result: ResearchResult };
export type CloudAdapter = (question: string, model: string) => Promise<CloudReply>;

export function createCloudAdapter(config: AppConfig): CloudAdapter {
  return async (question, model) => {
    const generator = getGenerativeModel(firebaseAI(config), {
      mode: InferenceMode.ONLY_IN_CLOUD,
      inCloudParams: { model, systemInstruction: RESEARCH_SYSTEM, tools: [{ googleSearch: {} }] },
    });
    const response = (await generator.generateContent(question)).response;
    const candidate = response.candidates?.[0];
    const metadata = candidate?.groundingMetadata;
    const parts = (candidate?.content?.parts ?? []).map(part =>
      'text' in part && !('thought' in part && part.thought) ? part.text ?? '' : '');
    return { source: response.inferenceSource, result: {
      text: response.text(), parts,
      sources: (metadata?.groundingChunks ?? []).map(chunk => chunk.web?.uri ? {
        uri: chunk.web.uri, title: chunk.web.title ?? chunk.web.uri,
      } : null),
      supports: (metadata?.groundingSupports ?? []).flatMap(support => support.segment ? [{
        partIndex: support.segment.partIndex, startIndex: support.segment.startIndex,
        endIndex: support.segment.endIndex, indices: support.groundingChunkIndices ?? [],
      }] : []),
      suggestions: metadata?.searchEntryPoint?.renderedContent ?? '',
      grounded: !!(metadata?.groundingChunks?.length || metadata?.groundingSupports?.length ||
        metadata?.searchEntryPoint?.renderedContent),
    } };
  };
}

export async function sendChecked(
  adapter: CloudAdapter, question: string, model: string,
): Promise<ResearchResult> {
  const reply = await adapter(question, model);
  if (reply.source !== 'in_cloud') throw new Error('Cloud research did not run in the cloud.');
  if (!reply.result.text || (isGrounded(reply.result) && !reply.result.suggestions) ||
      (!!reply.result.suggestions && !safeSuggestions(reply.result.suggestions))) {
    throw new Error('Research could not be displayed with its required Search sources and suggestions.');
  }
  return reply.result;
}
