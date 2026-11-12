// Replace only placeholders in the original template; inserted values are never scanned again.
export function bindTemplate(template: string, fields: Record<string, string>): string {
  const keys = Object.keys(fields)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (!keys.length) return template;
  const pattern = new RegExp(
    keys.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
    'g',
  );
  return template.replace(pattern, (key) => fields[key]);
}
