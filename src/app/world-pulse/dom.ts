import { safeUrl } from '../../services/world-pulse/model';

export type Child = Node | string | null | undefined | false;
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('on') && typeof value === 'function')
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    else if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'value' && 'value' in node) (node as HTMLInputElement).value = String(value);
    else if (value !== false && value != null)
      node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const c of children)
    if (c !== null && c !== undefined && c !== false)
      node.append(c instanceof Node ? c : document.createTextNode(c));
  return node;
}
export function setChildren(node: HTMLElement, ...children: Child[]) {
  node.replaceChildren(
    ...children.filter((c): c is Node | string => c !== null && c !== undefined && c !== false),
  );
}
export function button(
  label: string,
  action: () => void,
  cls = '',
  attrs: Record<string, unknown> = {},
) {
  return el('button', { type: 'button', class: cls, onclick: action, ...attrs }, label);
}
export function link(label: string, url: string, cls = '') {
  const href = safeUrl(url);
  return href
    ? el('a', { href, target: '_blank', rel: 'noopener noreferrer', class: cls }, label)
    : el('span', { class: cls }, label + ' · link unavailable');
}
export function date(value: string | null | undefined, unavailable = 'Time unavailable') {
  return value
    ? new Date(value).toLocaleString('en-GB', {
        year: 'numeric',
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Shanghai',
        timeZoneName: 'short',
      })
    : unavailable;
}
export function ago(value: string | null) {
  if (!value) return 'Time unknown';
  const m = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  return m < 60
    ? `${m}m ago`
    : m < 1440
      ? `${Math.floor(m / 60)}h ago`
      : `${Math.floor(m / 1440)}d ago`;
}

/** Preserve keyboard focus and open disclosures across a periodic panel refresh. */
export function preservePanel(container: HTMLElement): () => void {
  const active = container.contains(document.activeElement)
    ? (document.activeElement as HTMLElement)
    : null;
  const text = active?.textContent;
  const tag = active?.tagName;
  const key = active?.getAttribute('data-vessel') || active?.getAttribute('data-command-event');
  const disclosureKey = (d: Element) =>
    d.getAttribute('data-disclosure-key') ||
    d.closest('[data-command-company]')?.getAttribute('data-command-company');
  const open = [...container.querySelectorAll('details[open]')].map(disclosureKey).filter(Boolean);
  const scroll = container.scrollTop;
  return () => {
    for (const details of container.querySelectorAll<HTMLDetailsElement>('details'))
      if (open.includes(disclosureKey(details))) details.open = true;
    container.scrollTop = scroll;
    if (!active) return;
    const target = [
      ...container.querySelectorAll<HTMLElement>('button,a,summary,input,select'),
    ].find((e) =>
      key
        ? (e.getAttribute('data-vessel') || e.getAttribute('data-command-event')) === key
        : e.tagName === tag && e.textContent === text,
    );
    target?.focus({ preventScroll: true });
  };
}
