/**
 * SVG sanitising + strict XML well-formedness validation.
 *
 * LLM-authored SVGs are rasterised by librsvg (through sharp), and librsvg is a
 * real XML parser: a single unclosed element — most commonly a `<style>` block
 * the model never closed — aborts the whole publish stage with the opaque
 * `Input buffer has corrupt header: glib: XML parse error`.
 *
 * Every generated SVG therefore goes through two gates:
 *   1. {@link sanitizeSvg} removes what neither X nor librsvg needs (`<script>`,
 *      `on*=` handlers, XML prologue) and mechanically repairs fixable damage.
 *      Every repair is reported, never applied silently.
 *   2. {@link assertWellFormedSvg} parses the result with a real XML parser and
 *      throws {@link SvgXmlError} (with line + snippet) when it is still broken.
 *
 * There is deliberately no template fallback: a broken diagram must fail the
 * asset stage loudly instead of being replaced by a generic placeholder.
 */
import { DOMParser } from '@xmldom/xmldom';

export interface SvgRepair {
  /** Machine-readable repair id (`unclosed`, `drop-stray-close`, …). */
  kind: string;
  /** Human-readable detail used in the warning log. */
  detail: string;
}

export interface SanitizeSvgResult {
  svg: string;
  repairs: SvgRepair[];
}

/** Thrown when an SVG is still not well-formed XML after sanitising. */
export class SvgXmlError extends Error {
  readonly line: number;
  readonly column: number;
  readonly snippet: string;

  constructor(message: string, line: number, column: number, snippet: string) {
    super(`${message} (line ${line}, column ${column})`);
    this.name = 'SvgXmlError';
    this.line = line;
    this.column = column;
    this.snippet = snippet;
  }
}

/** Characters XML 1.0 forbids outright (plus a stray BOM). */
const XML_ILLEGAL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFEFF]/g;

/** `&` that does not start a character/entity reference. */
const BARE_AMPERSAND = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g;

/** Elements whose content is CSS/JS text, not markup. */
const RAW_TEXT_ELEMENTS = new Set(['style', 'script']);

function lineColumnOf(text: string, index: number): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(index, text.length));
  const before = text.slice(0, clamped);
  const line = before.split('\n').length;
  const lastBreak = before.lastIndexOf('\n');
  const column = clamped - lastBreak;
  return { line, column };
}

/** `line 12, column 4` — used inside repair details. */
function positionOf(text: string, index: number): string {
  const { line, column } = lineColumnOf(text, index);
  return `line ${line}, column ${column}`;
}

function snippetAround(text: string, line: number, radius = 2): string {
  const lines = text.split('\n');
  const from = Math.max(0, line - 1 - radius);
  const to = Math.min(lines.length, line + radius);
  return lines
    .slice(from, to)
    .map((content, offset) => `${String(from + offset + 1).padStart(4, ' ')} | ${content}`)
    .join('\n');
}

/**
 * Escapes `&` outside CDATA sections only: escaping inside CDATA would change
 * the rendered text (CDATA is the one place `&` is literal).
 */
function escapeBareAmpersands(svg: string): string {
  return svg
    .split(/(<!\[CDATA\[[\s\S]*?\]\]>)/g)
    .map((part, index) => (index % 2 === 1 ? part : part.replace(BARE_AMPERSAND, '&amp;')))
    .join('');
}

/**
 * Single pass over the markup: balances open/close tags and drops constructs
 * that cannot be rendered (stray closing tags, unescaped `<`).
 *
 * `style` / `script` bodies are skipped as raw text so CSS like
 * `g > rect { … }` is never mistaken for markup.
 */
function balanceTags(svg: string, repairs: SvgRepair[]): string {
  const stack: Array<{ name: string; index: number }> = [];
  let out = '';
  let cursor = 0;

  const closeTop = (index: number) => {
    repairs.push({
      kind: 'implicit-close',
      detail: `<${stack[index].name}> opened at ${positionOf(svg, stack[index].index)}`,
    });
    out += `</${stack[index].name}>`;
  };

  while (cursor < svg.length) {
    const lt = svg.indexOf('<', cursor);
    if (lt === -1) {
      out += svg.slice(cursor);
      break;
    }
    out += svg.slice(cursor, lt);

    if (svg.startsWith('<!--', lt)) {
      const end = svg.indexOf('-->', lt + 4);
      if (end === -1) {
        repairs.push({ kind: 'drop-unterminated-comment', detail: `at ${positionOf(svg, lt)}` });
        cursor = svg.length;
        break;
      }
      out += svg.slice(lt, end + 3);
      cursor = end + 3;
      continue;
    }

    if (svg.startsWith('<![CDATA[', lt)) {
      const end = svg.indexOf(']]>', lt + 9);
      if (end === -1) {
        repairs.push({ kind: 'drop-unterminated-cdata', detail: `at ${positionOf(svg, lt)}` });
        cursor = svg.length;
        break;
      }
      out += svg.slice(lt, end + 3);
      cursor = end + 3;
      continue;
    }

    if (svg.startsWith('<?', lt)) {
      const end = svg.indexOf('?>', lt + 2);
      if (end === -1) {
        repairs.push({ kind: 'drop-unterminated-pi', detail: `at ${positionOf(svg, lt)}` });
        cursor = svg.length;
        break;
      }
      out += svg.slice(lt, end + 2);
      cursor = end + 2;
      continue;
    }

    const closeTag = /^<\/\s*([A-Za-z_][\w.:-]*)\s*>/.exec(svg.slice(lt, lt + 256));
    if (closeTag) {
      const name = closeTag[1];
      let match = -1;
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].name === name) {
          match = i;
          break;
        }
      }
      if (match === -1) {
        repairs.push({
          kind: 'drop-stray-close',
          detail: `</${name}> at ${positionOf(svg, lt)} has no matching open tag`,
        });
      } else {
        for (let i = stack.length - 1; i > match; i -= 1) closeTop(i);
        stack.length = match;
        out += closeTag[0];
      }
      cursor = lt + closeTag[0].length;
      continue;
    }

    const openTag = /^<([A-Za-z_][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/.exec(
      svg.slice(lt, lt + 8192)
    );
    if (!openTag) {
      // A literal `<` in text content. XML requires it escaped; renderers drop
      // the rest of the line otherwise.
      repairs.push({ kind: 'escape-lt', detail: `bare "<" at ${positionOf(svg, lt)}` });
      out += '&lt;';
      cursor = lt + 1;
      continue;
    }

    const name = openTag[1];
    const selfClosing = /\/\s*$/.test(openTag[2]);
    out += openTag[0];
    cursor = lt + openTag[0].length;

    if (selfClosing) continue;

    if (RAW_TEXT_ELEMENTS.has(name.toLowerCase())) {
      const terminator = new RegExp(`</\\s*${name}\\s*>`, 'i').exec(svg.slice(cursor));
      if (terminator) {
        out += svg.slice(cursor, cursor + terminator.index) + terminator[0];
        cursor += terminator.index + terminator[0].length;
      } else {
        // The exact failure that killed the 2026-11-05 run: `<style>` with no
        // `</style>`, which made librsvg report "style … and svg".
        repairs.push({ kind: 'unclosed', detail: `<${name}> opened at ${positionOf(svg, lt)}` });
        out += `</${name}>`;
      }
      continue;
    }

    stack.push({ name, index: lt });
  }

  for (let i = stack.length - 1; i >= 0; i -= 1) closeTop(i);
  return out;
}

function ensureSvgNamespace(svg: string, repairs: SvgRepair[]): string {
  const root = /<svg\b([^>]*)>/i.exec(svg);
  if (!root) return svg;
  if (/\bxmlns\s*=/.test(root[1])) return svg;
  repairs.push({ kind: 'add-xmlns', detail: 'root <svg> had no xmlns' });
  return svg.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
}

/**
 * Normalises an LLM-produced SVG into renderable XML.
 *
 * Repairs are returned (and logged by the caller) so a model that keeps
 * emitting broken markup is visible in the run log instead of being masked.
 */
export function sanitizeSvg(raw: string): SanitizeSvgResult {
  const repairs: SvgRepair[] = [];
  let svg = String(raw ?? '');

  const originalLength = svg.length;
  svg = svg.replace(/^\uFEFF/, '').replace(XML_ILLEGAL_CHARS, '');
  if (svg.length !== originalLength) {
    repairs.push({
      kind: 'strip-illegal-chars',
      detail: `${originalLength - svg.length} control/BOM characters`,
    });
  }

  const prologue = /<\?xml[\s\S]*?\?>/gi;
  if (prologue.test(svg)) {
    repairs.push({ kind: 'strip-xml-prologue', detail: 'removed <?xml …?> declaration' });
    svg = svg.replace(prologue, '');
  }

  const doctype = /<!DOCTYPE[^>]*>/gi;
  if (doctype.test(svg)) {
    repairs.push({ kind: 'strip-doctype', detail: 'removed <!DOCTYPE …>' });
    svg = svg.replace(doctype, '');
  }

  const scriptBlock = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;
  const scriptEmpty = /<script\b[^>]*\/>/gi;
  const scriptCount = (svg.match(scriptBlock)?.length ?? 0) + (svg.match(scriptEmpty)?.length ?? 0);
  if (scriptCount > 0) {
    repairs.push({ kind: 'strip-script', detail: `${scriptCount} <script> block(s)` });
    svg = svg.replace(scriptBlock, '').replace(scriptEmpty, '');
  }

  const eventHandlers = /\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*')/gi;
  const handlerCount = svg.match(eventHandlers)?.length ?? 0;
  if (handlerCount > 0) {
    repairs.push({ kind: 'strip-event-handler', detail: `${handlerCount} on*= attribute(s)` });
    svg = svg.replace(eventHandlers, '');
  }

  const beforeAmp = svg;
  svg = escapeBareAmpersands(svg);
  if (svg !== beforeAmp) {
    repairs.push({ kind: 'escape-ampersand', detail: 'bare "&" escaped as &amp;' });
  }

  svg = balanceTags(svg, repairs);
  svg = ensureSvgNamespace(svg, repairs);

  return { svg: svg.trim(), repairs };
}

/** Elements that actually draw something on the canvas. */
const DRAWABLE_ELEMENT_RE = /<(?:rect|circle|ellipse|line|polyline|polygon|path|text)\b/gi;

/**
 * A diagram with fewer visible primitives than this is not a diagram.
 *
 * The 2026-11-05 SVG had exactly five — the arrow markers inside `<defs>` —
 * because the model degenerated into emitting `.t-footbN` CSS classes until it
 * hit the token limit. librsvg happily rasterised that into a blank PNG.
 */
export const DEFAULT_MIN_DRAWABLE_ELEMENTS = 8;

/**
 * Counts visible primitives outside `<defs>` / `<style>` / comments.
 * Definitions alone (markers, gradients, filters) never render by themselves.
 */
export function countDrawableElements(svg: string): number {
  const body = svg
    .replace(/<defs\b[\s\S]*?<\/defs>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  return (body.match(DRAWABLE_ELEMENT_RE) ?? []).length;
}

/**
 * Throws unless the SVG draws something. Catches the "valid XML, empty picture"
 * case that a well-formedness check alone cannot see.
 */
export function assertSvgHasContent(
  svg: string,
  label = 'svg',
  min = DEFAULT_MIN_DRAWABLE_ELEMENTS
): void {
  const drawable = countDrawableElements(svg);
  if (drawable >= min) return;
  throw new Error(
    `[${label}] SVG has only ${drawable} visible drawing element(s) (< ${min}): the diagram is empty, degenerate or truncated`
  );
}

/** Best-effort line lookup for a parser message ("… line 68 …"). */
function locateError(svg: string, message: string): { line: number; column: number } {
  const explicit = /line[ :]+(\d+)(?:[ ,:]+column[ :]+(\d+))?/i.exec(message);
  if (explicit) {
    const line = Number(explicit[1]);
    if (Number.isFinite(line) && line > 0) {
      return { line, column: explicit[2] ? Number(explicit[2]) : 1 };
    }
  }
  const tag = /<\/?([A-Za-z_][\w.:-]*)/.exec(message);
  if (tag) {
    const index = svg.indexOf(`<${tag[1]}`);
    if (index !== -1) return lineColumnOf(svg, index);
  }
  return { line: 1, column: 1 };
}

/**
 * Throws {@link SvgXmlError} unless `svg` parses as well-formed XML with an
 * `<svg>` root. Warnings are ignored on purpose (librsvg tolerates them too);
 * `error` / `fatalError` are not.
 */
export function assertWellFormedSvg(svg: string, label = 'svg'): void {
  if (!svg.trim()) {
    throw new SvgXmlError(`[${label}] empty SVG document`, 1, 1, '');
  }

  const errors: string[] = [];
  // Structural type only: @xmldom/xmldom ships its own DOM typings, which are
  // not assignable to lib.dom's `Document`.
  let doc: { documentElement?: { nodeName?: string } | null } | null = null;
  try {
    doc = new DOMParser({
      onError: (level, message) => {
        if (level !== 'warning') errors.push(message);
      },
    }).parseFromString(svg, 'text/xml');
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  const rootName = doc?.documentElement?.nodeName?.toLowerCase();
  if (errors.length === 0 && rootName !== 'svg') {
    errors.push(`root element is <${rootName ?? 'none'}>, expected <svg>`);
  }
  if (errors.length === 0) return;

  const message = errors[0];
  const { line, column } = locateError(svg, message);
  throw new SvgXmlError(`[${label}] invalid SVG XML: ${message}`, line, column, snippetAround(svg, line));
}
