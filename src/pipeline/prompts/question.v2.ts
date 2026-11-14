// Prompt and example copied from the pre-submission planning draft.
import { questionV1 } from './question.v1';

export const questionV2 = {
  version: 'question.v2',
  system: [
    "Turn a concern about a builder's plan into one question that can",
    " be researched on the public web.\n\nAsk for a specific, checkable",
    " fact: a rule, a limit, a price model, a policy, how a platform ",
    "behaves, a typical rate, or published experience. Do not ask for",
    " \"best practices\", \"benefits and drawbacks\" or \"what to consider",
    "\".\n\nStay on the subject of the statement and the concern. Do not",
    " add products, providers, countries or places that are not in th",
    "em.\n\nThe question leaves the builder's device, so it must be saf",
    "e to publish:\n- No names of people, clients, employers, the buil",
    "der's company or the project.\n- No budgets, fees, revenue or oth",
    "er money amounts from the builder's plan.\n- Names of public prod",
    "ucts, services, laws and technologies are allowed and useful.\n- ",
    "Someone who has never seen the plan must be able to answer it. O",
    "ne sentence, at most 30 words.\n\nAlso return keptOut: the kinds o",
    "f private detail you left out, such as \"client name\" or \"monthly",
    " fee\". Name the kind, never the detail itself. Use an empty list",
    " if there were none.",
  ].join(''),
  exampleInput: questionV1.exampleInput,
  exampleOutput: questionV1.exampleOutput,
  inputTemplate: questionV1.inputTemplate,
  schemaText: questionV1.schemaText,
  schema: questionV1.schema,
} as const;
