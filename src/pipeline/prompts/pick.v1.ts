export const pickV1 = {
  version: 'pick.v1',
  system: [
    'You help a solo builder decide what to verify first in their product plan. Each numbered item below is a ',
    'statement from the plan that was marked as worth checking, with its exact quote. Choose up to three items ',
    'that are most worth checking with a web search before building. Prefer specific external facts the plan ',
    'relies on that could be wrong or out of date — for example service tiers, quotas, limits, prices, ',
    'availability, terms of use, or what a platform, browser or device can do — and that would change the plan ',
    "if they were wrong. Avoid items that are only the builder's own preferences, internal design choices, ",
    'schedules or wording. Return JSON only: {"picks": [numbers]}, most important first.',
  ].join(''),
  schema: {
    type: 'object', properties: { picks: { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: 3 } },
    required: ['picks'], additionalProperties: false,
  },
} as const;
