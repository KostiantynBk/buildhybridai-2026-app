import type { Paragraph } from '../store/matcher';

/** A heading must be the only line in the block. */
export function isHeadingBlock(text: string): boolean {
  return /^#{1,6}[ \t]+[^\r\n]*\S[^\r\n]*$/u.test(text.trim());
}
export function headingText(text: string): string {
  return text.trim().replace(/^#{1,6}[ \t]+/u, '');
}
function labelText(text: string): string {
  return text.split(/\r?\n/u).filter(line => {
    const cells = tableCells(line);
    return !cells || !cells.every(cell => /^:?-+:?$/u.test(cell));
  }).join(' ').replace(/\|/gu, ' ').replace(/\*\*|__|`/gu, '')
    .replace(/(^|[^\p{L}\p{N}])[*_](?=\S)|(?<=\S)[*_](?=$|[^\p{L}\p{N}])/gu, '$1')
    .replace(/\s+/gu, ' ').trim();
}
export function paragraphLabel(paragraph: Paragraph, paragraphs: readonly Paragraph[]): string {
  const ordered = [...paragraphs].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const position = ordered.findIndex(value => value.id === paragraph.id);
  const heading = ordered.slice(0, Math.max(0, position)).reverse().find(value => isHeadingBlock(value.text));
  const words = labelText(paragraph.text).split(/\s+/u).filter(Boolean);
  const preview = words.slice(0, 8).join(' ') + (words.length > 8 ? '…' : '');
  return heading ? `Under “${labelText(headingText(heading.text))}”: “${preview}”` : `“${preview}”`;
}

export function extractionEligible(text: string, mode: 'on_device' | 'in_cloud',
  version: 'extract.v1' | 'extract.v2', minimumWords: number): boolean {
  const words = text.trim() ? text.trim().split(/\s+/u).length : 0;
  return !isHeadingBlock(text) && (words >= minimumWords ||
    (mode === 'on_device' && version === 'extract.v2' && extractionUnits(text).length > 1));
}

function tableCells(line: string): string[] | undefined {
  const value = line.trim();
  const cells: string[] = [];
  let cell = '';
  let hadPipe = false;
  let endsWithDelimiter = false;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '\\' && i + 1 < value.length) { cell += value[i] + value[++i]; continue; }
    if (value[i] === '|') {
      hadPipe = true; endsWithDelimiter = i === value.length - 1; cells.push(cell.trim()); cell = '';
    }
    else cell += value[i];
  }
  cells.push(cell.trim());
  if (!hadPipe) return undefined;
  if (value.startsWith('|')) cells.shift();
  if (endsWithDelimiter) cells.pop();
  return cells.length ? cells : undefined;
}

export type ExtractionUnit = { input: string; quoteSource: string };
/** Returns row inputs and their permissible quote sources; plain prose remains one input. */
export function extractionParts(text: string): ExtractionUnit[] {
  const lines = text.split(/\r?\n/u);
  const nonempty = lines.filter(line => line.trim());
  const header = nonempty.length >= 4 ? tableCells(nonempty[0]) : undefined;
  const delimiter = header ? tableCells(nonempty[1]) : undefined;
  const rows = delimiter ? nonempty.slice(2).map(tableCells) : [];
  if (header && delimiter && header.length === delimiter.length &&
      delimiter.every(cell => /^:?-+:?$/u.test(cell)) &&
      rows.every(cells => cells && cells.length === header.length)) {
    return nonempty.slice(2).map(row => {
      const input = `${nonempty[0]}\n${row}`;
      return { input, quoteSource: input };
    });
  }
  const listStart = /^\s*(?:[-+*]|\d+[.)])[ \t]+\S/u;
  const first = lines.findIndex(line => listStart.test(line));
  if (first >= 0 && lines.slice(0, first).every(line => !listStart.test(line))) {
    const items: string[] = [];
    let current = '';
    for (const line of lines.slice(first)) {
      if (listStart.test(line)) {
        if (current) items.push(current);
        current = line;
      } else if (/^\s+\S/u.test(line) && current) current += `\n${line}`;
      else return [{ input: text, quoteSource: text }];
    }
    if (current) items.push(current);
    if (items.length >= 3) {
      const context = lines.slice(0, first).join('\n');
      return items.map(item => ({ input: context ? `${context}\n${item}` : item, quoteSource: item }));
    }
  }
  return [{ input: text, quoteSource: text }];
}
export function extractionUnits(text: string): string[] {
  return extractionParts(text).map(unit => unit.input);
}
