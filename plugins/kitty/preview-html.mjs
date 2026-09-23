/** Resolve report assets with HTML/CSS parsers before an opaque-origin iframe receives them. */
import { parse as parseHtml, serialize } from 'parse5';
import parseCss from 'css-tree/parser';
import walk from 'css-tree/walker';
import generate from 'css-tree/generator';

/**
 * Escape text for generated report wrappers.
 * @param value - untrusted document text.
 * @returns HTML text without executable markup.
 */
export function escapeHtml(value) {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

/**
 * Inline scoped static assets; keep external HTTP(S) CDN resources in the browser.
 * @param resource - root report bytes, final URL and media type.
 * @param read - bounded reader enforcing the root origin or allowed static asset directories.
 * @param maxBytes - bound on intermediate asset expansion as well as serialized output.
 * @returns serialized HTML with absolute navigation URLs and inline local assets.
 */
export async function prepareHtml(resource, read, maxBytes) {
  const root = new URL(resource.url);
  const document = parseHtml(resource.data.toString('utf8'));
  const nodes = [];
  function collect(node) {
    if (node.tagName) nodes.push(node);
    for (const child of node.childNodes ?? []) collect(child);
    if (node.content) collect(node.content);
  }
  collect(document);
  const attribute = (node, name) => node.attrs.find(item => item.name === name);
  const base = new URL(attribute(nodes.find(node => node.tagName === 'base') ?? { attrs: [] }, 'href')?.value ?? root.href, root);
  const prepared = new Map();
  let expandedBytes = 0;
  function budget(value) {
    expandedBytes += Buffer.byteLength(value);
    if (expandedBytes > maxBytes) throw new Error('preview_too_large');
    return value;
  }
  async function asset(value, from, ancestors, css = false) {
    if (!value || value.startsWith('#') || value.startsWith('data:')) return value;
    const url = new URL(value, from);
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== root.origin) return url.href;
    const key = url.href;
    if (ancestors.has(key)) throw new Error('preview_resource_cycle');
    if (prepared.has(key)) return budget(await prepared.get(key));
    const task = (async () => {
      const resource = await read(url.href);
      if (resource.status < 200 || resource.status >= 300) throw new Error('preview_fetch_failed');
      const type = css ? 'text/css' : resource.contentType.split(';')[0];
      const data = type === 'text/css'
        ? Buffer.from(await stylesheet(resource.data.toString('utf8'), resource.url, new Set([...ancestors, key])))
        : resource.data;
      return `data:${type};base64,${data.toString('base64')}${url.hash}`;
    })();
    prepared.set(key, task);
    return budget(await task);
  }
  async function stylesheet(value, from, ancestors, context = 'stylesheet') {
    const ast = parseCss(value, { context });
    const refs = [];
    walk(ast, function (node) {
      if (node.type === 'Url' || (node.type === 'String' && this.atrule?.name.toLowerCase() === 'import' && this.atrule.prelude?.children.first === node)) refs.push({ node, css: this.atrule?.name.toLowerCase() === 'import' });
    });
    for (const ref of refs) ref.node.value = await asset(ref.node.value, from, ancestors, ref.css);
    return generate(ast);
  }
  for (const node of nodes) {
    if (node.tagName === 'base' || (node.tagName === 'meta' && attribute(node, 'http-equiv'))) {
      node.parentNode.childNodes = node.parentNode.childNodes.filter(child => child !== node);
      continue;
    }
    // Embedded object documents have their own navigation and cannot use the parent bridge.
    if (['iframe', 'object', 'embed'].includes(node.tagName)) {
      node.parentNode.childNodes = node.parentNode.childNodes.filter(child => child !== node);
      continue;
    }
    const style = attribute(node, 'style');
    if (style) style.value = await stylesheet(style.value, base, new Set(), 'declarationList');
    if (node.tagName === 'style') for (const text of node.childNodes) {
      if (text.nodeName === '#text') text.value = await stylesheet(text.value, base, new Set());
    }
    for (const attr of node.attrs) {
      if ((node.tagName === 'a' && attr.name === 'href') || attr.name === 'action' || attr.name === 'formaction') {
        if (attr.value && !attr.value.startsWith('#')) attr.value = new URL(attr.value, base).href;
      } else if (attr.name === 'src' || attr.name === 'poster' || (node.tagName === 'link' && attr.name === 'href' && /\b(stylesheet|icon|preload|modulepreload)\b/i.test(attribute(node, 'rel')?.value ?? ''))) {
        attr.value = await asset(attr.value, base, new Set(), node.tagName === 'link' && /\bstylesheet\b/i.test(attribute(node, 'rel')?.value ?? ''));
      }
    }
    // The inlined src is independent of responsive variants and upstream integrity metadata.
    node.attrs = node.attrs.filter(attr => !['srcset', 'integrity', 'nonce'].includes(attr.name));
  }
  const head = nodes.find(node => node.tagName === 'head');
  head.childNodes.unshift({ nodeName: 'base', tagName: 'base', namespaceURI: 'http://www.w3.org/1999/xhtml', attrs: [{ name: 'href', value: base.href }], childNodes: [], parentNode: head });
  return serialize(document);
}
