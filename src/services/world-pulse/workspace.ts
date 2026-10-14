import type { PulseMode } from '../../../shared/world-pulse';

export interface WorkspaceState {
  active: 'reading' | 'command';
  lastReading: PulseMode;
  readingWidth: number;
  command: {
    region: string;
    panelWidth?: number;
    hours: number;
    layout: 'balanced' | 'map' | 'analysis';
    reducedMotion: boolean;
    camera: { lng: number; lat: number; zoom: number };
    layers: { conflicts: boolean; waterways: boolean; vessels: boolean; cities: boolean };
  };
}
export function defaultWorkspace(): WorkspaceState {
  return {
    active: 'reading',
    lastReading: 'world',
    readingWidth: 340,
    command: {
      region: 'global',
      hours: 24,
      layout: 'balanced',
      reducedMotion: false,
      camera: { lng: 30, lat: 23, zoom: 1.3 },
      layers: { conflicts: true, waterways: true, vessels: true, cities: false },
    },
  };
}
export function validWorkspace(value: unknown): value is WorkspaceState {
  if (!value || typeof value !== 'object') return false;
  const w = value as WorkspaceState;
  const c = w.command;
  return (
    ['reading', 'command'].includes(w.active) &&
    ['world', 'portfolio', 'explore'].includes(w.lastReading) &&
    Number.isFinite(w.readingWidth) &&
    w.readingWidth >= 280 &&
    w.readingWidth <= 520 &&
    !!c &&
    (c.panelWidth === undefined ||
      (Number.isFinite(c.panelWidth) && c.panelWidth >= 260 && c.panelWidth <= 380)) &&
    typeof c.region === 'string' &&
    c.region.length < 80 &&
    [1, 6, 24, 168].includes(c.hours) &&
    ['balanced', 'map', 'analysis'].includes(c.layout) &&
    typeof c.reducedMotion === 'boolean' &&
    !!c.camera &&
    Number.isFinite(c.camera.lng) &&
    Math.abs(c.camera.lng) <= 180 &&
    Number.isFinite(c.camera.lat) &&
    Math.abs(c.camera.lat) <= 85 &&
    Number.isFinite(c.camera.zoom) &&
    c.camera.zoom >= 0 &&
    c.camera.zoom <= 10 &&
    !!c.layers &&
    ['conflicts', 'waterways', 'vessels', 'cities'].every(
      (k) => typeof c.layers[k as keyof typeof c.layers] === 'boolean',
    )
  );
}
