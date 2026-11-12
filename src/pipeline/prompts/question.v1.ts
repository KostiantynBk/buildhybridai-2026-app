// Prompt and example copied from the pre-submission planning draft.
const schemaText = [
  '{\n  "type": "object",\n  "properties": {\n    "question": { "type": "str',
  'ing" },\n    "keptOut": { "type": "array", "maxItems": 4, "items": { "t',
  'ype": "string" } }\n  },\n  "required": ["question", "keptOut"],\n  "addi',
  'tionalProperties": false\n}',
].join('');
export const questionV1 = {
  version: 'question.v1',
  system: [
    "Turn a concern about a builder's plan into one question that can be re",
    "searched on the public web.\n\nThe question leaves the builder's device,",
    ' so it must be safe to publish:\n- No names of people, clients, employe',
    "rs, the builder's company or the project.\n- No budgets, fees, revenue ",
    "or other money amounts from the builder's plan.\n- Names of public prod",
    'ucts, services, laws and technologies are allowed and useful.\n- Someon',
    'e who has never seen the plan must be able to answer it. One sentence,',
    ' at most 30 words.\n\nAlso return keptOut: the kinds of private detail y',
    'ou left out, such as "client name" or "monthly fee". Name the kind, ne',
    'ver the detail itself. Use an empty list if there were none.',
  ].join(''),
  exampleInput: [
    "Statement: The client's monthly fee covers the cost of SMS reminders.\n",
    'Their words: "Marrowfield Vets pays \u20ac400 a month, that covers the text',
    's"\nAngle: cost-at-scale\nConcern: The cost per SMS may grow past the fi',
    'xed monthly fee as the number of appointments rises.',
  ].join(''),
  exampleOutput: [
    '{"question":"How much do appointment reminder SMS messages cost per me',
    'ssage in Europe, and how does the total grow with volume?","keptOut":[',
    '"client name","monthly fee"]}',
  ].join(''),
  inputTemplate: [
    'Statement: {item.text}\nTheir words: "{item.quote}"\nAngle: {angle}\nConc',
    'ern: {concern}',
  ].join(''),
  schemaText,
  schema: JSON.parse(schemaText) as object,
} as const;
