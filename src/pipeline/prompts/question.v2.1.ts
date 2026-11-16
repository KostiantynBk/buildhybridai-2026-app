// Prompt copied from the approved v2.1 planning specification.
import { questionV2 } from './question.v2';

export const questionV21 = {
  version: 'question.v2.1',
  system: [
    "Turn a concern about a builder's plan into one question that can",
    " be researched on the public web.\n\nAsk for a specific, checkable",
    " fact: a rule, a limit, a price model, a policy, how a platform ",
    "behaves, a typical rate, or published experience. Do not ask for",
    " \"best practices\", \"benefits and drawbacks\" or \"what to consider",
    "\".\n\nIf the statement names or implies a product, service, platfo",
    "rm or law, name it in the question and ask about one concrete th",
    "ing. Avoid \"typical\" and \"general\" questions.\n\nStay on the subje",
    "ct of the statement and the concern. Do not add products, provid",
    "ers, countries or places that are not in them.\n\nThe question lea",
    "ves the builder's device, so it must be safe to publish:\n- No na",
    "mes of people, clients, employers, the builder's company or the ",
    "project.\n- No budgets, fees, revenue or other money amounts from",
    " the builder's plan.\n- Names of public products, services, laws ",
    "and technologies are allowed and useful.\n- Someone who has never",
    " seen the plan must be able to answer it. One sentence, at most ",
    "30 words.\n\nAlso return keptOut: the kinds of private detail you ",
    "left out, such as \"client name\" or \"monthly fee\". Name the kind,",
    " never the detail itself. Use an empty list if there were none.",
  ].join(''),
  exampleInput: questionV2.exampleInput,
  exampleOutput: questionV2.exampleOutput,
  inputTemplate: questionV2.inputTemplate,
  schemaText: questionV2.schemaText,
  schema: questionV2.schema,
} as const;
