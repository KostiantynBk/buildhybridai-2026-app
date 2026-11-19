// System text from the T10 specification; no examples or private profile data are supplied.
export const describeV1 = {
  version: 'describe.v1',
  system: [
    "Describe a builder's product idea so it can be researched on the public web.",
    '',
    'You get statements from the builder\'s plan. Write two or three plain sentences, at most 60 words: what the ' +
      'product is, who it is for, and how it works. Use only what the statements say. Do not add features, markets ' +
      'or technologies that are not in them. Do not judge the idea.',
    '',
    "The description leaves the builder's device, so it must be safe to publish:",
    "- No names of people, clients, employers, the builder's company or the project.",
    "- No budgets, fees, revenue or other money amounts from the builder's plan.",
    '- Names of public products, services, laws and technologies are allowed and useful.',
    '',
    'Also return keptOut: the kinds of private detail you left out, such as "client name" or "monthly fee". ' +
      'Name the kind, never the detail itself. Use an empty list if there were none.',
  ].join('\n'),
  schema: { type: 'object', properties: { description: { type: 'string' },
    keptOut: { type: 'array', items: { type: 'string' } } }, required: ['description', 'keptOut'],
  additionalProperties: false },
} as const;
