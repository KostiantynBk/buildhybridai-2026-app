export type LeakReason = 'currency' | 'email' | 'url' | 'listed-term' | 'private-token';
export interface LeakResult { passed: boolean; reasons: LeakReason[] }
const currency = /(?:[€$£¥]\s*\d|\d[\d.,]*\s*(?:eur|euros?|usd|dollars?|gbp|pounds?)\b|\b(?:eur|usd|gbp)\s*\d)/i;
const email = /\b[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/i;
const url = /\b(?:https?:\/\/|www\.)\S+|\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?!js\b)[a-z]{2,}(?:[/?#]\S*)?/i;
function matchesTerm(text: string, terms: readonly string[]): boolean {
  const lower = text.toLocaleLowerCase('en');
  return terms.some(term => {
    const normalized = term.trim().toLocaleLowerCase('en');
    return normalized.length > 0 && lower.includes(normalized);
  });
}
export function filterQuestion(question: string, neverSend: readonly string[], privateTokens: readonly string[] = []):
  LeakResult {
  const reasons: LeakReason[] = [];
  if (currency.test(question)) reasons.push('currency');
  if (email.test(question)) reasons.push('email');
  if (url.test(question)) reasons.push('url');
  if (matchesTerm(question, neverSend)) reasons.push('listed-term');
  if (matchesTerm(question, privateTokens)) reasons.push('private-token');
  return { passed: reasons.length === 0, reasons };
}
