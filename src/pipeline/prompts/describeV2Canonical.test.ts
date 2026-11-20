import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { describeV2 } from './describe.v2';

it('pins the canonical description v2 prompt and schema', () => {
  expect(describeV2.version).toBe('describe.v2');
  expect(describeV2.system).toBe([
    "Describe the builder's product idea so it can be researched on the public web.",
    '',
    'You get the opening of the plan and selected statements. In at most 60 words, explain the problem, who has it, ' +
      'and how the product solves it for them. Prioritise the opening and problem-bearing statements. ' +
      'Use only the supplied plan; do not invent features, audiences or claims. Do not judge the idea.',
    '',
    'Leave out implementation details such as frameworks, payment or email providers, hosting and internal ' +
      'processes, ' +
      'unless the idea itself is about them. Leave out names of people, clients, employers, companies and projects, ' +
      'money amounts and other private information. Public product, service, law or technology names may be used ' +
      'only when they are essential to the idea itself.',
    '',
    'Return keptOut as kinds of omitted details, such as "project name" or "payment provider"; never include the ' +
      'private detail itself. Use an empty list if there were none.',
  ].join('\n'));
  expect(createHash('sha256').update(describeV2.system).digest('hex'))
    .toBe('cdda0a465f84f5986534e1e1382ff3fedfdbea7c244163caccece9fe8aabf19d');
  expect(describeV2.schema.required).toEqual(['description', 'keptOut']);
  expect(describeV2.schema.additionalProperties).toBe(false);
});
