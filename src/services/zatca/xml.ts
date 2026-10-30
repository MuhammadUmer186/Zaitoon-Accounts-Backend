// Minimal XML writer for ZATCA documents. Output is compact (no whitespace
// between elements) and already in canonical form (empty elements written as
// start/end pairs, C14N escaping), so the invoice hash can be taken over the
// serialized string exactly as ZATCA's validator canonicalizes it.

export type Child = XmlNode | string | number | null | undefined | false
export interface XmlNode { name: string; attrs?: Record<string, string | number | undefined>; children: Child[] }

type Attrs = Record<string, string | number | undefined>
// el(name, attrs?, ...children) — children may be given as arrays
export const el = (name: string, attrs?: Attrs | Child | Child[], ...rest: (Child | Child[])[]): XmlNode => {
  const isAttrs = attrs !== null && typeof attrs === 'object' && !Array.isArray(attrs) && !('children' in attrs)
  const kids = (isAttrs ? rest : [attrs as Child | Child[], ...rest]).flat() as Child[]
  return { name, ...(isAttrs && { attrs: attrs as Attrs }), children: kids.filter((k) => k !== undefined) }
}

const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#xD;')
const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/\t/g, '&#x9;').replace(/\n/g, '&#xA;').replace(/\r/g, '&#xD;')

export function render(node: Child): string {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return escText(String(node))
  if (node.name === '#raw') return String(node.children[0] ?? '')
  // C14N: namespace declarations first (default, then by prefix), then attributes by name
  const entries = Object.entries(node.attrs ?? {}).filter(([, v]) => v !== undefined) as [string, string | number][]
  const ns = entries.filter(([k]) => k === 'xmlns' || k.startsWith('xmlns:')).sort(([a], [b]) => (a === 'xmlns' ? -1 : b === 'xmlns' ? 1 : a.localeCompare(b)))
  const plain = entries.filter(([k]) => !(k === 'xmlns' || k.startsWith('xmlns:'))).sort(([a], [b]) => a.localeCompare(b))
  const attrs = [...ns, ...plain].map(([k, v]) => ` ${k}="${escAttr(String(v))}"`).join('')
  return `<${node.name}${attrs}>${node.children.map(render).join('')}</${node.name}>`
}

// Removes child elements (by predicate) anywhere below a node — used to take
// the signature, the QR reference and UBLExtensions out before hashing
export function without(node: XmlNode, drop: (n: XmlNode) => boolean): XmlNode {
  return {
    ...node,
    children: node.children
      .filter((c) => !(c && typeof c === 'object' && drop(c)))
      .map((c) => (c && typeof c === 'object' ? without(c, drop) : c)),
  }
}

export const amount = (n: number) => (Math.round((n + Number.EPSILON) * 100) / 100).toFixed(2)
