/** Decorative SVG: accessible meaning belongs to the parent disclosure control. */
export function attentionGauge(position: number | null): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 104 62');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('attention-gauge');
  const stops = [
    [109, 130, 154],
    [71, 207, 206],
    [242, 173, 82],
    [239, 89, 100],
  ];
  const color = (t: number) => {
    const n = t * 3,
      i = Math.min(2, Math.floor(n)),
      f = n - i;
    return `rgb(${stops[i]!.map((v, j) => Math.round(v + (stops[i + 1]![j]! - v) * f)).join(',')})`;
  };
  const point = (t: number, r = 42) => [
    52 - Math.cos(t * Math.PI) * r,
    52 - Math.sin(t * Math.PI) * r,
  ];
  const arc = (a: number, b: number, stroke: string) => {
    const path = document.createElementNS(ns, 'path');
    const p = point(a),
      q = point(b);
    path.setAttribute('d', `M ${p[0]} ${p[1]} A 42 42 0 0 1 ${q[0]} ${q[1]}`);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', stroke);
    path.setAttribute('stroke-width', '7');
    svg.append(path);
  };
  if (position === null) {
    arc(0, 1, '#8190a3');
    return svg;
  }
  const value = Math.max(0, Math.min(1, position));
  for (let i = 0; i < 60; i++) arc(i / 60, Math.min(1, (i + 1.1) / 60), color(i / 59));
  const needle = document.createElementNS(ns, 'path');
  const end = point(value, 33);
  needle.classList.add('attention-needle');
  needle.setAttribute('d', `M 52 52 L ${end[0]} ${end[1]}`);
  needle.setAttribute('stroke', '#f1f5f9');
  needle.setAttribute('stroke-width', '3');
  needle.setAttribute('stroke-linecap', 'round');
  svg.append(needle);
  const hub = document.createElementNS(ns, 'circle');
  hub.setAttribute('cx', '52');
  hub.setAttribute('cy', '52');
  hub.setAttribute('r', '4');
  hub.setAttribute('fill', color(value));
  svg.append(hub);
  return svg;
}
