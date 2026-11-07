/**
 * Split the single rich SVG produced by the Typst compiler into one
 * self-contained SVG per page.
 *
 * A per-page SVG is much easier to lay out (page cards, overlays, zoom) than
 * one tall SVG, but glyph outlines live in a shared `<defs>` block, so every
 * page SVG repeats the defs and gets its ids prefixed to avoid collisions in
 * the host document.
 */

export interface SvgPage {
  index: number;
  widthPt: number;
  heightPt: number;
  svg: string;
}

/** Find the `>` that closes the tag starting at `start`, honouring quotes. */
function findTagEnd(svg: string, start: number): number {
  let quote: string | null = null;
  for (let i = start; i < svg.length; i++) {
    const ch = svg[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '>') return i;
  }
  return svg.length - 1;
}

/** Split the children of the root `<svg>` element into their raw markup. */
function topLevelChildren(inner: string): string[] {
  const children: string[] = [];
  let i = 0;
  let depth = 0;
  let start = -1;
  while (i < inner.length) {
    if (inner[i] !== '<') {
      i++;
      continue;
    }
    if (inner.startsWith('<!--', i)) {
      const end = inner.indexOf('-->', i);
      i = end === -1 ? inner.length : end + 3;
      continue;
    }
    if (inner.startsWith('<![CDATA[', i)) {
      const end = inner.indexOf(']]>', i);
      i = end === -1 ? inner.length : end + 3;
      continue;
    }
    const tagEnd = findTagEnd(inner, i);
    const tag = inner.slice(i, tagEnd + 1);
    const closing = tag.startsWith('</');
    const selfClosing = /\/>$/.test(tag);
    if (depth === 0 && !closing) start = i;
    if (closing) {
      depth--;
    } else if (!selfClosing) {
      depth++;
    }
    if (depth === 0 && start >= 0) {
      children.push(inner.slice(start, tagEnd + 1));
      start = -1;
    }
    i = tagEnd + 1;
  }
  return children;
}

function attr(tag: string, name: string): string | null {
  const match = new RegExp(`${name}="([^"]*)"`).exec(tag);
  return match ? match[1] : null;
}

/** Prefix every id / href / url(#...) reference so pages can coexist in one DOM. */
function prefixIds(markup: string, prefix: string): string {
  if (!markup) return markup;
  return markup
    .replace(/\bid="([^"]*)"/g, (_m, id: string) => `id="${prefix}${id}"`)
    .replace(/\bhref="#([^"]*)"/g, (_m, id: string) => `href="#${prefix}${id}"`)
    .replace(/\bxlink:href="#([^"]*)"/g, (_m, id: string) => `xlink:href="#${prefix}${id}"`)
    .replace(/url\(#([^)]*)\)/g, (_m, id: string) => `url(#${prefix}${id})`);
}

function number(value: string | null, fallback = 0): number {
  const parsed = value == null ? NaN : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Split a whole-document SVG into per-page SVGs.
 *
 * The compiler emits `<svg>` with a `<style>`, one `<defs>` and one
 * `<g class="typst-page">` per page, all as direct children.
 */
export function splitSvgIntoPages(svg: string): SvgPage[] {
  const svgOpen = svg.indexOf('<svg');
  if (svgOpen < 0) return [];
  const openEnd = findTagEnd(svg, svgOpen);
  const closeIdx = svg.lastIndexOf('</svg>');
  const inner = svg.slice(openEnd + 1, closeIdx < 0 ? svg.length : closeIdx);
  const children = topLevelChildren(inner);

  const shared: string[] = [];
  const pageMarkup: string[] = [];
  for (const child of children) {
    if (/^<style[\s>]/.test(child) || /^<defs[\s>]/.test(child)) shared.push(child);
    else if (/^<g[^>]*class="typst-page"/.test(child)) pageMarkup.push(child);
  }

  const pages: SvgPage[] = [];
  for (let index = 0; index < pageMarkup.length; index++) {
    const group = pageMarkup[index];
    const openTagEnd = findTagEnd(group, 0);
    const openTag = group.slice(0, openTagEnd + 1);
    const closeStart = group.lastIndexOf('</g>');
    const content = group.slice(openTagEnd + 1, closeStart < 0 ? group.length : closeStart);
    const widthPt = number(attr(openTag, 'data-page-width'), 595.28);
    const heightPt = number(attr(openTag, 'data-page-height'), 841.89);
    const prefix = `pg${index}_`;
    // The page group is normally translated to its vertical offset inside the
    // document; per-page SVGs start at the page origin instead.
    const sharedPrefixed = prefixIds(shared.join(''), prefix);
    const body = prefixIds(content, prefix);
    const styleAttr = attr(openTag, 'style');
    pages.push({
      index,
      widthPt,
      heightPt,
      svg:
        `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
        `class="typst-page-svg" viewBox="0 0 ${widthPt} ${heightPt}" width="${widthPt}" height="${heightPt}" ` +
        `${styleAttr ? `style="${styleAttr}" ` : ''}role="img">` +
        sharedPrefixed +
        body +
        '</svg>',
    });
  }
  return pages;
}

/**
 * Cut a standalone SVG for one rectangle out of a rendered page.
 *
 * The per-page SVG already inlines the glyph defs, so the result is
 * self-contained and can be injected into the DOM on its own. The `<svg>`
 * wrapper is rewritten to a `viewBox` of the requested rect (plus padding,
 * clamped to the page), which is what `renderBlock` uses for inline block
 * previews and hover cards.
 */
export function slicePageSvg(
  page: SvgPage,
  rect: { x: number; y: number; width: number; height: number },
  padding = 4,
): string | null {
  const markup = page.svg;
  const openTag = /^<svg\b[^>]*>/.exec(markup);
  if (!openTag) return null;
  const pageWidth = page.widthPt;
  const pageHeight = page.heightPt;
  const left = Math.max(0, rect.x - padding);
  const top = Math.max(0, rect.y - padding);
  const right = Math.min(pageWidth, rect.x + rect.width + padding);
  const bottom = Math.min(pageHeight, rect.y + rect.height + padding);
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  const number = (value: number): string => String(Math.round(value * 1000) / 1000);
  let tag = openTag[0]
    .replace(/\sviewBox="[^"]*"/, '')
    .replace(/\s(?:width|height)="[^"]*"/g, '')
    .replace(/>$/, '')
    .replace(/\s*$/, '');
  tag +=
    ` viewBox="${number(left)} ${number(top)} ${number(width)} ${number(height)}"` +
    ` width="${number(width)}" height="${number(height)}" preserveAspectRatio="xMinYMin meet">`;
  return tag + markup.slice(openTag[0].length);
}
