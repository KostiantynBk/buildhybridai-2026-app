import { expect, it } from 'vitest';
import { dedupeKeptOut, findPlanNames, nameWarning } from './planNames';
import { samplePlan } from './samplePlan';

it('flags the live sample case and a multiword name at the start of a sentence', () => {
  expect(findPlanNames('Restaurants, like Osteria Lunetta, can accept reservations.', samplePlan))
    .toEqual(['Osteria Lunetta']);
  expect(findPlanNames('Osteria Lunetta offers bookings.', samplePlan)).toEqual(['Osteria Lunetta']);
  expect(findPlanNames('Small restaurants need bookings.', samplePlan)).toEqual([]);
});
it('strips possessives and excludes names absent from the plan and all-caps tokens', () => {
  const plan = ["Paolo's restaurant uses an API and operates near Instagram."];
  expect(findPlanNames("Please ask Paolo's restaurant about this.", plan)).toEqual(['Paolo']);
  expect(findPlanNames('Ask Unknown about the API.', plan)).toEqual([]);
  expect(findPlanNames('Use the Instagram option.', plan)).toEqual(['Instagram']);
  expect(findPlanNames('Ask about Paolo and Paolo again.', plan)).toEqual(['Paolo']);
  expect(findPlanNames("Please visit James's Café today.", ["James's Café opens today."]))
    .toEqual(['James Café']);
});
it('matches Unicode names, case-sensitive whole words and paragraph boundaries', () => {
  expect(findPlanNames('Please try Café Ñandú for guests.', ['Visit Café Ñandú today.'])).toEqual(['Café Ñandú']);
  expect(findPlanNames('Please try Café Ñandú for guests.', ['Visit café Ñandú today.'])).toEqual([]);
  expect(findPlanNames('Ask Paolo today.', ['Paoloni is here.'])).toEqual([]);
  expect(findPlanNames('Try Café Ñandú today.', ['Café', 'Ñandú'])).toEqual([]);
});
it('matches complete compound tokens and finds overlapping sequences', () => {
  for (const plan of ['Paolo-Rossi', 'Gianni-Paolo', "D'Paolo", 'Paolo’Rossi']) {
    expect(findPlanNames('Please ask Paolo today.', [plan])).toEqual([]);
  }
  expect(findPlanNames('Please ask Paolo-Rossi today.', ['Paolo-Rossi is here.'])).toEqual(['Paolo-Rossi']);
  expect(findPlanNames('Please ask Mina Rosa today.', ['Mina Rosa-Lee is here.'])).toEqual([]);
  expect(findPlanNames('Please ask Rosa Rosa today.', ['xRosa Rosa Rosa arrived.'])).toEqual(['Rosa Rosa']);
  expect(dedupeKeptOut(['Café', 'Café-Nord'])).toEqual(['Café', 'Café-Nord']);
  expect(dedupeKeptOut(['Paolo', 'Paolo’s'])).toEqual(['Paolo’s']);
});
it('handles long capitalized runs and many overlapping near-matches iteratively', () => {
  const long = Array(8192).fill('Rosa').join(' ');
  expect(findPlanNames(`Please consider ${long} today.`, ['A short fictional plan.'])).toEqual([]);
  expect(findPlanNames(`Please consider ${long} today.`, [long])).toEqual([long]);
  const nearMatches = Array(30000).fill('xRosa Rosa').join(' ');
  expect(findPlanNames('Please ask Rosa Rosa today.', [`${nearMatches} Rosa Rosa`])).toEqual(['Rosa Rosa']);
});
it('treats a colon followed by whitespace as a sentence start', () => {
  const plan = ['Paolo and Osteria Lunetta are mentioned.'];
  expect(findPlanNames('Consider: Paolo has an idea.', plan)).toEqual([]);
  expect(findPlanNames('Consider: Osteria Lunetta has an idea.', plan)).toEqual(['Osteria Lunetta']);
  expect(findPlanNames('Consider:Paolo has an idea.', plan)).toEqual(['Paolo']);
});
it('formats singular and plural warnings and deduplicates kept-out display only', () => {
  expect(nameWarning(['Paolo'])).toBe('This looks like a name from your plan: Paolo. Edit it out, or send anyway.');
  expect(nameWarning(['Paolo', 'Café'])).toBe(
    'These look like names from your plan: Paolo, Café. Edit them out, or send anyway.');
  const values = ['Stripe', 'stripe', 'Stripe account', 'CLIENT', 'client', 'Accountant'];
  expect(dedupeKeptOut(values)).toEqual(['Stripe account', 'CLIENT', 'Accountant']);
  expect(values).toEqual(['Stripe', 'stripe', 'Stripe account', 'CLIENT', 'client', 'Accountant']);
});
