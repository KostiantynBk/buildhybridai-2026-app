import type { ResearchResult } from './cloudResearch';

export function isGrounded(result: ResearchResult): boolean {
  return !!result.suggestions || !!result.grounded || result.sources.length > 0 || result.supports.length > 0;
}
// Shadow DOM isolates styles, not scripts; never rewrite Google's HTML, reject unsafe input instead.
export function safeSuggestions(html: string): boolean {
  if (!html || typeof DOMParser === 'undefined') return false;
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    if (doc.querySelector('script, iframe, object, embed, base, meta, link, math, form, foreignObject, use')) {
      return false;
    }
    const svgTags = new Set(['svg', 'path', 'g', 'rect', 'circle', 'defs', 'lineargradient', 'stop',
      'ellipse', 'polygon', 'polyline', 'line', 'clippath', 'title', 'desc', 'radialgradient']);
    for (const element of doc.querySelectorAll('*')) {
      const inSvg = element.namespaceURI === 'http://www.w3.org/2000/svg';
      if (inSvg && !svgTags.has(element.localName.toLowerCase())) return false;
      for (const attribute of element.attributes) {
        const name = attribute.name.toLowerCase();
        if (name.startsWith('on') || name === 'srcdoc') return false;
        if (inSvg && (name === 'href' || name === 'xlink:href')) return false;
        if (name === 'href' && element.localName.toLowerCase() === 'a') {
          if (new URL(attribute.value).protocol !== 'https:') return false;
        } else if (['href', 'xlink:href', 'src', 'action'].includes(name)) return false;
      }
    }
    return true;
  } catch { return false; }
}
