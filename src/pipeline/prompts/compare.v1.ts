// Prompt and example copied from the pre-submission planning draft.
const schemaText = [
  '{\n  "type": "object",\n  "properties": {\n    "status": { "type": "strin',
  'g", "enum": ["unchanged", "changed", "removed"] },\n    "newQuote": { "',
  'type": "string" }\n  },\n  "required": ["status", "newQuote"],\n  "additi',
  'onalProperties": false\n}',
].join('');
export const compareV1 = {
  version: 'compare.v1',
  system: [
    'A builder edited a paragraph of their plan. Decide what happened to on',
    'e earlier statement.\n\nstatus:\n- "unchanged": the new paragraph still s',
    'ays the same thing, even if the wording differs.\n- "changed": the new ',
    'paragraph says something different about the same subject (another pro',
    'vider, number, plan, method or choice).\n- "removed": the new paragraph',
    ' no longer talks about that subject.\n\nIf status is "changed", newQuote',
    ' is the exact words from the new paragraph that replace it. Otherwise ',
    'newQuote is "".\nJudge only this one statement. Ignore edits to other s',
    'entences.',
  ].join(''),
  exampleInput: [
    'Earlier statement: The object storage free tier gives 10 GB with no ti',
    'me limit.\nEarlier words: "the object storage free tier, which I think ',
    'gives 10 GB forever"\nNew paragraph:\nUsers upload up to 20 photos per l',
    "isting. I'll pay for the 100 GB storage plan from day one so I never h",
    'it a wall. Resize on the client so the server stays cheap.',
  ].join(''),
  exampleOutput: [
    '{"status":"changed","newQuote":"I\'ll pay for the 100 GB storage plan f',
    'rom day one"}',
  ].join(''),
  inputTemplate: [
    'Earlier statement: {item.text}\nEarlier words: "{item.quote}"\nNew parag',
    'raph:\n{paragraph}',
  ].join(''),
  schemaText,
  schema: JSON.parse(schemaText) as object,
} as const;
