import { useEffect, useRef } from 'react';
import type { ResearchResult } from '../ai/cloudResearch';
import { safeSuggestions } from '../ai/suggestionsSafety';

function safeSourceUrl(uri: string): boolean {
  try { return ['https:', 'http:'].includes(new URL(uri).protocol); } catch { return false; }
}

type Citation = { end: number; indices: number[] };
// Segment offsets are UTF-8 bytes within the individual response part, not UTF-16 offsets.
function citations(result: ResearchResult): Citation[] {
  if (result.parts.join('') !== result.text) return [];
  const encoder = new TextEncoder();
  const output: Citation[] = [];
  let prefix = 0;
  result.parts.forEach((part, partIndex) => {
    const boundaries = new Map<number, number>([[0, 0]]);
    let bytes = 0;
    let units = 0;
    for (const point of part) {
      bytes += encoder.encode(point).length;
      units += point.length;
      boundaries.set(bytes, units);
    }
    for (const support of result.supports) {
      if (support.partIndex !== partIndex || support.startIndex < 0 || support.startIndex > support.endIndex ||
          !boundaries.has(support.startIndex) || !boundaries.has(support.endIndex)) continue;
      const indices = support.indices.filter(index => Number.isInteger(index) && !!result.sources[index]);
      if (indices.length) output.push({ end: prefix + boundaries.get(support.endIndex)!, indices });
    }
    prefix += part.length;
  });
  return output.sort((a, b) => a.end - b.end);
}
export function mountSuggestions(host: HTMLDivElement, html: string): () => void {
  if (!safeSuggestions(html)) return () => {};
  const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  root.innerHTML = html;
  return () => { root.replaceChildren(); };
}
function Suggestions({ html }: { html: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    return mountSuggestions(host.current, html);
  }, [html]);
  return <div ref={host} style={{ width: '100%' }} />;
}
export function ResearchBlock({ result }: { result: ResearchResult }) {
  const links = citations(result);
  let previous = 0;
  return <div className="research-result">
    <div style={{ whiteSpace: 'pre-wrap' }}>{links.map((citation, index) => {
      const text = result.text.slice(previous, citation.end);
      previous = citation.end;
      return <span key={index}>{text}{citation.indices.map((sourceIndex, i) => {
        const source = result.sources[sourceIndex]!;
        return safeSourceUrl(source.uri) ? <sup key={`${sourceIndex}-${i}`}>
          <a href={source.uri} target="_blank" rel="noreferrer">[{sourceIndex + 1}]</a></sup> : null;
      })}</span>;
    })}{result.text.slice(previous)}</div>
    <ol>{result.sources.map((source, index) => source && safeSourceUrl(source.uri) ? <li key={index} value={index + 1}>
      <a href={source.uri} target="_blank" rel="noreferrer">{source.title}</a></li> : null)}</ol>
    {result.suggestions && <Suggestions html={result.suggestions} />}
  </div>;
}
