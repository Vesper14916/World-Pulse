import * as maplibregl from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { GeoJSONSource, Map as GLMap, ExpressionSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { conflictMapProperties, conflictStyle } from '../../services/world-pulse/conflict-visual';
import { ConflictWaves } from './conflict-waves';
import { conflictKind, type VesselObservation } from '../../../shared/world-pulse-command';
import { STRATEGIC_AREAS } from '../../../shared/world-pulse-strategic';
import type { PulseEvent } from '../../../shared/world-pulse';

export type Camera = { lng: number; lat: number; zoom: number };
export type CityPoint = {
  name: string;
  country: string;
  capital: boolean;
  population: number;
  lng: number;
  lat: number;
};
interface CityFeature {
  properties: {
    name: string;
    country: string;
    capital: boolean;
    population: number;
    tier: number;
  };
  geometry: { coordinates: [number, number] };
}
/** Zoom levels at which each city tier becomes eligible (map maxZoom is 10). */
const CITY_TIER_ZOOM: Record<number, number> = { 1: 2.2, 2: 3.3, 3: 4.6 };
const CITY_ANCHORS = new Set([
  'New York|United States',
  'São Paulo|Brazil',
  'London|United Kingdom',
  'Cairo|Egypt',
  'Delhi|India',
  'Beijing|China',
  'Tokyo|Japan',
  'Sydney|Australia',
]);
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
/** Short relative age for tooltip metadata ("3h ago"). Mirrors the app's ago(). */
function agoLabel(value?: string) {
  if (!value) return '';
  const m = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  return m < 60
    ? `${m}m ago`
    : m < 1440
      ? `${Math.floor(m / 60)}h ago`
      : `${Math.floor(m / 1440)}d ago`;
}
function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
const colors: ExpressionSpecification = [
  'match',
  ['get', 'category'],
  'Disasters',
  '#d8a76a',
  'Technology',
  '#91a4e8',
  'Economy',
  '#8ec5b5',
  '#72b8c7',
];
export class PulseMap {
  private map: GLMap;
  private ready = false;
  private palette: 'reading' | 'command' = 'reading';
  private reduceMotion = false;
  private waves?: ConflictWaves;
  private waveActive = false;
  private waveCursor: number | null = null;
  private events: PulseEvent[] = [];
  private background: PulseEvent[] = [];
  private selected = '';
  private clusterLabels: maplibregl.Marker[] = [];
  private showEvents = true;
  private showContext = true;
  private showCities = true;
  private tooltip: HTMLDivElement;
  private maritimeData: VesselObservation[] = [];
  private trailData: VesselObservation[] = [];
  private showWaterways = false;
  private showVessels = false;
  private areaMarkers: maplibregl.Marker[] = [];
  private commandCallbacks?: { area: (id: string) => void; vessel: (id: string) => void };
  constructor(
    container: HTMLElement,
    camera: Camera,
    callbacks: {
      event: (id: string) => void;
      country: (code: string, name: string) => void;
      city: (city: CityPoint) => void;
      camera: (camera: Camera) => void;
      status: (text: string) => void;
    },
  ) {
    maplibregl.setWorkerUrl(maplibreWorkerUrl);
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'map-tooltip glass';
    this.tooltip.setAttribute('aria-hidden', 'true');
    this.map = new maplibregl.Map({
      container,
      center: [camera.lng, camera.lat],
      zoom: camera.zoom,
      minZoom: 0,
      maxZoom: 10,
      attributionControl: false,
      renderWorldCopies: false,
      style: {
        version: 8,
        sources: {
          countries: { type: 'geojson', data: '/data/countries.geojson' },
          grid: { type: 'geojson', data: this.grid() },
        },
        layers: [
          {
            id: 'ocean',
            type: 'background',
            paint: { 'background-color': '#101827' },
          },
          {
            id: 'graticule',
            type: 'line',
            source: 'grid',
            paint: {
              'line-color': '#253543',
              'line-width': 0.5,
              'line-opacity': 0.4,
            },
          },
          {
            id: 'land',
            type: 'fill',
            source: 'countries',
            paint: { 'fill-color': '#253750', 'fill-opacity': 0.95 },
          },
          {
            id: 'borders',
            type: 'line',
            source: 'countries',
            paint: {
              'line-color': '#7690b0',
              'line-width': 0.6,
              'line-opacity': 0.55,
            },
          },
          {
            id: 'hover-country',
            type: 'fill',
            source: 'countries',
            filter: ['==', ['get', 'ISO3166-1-Alpha-2'], ''],
            paint: { 'fill-color': '#67E8F9', 'fill-opacity': 0.18 },
          },
        ],
      },
    });
    this.map.addControl(
      new maplibregl.AttributionControl({
        compact: true,
        customAttribution:
          'Boundaries & cities: <a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener noreferrer">Natural Earth</a> · MundiTrace assets',
      }),
      'bottom-right',
    );
    this.map.on('load', () => {
      this.ready = true;
      for (const name of ['background-events', 'events']) {
        this.map.addSource(name, {
          type: 'geojson',
          data: this.geo([]),
          ...(name === 'events'
            ? {
                cluster: true,
                clusterRadius: 35,
                clusterMaxZoom: 6,
                clusterProperties: {
                  conflictRank: ['max', ['get', 'conflictRank']],
                  waveRank: ['max', ['get', 'waveRank']],
                  waveCountry: ['max', ['get', 'waveCountry']],
                  waveExpires: ['max', ['get', 'waveExpires']],
                  waveUntil0: ['max', ['get', 'waveUntil0']],
                  waveUntil1: ['max', ['get', 'waveUntil1']],
                  waveUntil2: ['max', ['get', 'waveUntil2']],
                  waveUntil3: ['max', ['get', 'waveUntil3']],
                },
              }
            : {}),
        });
      }
      this.map.addLayer({
        id: 'background-events',
        type: 'circle',
        source: 'background-events',
        paint: {
          'circle-radius': 3,
          'circle-color': '#8ea4be',
          'circle-opacity': 0.3,
        },
      });
      this.map.addLayer({
        id: 'clusters',
        type: 'circle',
        source: 'events',
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': '#315563',
          'circle-radius': ['step', ['get', 'point_count'], 13, 10, 17, 40, 22],
          'circle-stroke-color': '#8fbec8',
          'circle-stroke-width': 1.2,
        },
      });
      this.map.addLayer({
        id: 'event-rings',
        type: 'circle',
        source: 'events',
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-radius': ['case', ['==', ['get', 'id'], this.selected], 13, 8],
          'circle-color': colors,
          'circle-opacity': 0.1,
        },
      });
      this.map.addLayer({
        id: 'events',
        type: 'circle',
        source: 'events',
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-radius': ['case', ['==', ['get', 'precision'], 'exact'], 4, 5.5],
          'circle-color': colors,
          'circle-stroke-color': '#d5edf0',
          'circle-stroke-width': ['case', ['==', ['get', 'id'], this.selected], 2, 0.7],
        },
      });
      this.map.on('click', (e) => {
        if (this.showVessels) {
          const ship = this.map.queryRenderedFeatures(e.point, {
            layers: ['vessel-points', 'vessel-arrows', 'vessel-clusters'],
          })[0];
          if (ship?.properties?.mmsi) {
            this.commandCallbacks?.vessel(String(ship.properties.mmsi));
            return;
          }
          if (ship?.properties?.cluster_id !== undefined && ship.geometry.type === 'Point') {
            const center = ship.geometry.coordinates as [number, number];
            void (this.map.getSource('vessels') as GeoJSONSource)
              .getClusterExpansionZoom(Number(ship.properties.cluster_id))
              .then((zoom) =>
                this.map.easeTo({
                  center,
                  zoom,
                  duration: this.reduceMotion || reducedMotion() ? 0 : 400,
                }),
              )
              .catch(() => callbacks.status('Unable to expand vessel group'));
            return;
          }
        }
        const features = this.map.queryRenderedFeatures(e.point, {
          layers: ['events', 'clusters'],
        });
        const f = features[0];
        if (f?.properties?.cluster_id !== undefined) {
          const source = this.map.getSource('events') as GeoJSONSource;
          void source
            .getClusterExpansionZoom(Number(f.properties.cluster_id))
            .then((zoom) => {
              if (f.geometry.type === 'Point')
                this.map.easeTo({
                  center: f.geometry.coordinates as [number, number],
                  zoom,
                });
            })
            .catch(() => callbacks.status('Unable to expand cluster'));
          return;
        }
        if (f?.properties?.id) {
          callbacks.event(String(f.properties.id));
          return;
        }
        const country = this.map.queryRenderedFeatures(e.point, {
          layers: ['land'],
        })[0];
        if (country?.properties)
          callbacks.country(
            String(country.properties['ISO3166-1-Alpha-2']),
            String(country.properties.name),
          );
      });
      this.map.on('mousemove', (e) => {
        const found = this.map.queryRenderedFeatures(e.point, {
          layers: ['events', 'clusters', 'land'],
        });
        this.map.getCanvas().style.cursor = found.length ? 'pointer' : '';
        const country = found.find((f) => f.layer.id === 'land');
        this.map.setFilter('hover-country', [
          '==',
          ['get', 'ISO3166-1-Alpha-2'],
          country?.properties?.['ISO3166-1-Alpha-2'] || '',
        ]);
        const event = found.find((f) => f.layer.id === 'events');
        const cluster = found.find((f) => f.layer.id === 'clusters');
        this.updateTooltip(e.point, event?.properties, cluster?.properties, country?.properties);
      });
      this.map.getCanvas().addEventListener('mouseleave', () => this.hideTooltip());
      this.map.on('sourcedata', (e) => {
        if (e.sourceId === 'events' && e.isSourceLoaded) this.updateClusterLabels();
      });
      this.map.on('moveend', () => this.updateClusterLabels());
      this.waves = new ConflictWaves(this.map);
      this.syncWaves();
      this.labels();
      this.update(this.events, this.background, this.selected);
      this.loadDetailedGeography();
      this.map.on('zoomend', () => this.loadDetailedGeography());
      this.initMaritime();
      this.theme(this.palette);
      callbacks.status('Map ready');
      container.dataset.ready = 'true';
    });
    this.map.on('moveend', () => {
      const c = this.map.getCenter();
      callbacks.camera({
        lng: ((((c.lng + 180) % 360) + 360) % 360) - 180,
        lat: c.lat,
        zoom: this.map.getZoom(),
      });
    });
    this.map.on('error', () =>
      callbacks.status('Map resource unavailable. Event list remains available.'),
    );
    void this.loadCities(callbacks.city);
    new ResizeObserver(() => this.map.resize()).observe(container);
  }
  private cityMarkers: {
    marker?: maplibregl.Marker;
    mounted: boolean;
    lng: number;
    lat: number;
    country: string;
    tier: number;
    name: string;
    capital: boolean;
    population: number;
    anchor: boolean;
  }[] = [];
  private citiesReady = false;
  private onCity?: (city: CityPoint) => void;
  private cityObstacles(): HTMLElement[] {
    return [
      ...(this.map
        .getContainer()
        .parentElement?.querySelectorAll<HTMLElement>(
          '.command-toolbar, .command-telemetry, .command-panel, .command-timeline, .command-map-tools, .command-layer-controls, .map-tools, .map-heading, .map-caption',
        ) ?? []),
    ];
  }
  private cityFrame?: number;
  private selectedCityElement?: HTMLElement;
  private async loadCities(onCity: (city: CityPoint) => void) {
    try {
      const res = await fetch('/data/cities.geojson', {
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { features: CityFeature[] };
      if (!Array.isArray(data.features)) throw new Error('Unexpected cities payload');
      for (const feature of data.features) {
        const p = feature.properties;
        const [lng, lat] = feature.geometry.coordinates;
        if (
          !p ||
          typeof p.name !== 'string' ||
          typeof p.country !== 'string' ||
          !Number.isFinite(lng) ||
          !Number.isFinite(lat) ||
          Math.abs(lng) > 180 ||
          Math.abs(lat) > 90
        )
          continue;
        this.cityMarkers.push({
          mounted: false,
          lng,
          lat,
          country: p.country,
          tier: p.tier,
          name: p.name,
          capital: p.capital,
          population: p.population,
          anchor: CITY_ANCHORS.has(`${p.name}|${p.country}`),
        });
      }
      this.onCity = onCity;
      this.cityMarkers.sort(
        (a, b) =>
          Number(b.anchor) - Number(a.anchor) ||
          Number(b.capital) - Number(a.capital) ||
          b.population - a.population ||
          a.name.localeCompare(b.name),
      );
      this.citiesReady = true;
      this.updateCityVisibility();
      // getZoom() can read 0 before the style finishes loading; re-evaluate
      // once the map is ready and after every completed move.
      this.map.on('load', () => this.scheduleCityVisibility());
      this.map.on('moveend', () => this.scheduleCityVisibility());
      this.map.on('resize', () => this.scheduleCityVisibility());
      const observer = new ResizeObserver(() => this.scheduleCityVisibility());
      for (const obstacle of this.cityObstacles()) observer.observe(obstacle);
    } catch {
      // City labels are a enhancement layer: the map and events stay usable without them.
      this.cityMarkers.forEach(({ marker }) => marker?.remove());
      this.cityMarkers = [];
    }
  }
  private updateCityVisibility() {
    if (!this.citiesReady) return;
    const zoom = this.map.getZoom();
    const width = this.map.getContainer().clientWidth;
    const height = this.map.getContainer().clientHeight;
    const mapRect = this.map.getContainer().getBoundingClientRect();
    const occupied = this.cityObstacles().flatMap((node) => {
      const rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height || getComputedStyle(node).visibility === 'hidden') return [];
      return [
        {
          left: rect.left - mapRect.left - 5,
          top: rect.top - mapRect.top - 5,
          right: rect.right - mapRect.left + 5,
          bottom: rect.bottom - mapRect.top + 5,
        },
      ];
    });
    let visibleCount = 0;
    for (const city of this.cityMarkers) {
      const element = city.marker?.getElement();
      const pinned =
        !!element && (element === document.activeElement || element === this.selectedCityElement);
      const eligible =
        this.showCities &&
        (pinned || city.anchor || zoom >= (CITY_TIER_ZOOM[city.tier] ?? CITY_TIER_ZOOM[3]!));
      // Project the closest world copy, including when panning across the date line.
      const lng = city.lng + Math.round((this.map.getCenter().lng - city.lng) / 360) * 360;
      const point = this.map.project([lng, city.lat]);
      const labelWidth = city.name.length * 7.5 + 24;
      const box = {
        left: point.x - labelWidth / 2 - 4,
        top: point.y - 14,
        right: point.x + labelWidth / 2 + 4,
        bottom: point.y + 14,
      };
      const outside = box.right < 0 || box.left > width || box.bottom < 0 || box.top > height;
      const overlaps = occupied.some(
        (used) =>
          box.left < used.right &&
          box.right > used.left &&
          box.top < used.bottom &&
          box.bottom > used.top,
      );
      const visible =
        eligible && !outside && (!overlaps || pinned) && (visibleCount < 160 || pinned);
      if (visible) {
        if (!city.marker) {
          const button = document.createElement('button');
          button.type = 'button';
          button.setAttribute('aria-label', `Explore city ${city.name}, ${city.country}`);
          button.className = `city-marker tier-${city.tier}${city.capital ? ' capital' : ''}${city.anchor ? ' anchor' : ''}`;
          const dot = document.createElement('span');
          dot.className = 'city-dot';
          const label = document.createElement('span');
          label.className = 'city-name';
          label.textContent = city.name;
          button.append(dot, label);
          city.marker = new maplibregl.Marker({ element: button, anchor: 'center' });
          button.addEventListener('click', (e) => {
            e.stopPropagation();
            this.selectedCityElement?.classList.remove('selected');
            this.selectedCityElement = button;
            button.classList.add('selected');
            this.onCity?.({
              name: city.name,
              country: city.country,
              capital: city.capital,
              population: city.population,
              lng: city.lng,
              lat: city.lat,
            });
          });
          button.addEventListener('focusin', () => this.scheduleCityVisibility());
          button.addEventListener('focusout', () => this.scheduleCityVisibility());
        }
        city.marker.setLngLat([lng, city.lat]);
        if (!city.mounted) city.marker.addTo(this.map);
        city.mounted = true;
        occupied.push(box);
        visibleCount++;
      } else if (city.mounted) {
        city.marker?.remove();
        city.mounted = false;
      }
    }
  }
  private scheduleCityVisibility() {
    if (this.cityFrame !== undefined) cancelAnimationFrame(this.cityFrame);
    this.cityFrame = requestAnimationFrame(() => {
      this.cityFrame = undefined;
      this.updateCityVisibility();
    });
  }
  cities(enabled: boolean) {
    this.showCities = enabled;
    this.scheduleCityVisibility();
  }
  focusCity(lng: number, lat: number) {
    this.map.easeTo({
      center: [lng, lat],
      zoom: Math.max(this.map.getZoom(), 5),
    });
  }
  /** Ease to an event only when it is outside the current viewport. */
  reveal(lon: number, lat: number) {
    if (!this.ready || !Number.isFinite(lon) || !Number.isFinite(lat)) return;
    const [w, s, e, n] = this.bounds();
    if (lon >= w && lon <= e && lat >= s && lat <= n) return;
    this.map.easeTo({
      center: [lon, lat],
      zoom: Math.max(this.map.getZoom(), 3.2),
      duration: reducedMotion() || this.reduceMotion ? 0 : 700,
    });
  }
  private updateTooltip(
    point: { x: number; y: number },
    event?: Record<string, unknown>,
    cluster?: Record<string, unknown>,
    country?: Record<string, unknown>,
  ) {
    const box = this.map.getContainer();
    if (event?.title) {
      const cat = String(event.category || '').toLowerCase();
      this.setTooltip(
        `<span class="tt-title">${escapeHtml(String(event.title))}</span>` +
          `<span class="tt-meta"><span class="category-dot cat-${escapeHtml(cat)}"></span>` +
          `${escapeHtml(String(event.category || ''))}` +
          (event.time ? ` · ${escapeHtml(agoLabel(String(event.time)))}` : '') +
          (event.precision === 'country'
            ? ' · Country-level position'
            : event.precision === 'exact'
              ? ''
              : ' · regional position') +
          (this.palette === 'command' && event.scaleLabel
            ? ` · ${escapeHtml(String(event.scaleLabel))}`
            : '') +
          `</span>`,
      );
    } else if (cluster?.point_count) {
      this.setTooltip(
        `<span class="tt-title">${Number(cluster.point_count)} reports</span>` +
          `<span class="tt-meta">Click to expand${this.palette === 'command' && Number(cluster.conflictRank) >= 0 ? ' · Highest reported scale: ' + conflictStyle(Number(cluster.conflictRank)).label : ''}</span>`,
      );
    } else if (country?.name) {
      this.setTooltip(
        `<span class="tt-title">${escapeHtml(String(country.name))}</span>` +
          `<span class="tt-meta">${this.palette === 'command' ? 'Geographic context · use Areas to focus' : 'Click to filter reports'}</span>`,
      );
    } else {
      this.hideTooltip();
      return;
    }
    // Position after content update; clamp inside the container with a margin.
    const x = Math.min(point.x + 14, box.clientWidth - this.tooltip.offsetWidth - 10);
    const y = Math.max(point.y - this.tooltip.offsetHeight - 12, 8);
    this.tooltip.style.left = `${Math.max(x, 8)}px`;
    this.tooltip.style.top = `${y}px`;
  }
  private setTooltip(html: string) {
    this.tooltip.innerHTML = html;
    this.map.getContainer().append(this.tooltip);
    this.tooltip.classList.add('visible');
  }
  private hideTooltip() {
    this.tooltip.classList.remove('visible');
  }
  private grid(): GeoJSON.FeatureCollection {
    const features: GeoJSON.Feature[] = [];
    for (let lng = -180; lng <= 180; lng += 30)
      features.push({
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: [
            [lng, -80],
            [lng, 80],
          ],
        },
      });
    for (let lat = -60; lat <= 60; lat += 30)
      features.push({
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: [
            [-180, lat],
            [180, lat],
          ],
        },
      });
    return { type: 'FeatureCollection', features };
  }
  private updateClusterLabels() {
    for (const marker of this.clusterLabels) marker.remove();
    this.clusterLabels = [];
    if (!this.ready || !this.showEvents) return;
    const seen = new Set<number>();
    for (const f of this.map.querySourceFeatures('events', {
      filter: ['has', 'point_count'],
    })) {
      const id = f.properties?.cluster_id;
      if (typeof id !== 'number' || seen.has(id) || f.geometry.type !== 'Point') continue;
      seen.add(id);
      const label = document.createElement('span');
      label.className = 'cluster-count';
      label.textContent = String(f.properties?.point_count);
      this.clusterLabels.push(
        new maplibregl.Marker({ element: label })
          .setLngLat(f.geometry.coordinates as [number, number])
          .addTo(this.map),
      );
    }
  }
  private labels() {
    for (const [text, lng, lat] of [
      ['NORTH AMERICA', -105, 48],
      ['SOUTH AMERICA', -59, -15],
      ['EUROPE', 18, 52],
      ['AFRICA', 22, 10],
      ['ASIA', 94, 43],
      ['OCEANIA', 140, -26],
      ['PACIFIC OCEAN', -142, 4],
      ['ATLANTIC OCEAN', -34, 22],
      ['INDIAN OCEAN', 74, -25],
    ] as const) {
      const label = document.createElement('span');
      label.className = text.includes('OCEAN') ? 'map-label ocean-label' : 'map-label';
      label.textContent = text;
      new maplibregl.Marker({ element: label }).setLngLat([lng, lat]).addTo(this.map);
    }
  }
  private geo(events: PulseEvent[]): GeoJSON.FeatureCollection {
    return {
      type: 'FeatureCollection',
      features: events
        .filter(
          (e) =>
            e.location &&
            ['exact', 'region', 'country'].includes(e.location.precision) &&
            Number.isFinite(e.location.lon) &&
            Math.abs(e.location.lon) <= 180 &&
            Number.isFinite(e.location.lat) &&
            Math.abs(e.location.lat) <= 85,
        )
        .map((e) => ({
          type: 'Feature',
          properties: {
            id: e.id,
            title: e.title,
            category: e.category,
            kind: conflictKind(e) || 'other',
            ...(this.palette === 'command'
              ? conflictMapProperties(e, this.waveCursor ?? Date.now())
              : {
                  conflictRank: -1,
                  waveRank: -1,
                  waveCountry: 0,
                  waveExpires: 0,
                  waveUntil0: 0,
                  waveUntil1: 0,
                  waveUntil2: 0,
                  waveUntil3: 0,
                }),
            precision: e.location!.precision,
            time: e.publishedAt || e.firstSeenAt || e.fetchedAt || '',
          },
          geometry: {
            type: 'Point',
            coordinates: [e.location!.lon, e.location!.lat],
          },
        })),
    };
  }
  update(events: PulseEvent[], background: PulseEvent[] = [], selected = '') {
    this.events = events;
    this.background = background;
    this.selected = selected;
    if (!this.ready) return;
    (this.map.getSource('events') as GeoJSONSource).setData(this.geo(events));
    (this.map.getSource('background-events') as GeoJSONSource).setData(this.geo(background));
    this.map.setPaintProperty('events', 'circle-stroke-width', [
      'case',
      ['==', ['get', 'id'], selected],
      2.5,
      0.7,
    ]);
    this.map.setPaintProperty('event-rings', 'circle-radius', [
      'case',
      ['==', ['get', 'id'], selected],
      14,
      8,
    ]);
    this.layers(this.showEvents, this.showContext);
  }
  layers(events: boolean, context: boolean) {
    this.showEvents = events;
    this.showContext = context;
    if (!this.ready) return;
    for (const layer of ['events', 'event-rings', 'clusters'])
      this.map.setLayoutProperty(layer, 'visibility', events ? 'visible' : 'none');
    this.map.setLayoutProperty('background-events', 'visibility', context ? 'visible' : 'none');
    this.updateClusterLabels();
    this.syncWaves();
  }
  private loadDetailedGeography() {
    if (!this.ready || this.map.getZoom() < 4 || this.map.getSource('land-detail')) return;
    this.map.addSource('land-detail', { type: 'geojson', data: '/data/pulse-land-10m.geojson' });
    this.map.addLayer(
      {
        id: 'land-detail',
        type: 'fill',
        source: 'land-detail',
        minzoom: 4,
        paint: { 'fill-color': this.palette === 'command' ? '#1c3528' : '#fafbf7' },
      },
      'borders',
    );
    this.map.addSource('coastline-detail', {
      type: 'geojson',
      data: '/data/pulse-coastline-10m.geojson',
    });
    this.map.addLayer(
      {
        id: 'coastline-detail',
        type: 'line',
        source: 'coastline-detail',
        minzoom: 4,
        paint: { 'line-color': '#6a8976', 'line-width': 0.8, 'line-opacity': 0.7 },
      },
      'events',
    );
    this.map.on('sourcedata', (e) => {
      if (e.sourceId === 'land-detail' && e.isSourceLoaded) {
        this.map.setPaintProperty('land', 'fill-opacity', ['step', ['zoom'], 1, 4, 0]);
        this.map.getContainer().dataset.geography = 'detailed';
      }
    });
    this.map.setPaintProperty('borders', 'line-opacity', [
      'interpolate',
      ['linear'],
      ['zoom'],
      3,
      0.55,
      4,
      0.15,
    ]);
  }
  motion(reduce: boolean) {
    this.reduceMotion = reduce;
    this.syncWaves();
  }
  waveState(active: boolean, cursor: number | null) {
    this.waveActive = active;
    this.waveCursor = cursor;
    this.syncWaves();
  }
  private syncWaves() {
    this.waves?.configure(
      this.waveActive && this.showEvents && this.palette === 'command',
      this.reduceMotion,
      this.waveCursor,
    );
  }
  onCommand(callbacks: { area: (id: string) => void; vessel: (id: string) => void }) {
    this.commandCallbacks = callbacks;
  }
  private initMaritime() {
    this.map.addSource('vessels', {
      type: 'geojson',
      cluster: true,
      clusterRadius: 28,
      clusterMaxZoom: 4,
      data: { type: 'FeatureCollection', features: [] },
    });
    this.map.addSource('vessel-trail', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
    const canvas = document.createElement('canvas');
    canvas.width = 24;
    canvas.height = 24;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#bce6c4';
    ctx.strokeStyle = '#102719';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(12, 2);
    ctx.lineTo(19, 21);
    ctx.lineTo(12, 17);
    ctx.lineTo(5, 21);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    this.map.addImage('observed-vessel', ctx.getImageData(0, 0, 24, 24));
    this.map.addLayer({
      id: 'vessel-trail',
      type: 'line',
      source: 'vessel-trail',
      paint: {
        'line-color': '#b5d9bb',
        'line-width': 1.5,
        'line-opacity': 0.7,
        'line-dasharray': [2, 2],
      },
    });
    this.map.addLayer({
      id: 'vessel-clusters',
      type: 'circle',
      source: 'vessels',
      filter: ['has', 'point_count'],
      paint: {
        'circle-color': '#496f55',
        'circle-opacity': 0.7,
        'circle-stroke-color': '#bed6bd',
        'circle-stroke-width': 1,
        'circle-radius': ['step', ['get', 'point_count'], 5, 10, 8, 50, 12, 200, 17],
      },
    });
    this.map.addLayer({
      id: 'vessel-points',
      type: 'circle',
      source: 'vessels',
      filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-color': ['case', ['get', 'stale'], '#748b7b', '#b4d6bd'],
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 1.7, 5, 3],
        'circle-stroke-width': 0.5,
        'circle-stroke-color': '#15301f',
      },
    });
    this.map.addLayer({
      id: 'vessel-arrows',
      type: 'symbol',
      source: 'vessels',
      minzoom: 5,
      filter: ['has', 'heading'],
      layout: {
        'icon-image': 'observed-vessel',
        'icon-size': 0.7,
        'icon-rotate': ['get', 'heading'],
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': false,
      },
      paint: { 'icon-opacity': ['case', ['get', 'stale'], 0.4, 1] },
    });
    for (const a of STRATEGIC_AREAS.filter((a) => a.waterway)) {
      const label = document.createElement('button');
      label.type = 'button';
      label.className = 'waterway-marker';
      label.textContent = '◇ ' + a.short;
      label.setAttribute('aria-label', 'Focus ' + a.name);
      label.title = a.name + ' · observation area';
      label.hidden = !this.showWaterways;
      label.addEventListener('click', (e) => {
        e.stopPropagation();
        this.commandCallbacks?.area(a.id);
      });
      this.areaMarkers.push(
        new maplibregl.Marker({ element: label })
          .setLngLat([(a.bounds[0] + a.bounds[2]) / 2, (a.bounds[1] + a.bounds[3]) / 2])
          .addTo(this.map),
      );
    }
    this.maritime(this.maritimeData, this.showVessels, this.showWaterways, this.trailData);
  }
  maritime(
    vessels: VesselObservation[],
    visible: boolean,
    waterways: boolean,
    trail: VesselObservation[] = [],
    selectedVessel = '',
  ) {
    this.maritimeData = vessels;
    this.trailData = trail;
    this.showWaterways = waterways;
    this.showVessels = visible;
    if (!this.ready || !this.map.getSource('vessels')) return;
    this.map.setPaintProperty('vessel-points', 'circle-stroke-width', [
      'case',
      ['==', ['get', 'mmsi'], selectedVessel],
      3,
      0.5,
    ]);
    this.map.setPaintProperty('vessel-points', 'circle-stroke-color', [
      'case',
      ['==', ['get', 'mmsi'], selectedVessel],
      '#efd59d',
      '#15301f',
    ]);
    const features: GeoJSON.Feature[] = vessels.map((v) => ({
      type: 'Feature',
      properties: {
        mmsi: v.mmsi,
        ...(v.heading === undefined ? {} : { heading: v.heading }),
        stale: !!v.stale,
      },
      geometry: { type: 'Point', coordinates: [v.lon, v.lat] },
    }));
    (this.map.getSource('vessels') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features,
    });
    const lines: GeoJSON.Feature[] = [];
    for (let i = 1; i < trail.length; i++) {
      const a = trail[i - 1]!,
        b = trail[i]!;
      if (
        Date.parse(b.observedAt) - Date.parse(a.observedAt) > 10 * 60000 ||
        Math.abs(a.lon - b.lon) > 180
      )
        continue;
      lines.push({
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: [
            [a.lon, a.lat],
            [b.lon, b.lat],
          ],
        },
      });
    }
    (this.map.getSource('vessel-trail') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: lines,
    });
    for (const layer of ['vessel-points', 'vessel-arrows', 'vessel-trail', 'vessel-clusters'])
      this.map.setLayoutProperty(layer, 'visibility', visible ? 'visible' : 'none');
    for (const m of this.areaMarkers) m.getElement().hidden = !waterways;
  }
  theme(theme: 'reading' | 'command') {
    this.palette = theme;
    if (!this.ready) return;
    const dark = theme === 'command';
    if (this.map.getLayer('land-detail'))
      this.map.setPaintProperty('land-detail', 'fill-color', dark ? '#1c3528' : '#fafbf7');
    const rankColors: ExpressionSpecification = [
      'match',
      ['get', 'conflictRank'],
      3,
      '#f06b68',
      2,
      '#f39350',
      1,
      '#e1b55d',
      '#c9d0cf',
    ];
    const commandColors: ExpressionSpecification = [
      'case',
      ['>=', ['get', 'conflictRank'], 0],
      rankColors,
      ['==', ['get', 'kind'], 'ceasefire'],
      '#e0b568',
      '#819b89',
    ];
    const clusterColors: ExpressionSpecification = [
      'case',
      ['>=', ['get', 'conflictRank'], 0],
      rankColors,
      '#274d35',
    ];
    this.map.setPaintProperty('events', 'circle-color', dark ? commandColors : colors);
    this.map.setPaintProperty('event-rings', 'circle-color', dark ? commandColors : colors);
    for (const [layer, property, value] of [
      ['ocean', 'background-color', dark ? '#091711' : '#e3eae8'],
      ['land', 'fill-color', dark ? '#1c3528' : '#fafbf7'],
      ['borders', 'line-color', dark ? '#577961' : '#899e93'],
      ['graticule', 'line-color', dark ? '#3b5c45' : '#b3c3b9'],
      ['hover-country', 'fill-color', dark ? '#91c99b' : '#25634b'],
      ['clusters', 'circle-color', dark ? clusterColors : '#e3eee5'],
      ['clusters', 'circle-stroke-color', dark ? '#bdd0bf' : '#42755b'],
    ] as const)
      this.map.setPaintProperty(layer, property, value);
  }
  focusBounds(
    bounds: [number, number, number, number],
    padding: number | { top: number; bottom: number; left: number; right: number } = 65,
  ) {
    this.map.fitBounds(
      [
        [bounds[0], bounds[1]],
        [bounds[2], bounds[3]],
      ],
      { padding, maxZoom: 8, duration: reducedMotion() || this.reduceMotion ? 0 : 700 },
    );
  }
  restore(camera: Camera) {
    this.map.jumpTo({ center: [camera.lng, camera.lat], zoom: camera.zoom });
  }
  zoom(delta: number) {
    this.map.easeTo({
      zoom: this.map.getZoom() + delta,
      duration:
        this.reduceMotion || matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 250,
    });
  }
  reset() {
    this.map.fitBounds(
      [
        [-178, -57],
        [178, 78],
      ],
      { padding: 30, duration: reducedMotion() || this.reduceMotion ? 0 : 700 },
    );
  }
  bounds(): [number, number, number, number] {
    const b = this.map.getBounds();
    return [
      Math.max(-180, b.getWest()),
      Math.max(-85, b.getSouth()),
      Math.min(180, b.getEast()),
      Math.min(85, b.getNorth()),
    ];
  }
}
