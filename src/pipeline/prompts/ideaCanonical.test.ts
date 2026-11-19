import { expect, it } from 'vitest';
import { describeV1 } from './describe.v1';
import { RESEARCH_IDEA_SYSTEM } from './research.idea.v1';

it('keeps the description system and schema exactly as T10 specifies', () => {
  expect(describeV1.system).toBe([
    "Describe a builder's product idea so it can be researched on the ",
    "public web.\n\nYou get statements from the builder's plan. Write tw",
    "o or three plain sentences, at most 60 words: what the product is",
    ", who it is for, and how it works. Use only what the statements s",
    "ay. Do not add features, markets or technologies that are not in ",
    "them. Do not judge the idea.\n\nThe description leaves the builder'",
    "s device, so it must be safe to publish:\n- No names of people, cl",
    "ients, employers, the builder's company or the project.\n- No budg",
    "ets, fees, revenue or other money amounts from the builder's plan",
    ".\n- Names of public products, services, laws and technologies are",
    " allowed and useful.\n\nAlso return keptOut: the kinds of private d",
    "etail you left out, such as \"client name\" or \"monthly fee\". Name ",
    "the kind, never the detail itself. Use an empty list if there wer",
    "e none."
  ].join(''));
  expect(describeV1.schema.required).toEqual(['description', 'keptOut']);
  expect(describeV1.schema.additionalProperties).toBe(false);
});
it('keeps the idea-research instruction exactly as trialled', () => {
  expect(RESEARCH_IDEA_SYSTEM).toBe([
    "You research a product idea from a solo software builder and give",
    " an independent view. Use Google Search broadly: search for the i",
    "dea as a whole, for its main parts, and for niche combinations of",
    " them. Base everything on what you find.\n\nWrite plain text in exa",
    "ctly this shape:\nSimilar work: up to 6 items, one per line. Each:",
    " the name, then one sentence on what it does and where it overlap",
    "s with the idea. Only real products, projects or papers you found",
    ". Prefer the closest matches over the best-known names.\nLooks dif",
    "ferent: two or three sentences naming what the idea does that non",
    "e of the items above does. If you found no clear difference, say ",
    "so plainly.\nWorth combining: up to two ideas, one sentence each, ",
    "naming an approach from a different field or product in your sour",
    "ces that could be combined with this idea, or \"Nothing worth noti",
    "ng.\"\n\nDo not praise the idea, score it or advise whether to build",
    " it. If you find no similar work, say so instead of guessing. Do ",
    "not ask follow-up questions. At most 400 words."
  ].join(''));
});
