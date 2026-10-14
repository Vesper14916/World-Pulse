import type { Map as GLMap } from 'maplibre-gl';
import { conflictStyle, activeWaveRank } from '../../services/world-pulse/conflict-visual';

type Wave = {
  x: number;
  y: number;
  rank: number;
  country: boolean;
  expires: number;
  until: number[];
  phase: number;
};

/** One non-interactive canvas for all waves. MapLibre keeps ownership of picking and clustering. */
export class ConflictWaves {
  private canvas = document.createElement('canvas');
  private context: CanvasRenderingContext2D;
  private points: Wave[] = [];
  private enabled = false;
  private reduced = false;
  private cursor: number | null = null;
  private frame = 0;
  private previousFrame = 0;
  private dirty = true;
  private width = 0;
  private height = 0;
  private media = matchMedia('(prefers-reduced-motion: reduce)');
  private onChange = () => {
    this.dirty = true;
    this.restart();
  };
  private onVisibility = () => this.restart();

  constructor(private map: GLMap) {
    this.canvas.className = 'conflict-wave-canvas';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.context = this.canvas.getContext('2d')!;
    map.getCanvasContainer().append(this.canvas);
    for (const event of ['move', 'resize', 'idle'] as const) map.on(event, this.onChange);
    map.on('sourcedata', this.onSource);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.media.addEventListener('change', this.onChange);
    map.once('remove', () => this.destroy());
  }
  private onSource = (event: { sourceId?: string; isSourceLoaded?: boolean }) => {
    if (event.sourceId === 'events' && event.isSourceLoaded) this.onChange();
  };
  configure(enabled: boolean, reduced: boolean, cursor: number | null) {
    this.enabled = enabled;
    this.reduced = reduced;
    this.cursor = cursor;
    this.onChange();
  }
  private restart() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    if (!this.enabled || document.hidden) {
      this.canvas.hidden = !this.enabled;
      this.canvas.dataset.state = this.enabled ? 'paused' : 'off';
      if (!this.enabled) {
        this.context.clearRect(0, 0, this.width, this.height);
        this.canvas.dataset.waveCount = '0';
      }
      return;
    }
    this.canvas.hidden = false;
    this.frame = requestAnimationFrame(this.draw);
  }
  private collect() {
    const container = this.map.getContainer();
    const width = container.clientWidth,
      height = container.clientHeight;
    const ratio = Math.min(devicePixelRatio || 1, 2);
    if (
      this.canvas.width !== Math.round(width * ratio) ||
      this.canvas.height !== Math.round(height * ratio)
    ) {
      this.canvas.width = Math.round(width * ratio);
      this.canvas.height = Math.round(height * ratio);
      this.canvas.style.width = width + 'px';
      this.canvas.style.height = height + 'px';
      this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
    }
    this.width = width;
    this.height = height;
    const seen = new Set<string>();
    this.points = [];
    for (const f of this.map.queryRenderedFeatures({ layers: ['events', 'clusters'] })) {
      if (f.geometry.type !== 'Point' || Number(f.properties.waveRank) < 0) continue;
      const id = String(f.properties.cluster_id ?? f.properties.id);
      if (seen.has(id)) continue;
      seen.add(id);
      const p = this.map.project(f.geometry.coordinates as [number, number]);
      if (p.x < -60 || p.x > width + 60 || p.y < -60 || p.y > height + 60) continue;
      let hash = 0;
      for (const c of id) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
      this.points.push({
        x: p.x,
        y: p.y,
        rank: Number(f.properties.waveRank),
        country: !!Number(f.properties.waveCountry),
        expires: Number(f.properties.waveExpires),
        until: [0, 1, 2, 3].map((rank) => Number(f.properties['waveUntil' + rank])),
        phase: (hash % 3000) / 3000,
      });
    }
    this.dirty = false;
  }
  private draw = (time: number) => {
    this.frame = 0;
    if (!this.enabled || document.hidden) {
      this.restart();
      return;
    }
    const still = this.reduced || this.media.matches;
    // At most 30 fps; no perpetual MapLibre repaint, layout or source mutation.
    if (!still && !this.dirty && time - this.previousFrame < 1000 / 30) {
      this.frame = requestAnimationFrame(this.draw);
      return;
    }
    this.previousFrame = time;
    if (this.dirty) this.collect();
    const ctx = this.context;
    ctx.clearRect(0, 0, this.width, this.height);
    const at = this.cursor ?? Date.now();
    const visible = this.points.filter((p) => p.expires >= at);
    for (const p of visible) p.rank = activeWaveRank(p.until, at);
    this.canvas.dataset.state = still ? 'static' : visible.length ? 'animating' : 'idle';
    this.canvas.dataset.waveCount = String(visible.length);
    this.canvas.dataset.countryCount = String(visible.filter((p) => p.country).length);
    this.canvas.dataset.maxRadius = String(
      Math.max(0, ...visible.map((p) => conflictStyle(p.rank).radius)),
    );
    for (const p of visible) {
      const style = conflictStyle(p.rank);
      ctx.strokeStyle = style.color;
      ctx.lineWidth = 1.35;
      ctx.setLineDash(p.country ? [4, 4] : []);
      for (let ring = 0; ring < 3; ring++) {
        const progress = still ? (ring + 1) / 3 : (time / 3000 + p.phase + ring / 3) % 1;
        const radius = 6 + (style.radius - 6) * progress;
        ctx.globalAlpha = still
          ? 0.42 - ring * 0.09
          : 0.68 * Math.sin(Math.PI * progress) * (1 - progress * 0.65);
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
    if (!still && visible.length) this.frame = requestAnimationFrame(this.draw);
  };
  private destroy() {
    cancelAnimationFrame(this.frame);
    for (const event of ['move', 'resize', 'idle'] as const) this.map.off(event, this.onChange);
    this.map.off('sourcedata', this.onSource);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.media.removeEventListener('change', this.onChange);
    this.canvas.remove();
  }
}
