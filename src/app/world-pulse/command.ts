import { conflictVisual, CONFLICT_STYLES } from '../../services/world-pulse/conflict-visual';
import { CommandTimeline } from './command-timeline';
import { CommandPortfolio } from './command-portfolio';
import { sourceOutlet, assessReport } from '../../../shared/world-pulse-quality';
import { PulseMap } from '../../components/world-pulse/map';
import {
  STRATEGIC_AREAS,
  strategicArea,
  type StrategicArea,
} from '../../../shared/world-pulse-strategic';
import {
  conflictKind,
  eventInArea,
  eventTime,
  reportsAt,
  type MaritimeSnapshot,
  type SituationSnapshot,
  type ObservationSource,
  type TimelineSnapshot,
} from '../../../shared/world-pulse-command';
import type { PulseEvent, PulseSnapshot } from '../../../shared/world-pulse';
import { defaultModeState, filterEvents, type AppState } from '../../services/world-pulse/model';
import { button, el, ago, date, link, setChildren, preservePanel } from './dom';

/** A separately mounted workspace: changing its focus never rewrites reading filters. */
export class CommandView {
  readonly element = el('main', {
    class: 'command-workspace',
    hidden: true,
    'aria-label': 'Command workspace',
  });
  private canvas = el('div', {
    class: 'command-map',
    role: 'region',
    'aria-label': 'Situation map',
  });
  private left = el('aside', {
    class: 'command-left command-panel',
    'aria-label': 'Observation areas and signals',
  });
  private right = el('aside', {
    class: 'command-right command-panel',
    'aria-label': 'Situation details',
  });
  private status = el('span', { class: 'command-status' }, 'MAP INITIALIZING');
  private title = el('h1', {}, 'Global overview');
  private subtitle = el('p', {}, 'A source-led view of a changing world.');
  private metrics = el('div', {
    class: 'command-telemetry',
    'aria-label': 'Current focus metrics',
  });
  private areaList = el('div', { class: 'command-area-list' });
  private signals = el('div', { class: 'command-signals' });
  private map?: PulseMap;
  private snapshot?: PulseSnapshot;
  private maritime?: MaritimeSnapshot;
  private situation?: SituationSnapshot;
  private active = false;
  private previous?: { lng: number; lat: number; zoom: number };
  private requestId = 0;
  private controller?: AbortController;
  private timer?: ReturnType<typeof setInterval>;
  private lastSituation = 0;
  private selectedEvent = '';
  private selectedVessel = '';
  private apiError = '';
  private layerControls = el('div', {
    class: 'command-layer-controls',
    'aria-label': 'Situation map layers',
  });
  private query = '';
  private timeline: CommandTimeline;
  private portfolio: CommandPortfolio;
  private timelineData?: TimelineSnapshot;
  private lastTimeline = 0;
  constructor(
    private getState: () => AppState,
    private save: () => void,
    private openEvent: (event: PulseEvent) => void,
    openCompany: (id: string) => void,
  ) {
    this.timeline = new CommandTimeline(
      () => this.settings.hours,
      () => this.seek(),
    );
    this.portfolio = new CommandPortfolio(getState, openCompany, openEvent);
    const search = el('input', {
      type: 'search',
      placeholder: 'Search areas & signals…',
      'aria-label': 'Search command observations',
      oninput: () => {
        this.query = search.value;
        this.renderAreas();
        this.renderDetails();
        this.updateMap();
      },
    });
    const layout = el(
      'select',
      {
        'aria-label': 'Command layout',
        onchange: () => {
          this.settings.layout = layout.value as 'balanced' | 'map' | 'analysis';
          this.save();
          this.applyLayout();
        },
      },
      ...[
        ['balanced', 'Balanced'],
        ['map', 'Map first'],
        ['analysis', 'Analysis'],
      ].map(([value, label]) => el('option', { value }, label)),
    );
    const regionSelect = el(
      'select',
      {
        'aria-label': 'Focus observation area',
        class: 'command-area-select',
        onchange: () => this.selectArea(regionSelect.value),
      },
      ...STRATEGIC_AREAS.map((a) => el('option', { value: a.id }, a.name)),
    );
    const hours = el(
      'select',
      {
        'aria-label': 'Command time range',
        onchange: () => {
          this.settings.hours = Number(hours.value);
          this.save();
          this.timeline.live();
          this.lastTimeline = 0;
        },
      },
      ...[
        [1, '1 hour'],
        [6, '6 hours'],
        [24, '24 hours'],
        [168, '7 days'],
      ].map(([v, label]) => el('option', { value: v }, String(label))),
    );
    hours.value = String(this.settings.hours);
    for (const [key, label] of [
      ['conflicts', 'Conflict reports'],
      ['waterways', 'Waterways'],
      ['vessels', 'Observed vessels'],
      ['cities', 'Cities'],
    ] as const) {
      const b = button(
        label,
        () => {
          this.settings.layers[key] = !this.settings.layers[key];
          this.save();
          this.updateLayers();
          this.updateMap();
        },
        'layer-chip',
        { 'data-command-layer': key },
      );
      this.layerControls.append(b);
    }
    this.element.append(
      this.canvas,
      el(
        'div',
        { class: 'command-toolbar' },
        el(
          'div',
          { class: 'command-identity' },
          el('span', { class: 'eyebrow' }, 'WORLD PULSE / OBSERVATORY'),
          this.title,
          this.subtitle,
        ),
        el(
          'div',
          { class: 'command-actions' },
          regionSelect,
          hours,
          layout,
          button(
            'Signals',
            () => {
              const signals = this.element.dataset.mobilePanel !== 'signals';
              this.element.dataset.mobilePanel = signals ? 'signals' : 'brief';
              const d = this.left.querySelector<HTMLDetailsElement>('details');
              if (signals && d) d.open = false;
            },
            'mobile-signals',
            { 'aria-label': 'Toggle signals panel' },
          ),
          button(
            '⛶',
            () => {
              if (document.fullscreenElement) void document.exitFullscreen();
              else void this.element.requestFullscreen().catch(() => {});
            },
            '',
            { 'aria-label': 'Fullscreen command view' },
          ),
        ),
      ),
      this.metrics,
      this.left,
      this.right,
      this.layerControls,
      el(
        'div',
        { class: 'command-map-tools' },
        button('+', () => this.map?.zoom(1), '', { 'aria-label': 'Command zoom in' }),
        button('−', () => this.map?.zoom(-1), '', { 'aria-label': 'Command zoom out' }),
        button(
          '↶',
          () => {
            if (this.previous) this.map?.restore(this.previous);
          },
          '',
          { 'aria-label': 'Previous map view' },
        ),
        button('◎', () => this.selectArea('global'), '', { 'aria-label': 'Global view' }),
      ),
      el(
        'div',
        { class: 'command-bottom' },
        this.status,
        el('span', {}, 'SOURCE-LED / PARTIAL COVERAGE'),
        button('Restore panels', () => {
          this.settings.layout = 'balanced';
          this.save();
          this.applyLayout();
        }),
      ),
    );
    this.left.append(
      el(
        'div',
        { class: 'command-panel-title' },
        el('span', {}, '01 / AREAS & SIGNALS'),
        el('span', { class: 'status-dot' }),
      ),
      search,
      el(
        'details',
        { class: 'command-areas', open: true },
        el('summary', {}, 'Observation areas'),
        this.areaList,
      ),
      this.signals,
    );
    this.element.append(this.timeline.element);
    const motion = button(
      'Motion: on',
      () => {
        this.settings.reducedMotion = !this.settings.reducedMotion;
        this.save();
        this.updateLayers();
      },
      'motion-toggle',
      { 'aria-label': 'Reduce command motion' },
    );
    this.element.querySelector('.command-actions')!.append(motion);
    const width = el('input', {
      type: 'range',
      min: 260,
      max: 380,
      step: 10,
      value: this.settings.panelWidth || 286,
      'aria-label': 'Command panel width',
      oninput: () => {
        this.settings.panelWidth = Number(width.value);
        this.save();
        this.applyLayout();
      },
    });
    this.left.append(el('label', { class: 'command-width' }, 'Brief panel width', width));
    this.renderAreas();
    this.applyLayout();
    this.updateLayers();
  }
  private get settings() {
    return this.getState().workspace.command;
  }
  private get area(): StrategicArea {
    return strategicArea(this.settings.region) || STRATEGIC_AREAS[0]!;
  }
  private applyLayout() {
    this.element.dataset.layout = this.settings.layout;
    this.element.style.setProperty(
      '--command-right-width',
      (this.settings.panelWidth || (this.settings.layout === 'analysis' ? 350 : 286)) + 'px',
    );
    const layout = this.element.querySelector<HTMLSelectElement>('[aria-label="Command layout"]');
    if (layout) layout.value = this.settings.layout;
  }
  private updateLayers() {
    this.element.classList.toggle('reduce-motion', this.settings.reducedMotion);
    this.map?.motion(this.settings.reducedMotion);
    const motion = this.element.querySelector<HTMLButtonElement>('.motion-toggle');
    if (motion) {
      motion.textContent = this.settings.reducedMotion ? 'Motion: reduced' : 'Motion: on';
      motion.setAttribute('aria-pressed', String(this.settings.reducedMotion));
    }
    for (const b of this.layerControls.querySelectorAll<HTMLButtonElement>('button')) {
      const k = b.dataset.commandLayer as keyof typeof this.settings.layers;
      b.classList.toggle('active', this.settings.layers[k]);
      b.setAttribute('aria-pressed', String(this.settings.layers[k]));
    }
    this.map?.cities(this.settings.layers.cities);
  }
  private renderAreas() {
    this.areaList.replaceChildren(
      ...STRATEGIC_AREAS.filter((a) =>
        `${a.name} ${a.aliases.join(' ')}`.toLowerCase().includes(this.query.toLowerCase()),
      ).map((a) =>
        button(
          `${a.waterway ? '◇' : '⊕'} ${a.name}`,
          () => this.selectArea(a.id),
          `command-area ${this.settings.region === a.id ? 'active' : ''}`,
          { 'data-area': a.id },
        ),
      ),
    );
  }
  selectArea(id: string) {
    const area = strategicArea(id);
    if (!area) return;
    this.previous = { ...this.settings.camera };
    this.settings.region = id;
    this.selectedEvent = '';
    this.selectedVessel = '';
    this.maritime = undefined;
    this.timelineData = undefined;
    this.lastTimeline = 0;
    this.save();
    const width = this.element.clientWidth,
      height = this.element.clientHeight;
    const padding =
      width >= 1200 && this.settings.layout !== 'map'
        ? {
            left: 290,
            right: this.settings.layout === 'analysis' ? 390 : 325,
            top: 195,
            bottom: 230,
          }
        : width < 680
          ? { left: 25, right: 25, top: 150, bottom: Math.min(395, height * 0.5) }
          : { left: 40, right: this.settings.layout === 'map' ? 40 : 300, top: 165, bottom: 225 };
    this.map?.focusBounds(area.bounds, padding);
    this.renderAreas();
    this.renderDetails();
    this.updateMap();
    void this.refresh();
  }
  setActive(active: boolean) {
    this.active = active;
    this.map?.waveState(active && this.settings.layers.conflicts, this.timeline.at);
    this.element.hidden = !active;
    clearInterval(this.timer);
    this.controller?.abort();
    if (!active) this.timeline.pause();
    if (active && !this.map) {
      try {
        this.map = new PulseMap(this.canvas, this.settings.camera, {
          event: (id) => {
            this.selectedEvent = id;
            this.selectedVessel = '';
            this.right.scrollTop = 0;
            this.renderDetails();
            this.updateMap();
          },
          country: (_code, name) => {
            this.status.textContent = `${name} · country context; select an observation area to filter`;
          },
          city: (city) => this.map?.focusCity(city.lng, city.lat),
          camera: (camera) => {
            this.settings.camera = camera;
            this.save();
          },
          status: (text) => {
            this.status.textContent = text.toUpperCase();
          },
        });
        this.map.theme('command');
        this.map.cities(this.settings.layers.cities);
        this.map.onCommand({
          area: (id) => this.selectArea(id),
          vessel: (id) => this.selectVessel(id),
        });
      } catch {
        this.status.textContent = 'MAP UNAVAILABLE · OBSERVATIONS REMAIN IN THE LIST';
      }
    }
    if (active) {
      this.map?.restore(this.settings.camera);
      const hours = this.element.querySelector<HTMLSelectElement>(
        '[aria-label="Command time range"]',
      );
      if (hours) hours.value = String(this.settings.hours);
      const width = this.element.querySelector<HTMLInputElement>(
        '[aria-label="Command panel width"]',
      );
      if (width) width.value = String(this.settings.panelWidth || 286);
      this.renderAreas();
      this.applyLayout();
      this.updateLayers();
      this.renderDetails();
      this.updateMap();
      void this.refresh();
      this.timer = setInterval(() => {
        if (!document.hidden) void this.refresh();
      }, 10000);
      void this.portfolio.refresh();
    }
  }
  private selectVessel(id: string) {
    this.selectedVessel = id;
    this.selectedEvent = '';
    this.right.scrollTop = 0;
    this.renderDetails();
    void this.refresh();
  }
  update(snapshot: PulseSnapshot) {
    this.snapshot = snapshot;
    if (this.active) {
      this.renderDetails();
      this.updateMap();
    }
  }
  private seek() {
    this.maritime = undefined;
    this.selectedEvent = '';
    this.renderDetails();
    this.updateMap();
    void this.refresh();
  }
  private allAreaEvents(): PulseEvent[] {
    return filterEvents(
      this.snapshot?.events || [],
      'world',
      { ...defaultModeState(), hours: this.settings.hours, coverage: 'all' },
      [],
    ).filter((e) => eventInArea(e, this.area));
  }
  private events(): PulseEvent[] {
    const retained =
      this.timeline.at === null
        ? this.snapshot?.events || []
        : reportsAt(this.snapshot?.events || [], this.timeline.time);
    const events = filterEvents(
      retained,
      'world',
      { ...defaultModeState(), hours: 168, coverage: 'all' },
      [],
      this.timeline.time,
    );
    const retentionCutoff = Date.now() - this.settings.hours * 3600000;
    return events
      .filter(
        (e) =>
          eventTime(e) > retentionCutoff &&
          eventInArea(e, this.area) &&
          (!this.query ||
            `${e.title} ${e.summary}`.toLowerCase().includes(this.query.toLowerCase())),
      )
      .sort((a, b) => eventTime(b) - eventTime(a));
  }
  private async refresh() {
    if (!this.active) return;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const id = ++this.requestId;
    const q = new URLSearchParams({ region: this.area.id });
    if (this.timeline.at !== null) q.set('at', new Date(this.timeline.at).toISOString());
    if (this.selectedVessel) q.set('mmsi', this.selectedVessel);
    const read = async <T>(path: string): Promise<T> => {
      const r = await fetch(path, { signal: controller.signal });
      if (!r.ok) throw Error('Observation service unavailable');
      return (await r.json()) as T;
    };
    try {
      const [maritime, situation, timeline] = await Promise.all([
        read<MaritimeSnapshot>('/api/world-pulse/maritime?' + q),
        Date.now() - this.lastSituation > 60000
          ? read<SituationSnapshot>('/api/world-pulse/situation')
          : Promise.resolve(this.situation),
        Date.now() - this.lastTimeline > 60000
          ? read<TimelineSnapshot>(
              '/api/world-pulse/timeline?region=' + encodeURIComponent(this.area.id),
            )
          : Promise.resolve(this.timelineData),
      ]);
      if (id !== this.requestId || !this.active) return;
      this.maritime = maritime;
      if (situation && situation !== this.situation) {
        this.situation = situation;
        this.lastSituation = Date.now();
      }
      if (timeline && timeline !== this.timelineData) {
        this.timelineData = timeline;
        this.lastTimeline = Date.now();
      }
      void this.portfolio.refresh();
      this.apiError = '';
      this.renderDetails();
      this.updateMap();
    } catch {
      if (controller.signal.aborted) return;
      this.apiError = 'Observation service unavailable. Last received data may be stale.';
      this.renderDetails();
    }
  }
  private updateMap() {
    const events = this.events();
    this.map?.waveState(this.active && this.settings.layers.conflicts, this.timeline.at);
    this.map?.update(
      this.settings.layers.conflicts
        ? events.filter((e) => conflictKind(e) || conflictVisual(e, this.timeline.time).concrete)
        : [],
      [],
      this.selectedEvent,
    );
    this.map?.maritime(
      this.maritime?.vessels || [],
      this.settings.layers.vessels,
      this.settings.layers.waterways,
      this.maritime?.trail || [],
      this.selectedVessel,
    );
  }
  private sourceCard(source: ObservationSource) {
    return el(
      'div',
      { class: `command-source source-${source.state}` },
      el(
        'div',
        {},
        link(source.name, source.url),
        el('span', { class: 'source-state' }, source.state),
      ),
      el('p', {}, source.message),
      el(
        'small',
        {},
        `Observed ${source.lastObservation ? date(source.lastObservation) : 'unavailable'} · synced ${source.lastSuccess ? ago(source.lastSuccess) : 'unavailable'}`,
      ),
    );
  }
  private renderDetails() {
    const area = this.area,
      events = this.events(),
      conflicts = events.filter(
        (e) => conflictKind(e) || conflictVisual(e, this.timeline.time).concrete,
      );
    this.title.textContent = area.name;
    this.subtitle.textContent = area.waterway
      ? 'Strategic passage / observed traffic & source reports'
      : 'Conflict reporting / strategic passages / your companies';
    const select = this.element.querySelector<HTMLSelectElement>('.command-area-select');
    if (select) select.value = area.id;
    this.metrics.replaceChildren(
      ...[
        [String(conflicts.length), 'conflict reports'],
        [this.maritime ? String(this.maritime.total) : '—', 'observed vessels'],
        [String(events.length), 'area reports'],
      ].map(([count, label]) => el('div', {}, el('strong', {}, count), el('span', {}, label))),
    );
    const selectedRaw = events.find((e) => e.id === this.selectedEvent);
    const selected = selectedRaw
      ? {
          ...selectedRaw,
          sources: selectedRaw.sources.filter(
            (source) =>
              !['blocked', 'C'].includes(
                assessReport({ title: selectedRaw.title, source }).quality,
              ),
          ),
        }
      : undefined;
    const vessel = this.maritime?.vessels.find((v) => v.mmsi === this.selectedVessel);
    const restoreRight = preservePanel(this.right),
      restoreSignals = preservePanel(this.signals);
    const notices = (this.situation?.notices || []).filter(
      (n) =>
        Date.parse(n.publishedAt) <= this.timeline.time &&
        (area.id === 'global' || n.areaIds.includes(area.id)),
    );
    this.timeline.update(
      this.allAreaEvents(),
      this.maritime?.coverage || this.timelineData?.coverage,
      this.timelineData,
    );
    this.portfolio.update(events, this.timeline.at !== null);
    setChildren(
      this.signals,
      el('div', { class: 'command-panel-title' }, `SIGNALS / ${conflicts.length}`),
      ...conflicts.slice(0, 24).map((e) => {
        const card = button(
          '',
          () => {
            this.selectedEvent = e.id;
            this.selectedVessel = '';
            this.right.scrollTop = 0;
            this.renderDetails();
            this.updateMap();
          },
          `command-signal ${this.selectedEvent === e.id ? 'selected' : ''}`,
          { 'data-command-event': e.id },
        );
        card.append(
          el(
            'span',
            { class: `signal-kind kind-${conflictKind(e)}` },
            conflictKind(e) === 'ceasefire' ? 'CEASEFIRE REPORT' : 'CONFLICT REPORT',
          ),
          el('strong', {}, e.title),
          el(
            'small',
            {},
            `${this.timeline.at === null ? ago(e.publishedAt || e.firstSeenAt || e.fetchedAt) : date(e.publishedAt || e.firstSeenAt || e.fetchedAt)} · ${e.location?.precision || 'unlocated'}`,
          ),
        );
        return card;
      }),
      conflicts.length
        ? null
        : el(
            'p',
            { class: 'command-muted' },
            'No matching conflict reports in this coverage window. This is not a measure of safety.',
          ),
    );
    setChildren(
      this.right,
      el('div', { class: 'command-panel-title' }, '02 / OBSERVATION BRIEF'),
      selected
        ? el(
            'section',
            { class: 'command-evidence' },
            el(
              'span',
              { class: 'command-kicker' },
              conflictKind(selected) === 'ceasefire' ? 'CEASEFIRE REPORTING' : 'REPORTED CONFLICT',
            ),
            el('h2', {}, selected.title),
            el('p', { class: 'command-muted' }, selected.summary),
            el(
              'p',
              { class: 'command-note' },
              `${new Set(selected.sources.map((s) => sourceOutlet(s).key)).size > 1 ? 'Multiple outlets report this' : 'Single-outlet reporting'} · classification describes reporting, not independent verification.`,
            ),
            el(
              'p',
              { class: 'command-note' },
              selected.location
                ? `${selected.location.precision.toUpperCase()} location · ${selected.location.evidence}`
                : 'Location unavailable · retained in the event list',
            ),
            ...selected.sources
              .slice(0, 5)
              .map((s) => link(s.publisher || s.name, s.url, 'command-source-link')),
            this.conflictEvidence(selected),
            button('Read full event →', () => this.openEvent(selected), 'command-open-reading'),
          )
        : null,
      vessel
        ? el(
            'section',
            { class: 'command-vessel' },
            el('span', { class: 'command-kicker' }, 'OBSERVED VESSEL'),
            el('h2', {}, vessel.name),
            el('p', { class: 'mono' }, `MMSI ${vessel.mmsi}`),
            el(
              'div',
              { class: 'command-vessel-facts' },
              el('span', {}, `${vessel.speed === undefined ? '—' : vessel.speed.toFixed(1)} kn`),
              el('span', {}, `${vessel.heading === undefined ? '—' : Math.round(vessel.heading)}°`),
            ),
            el(
              'p',
              { class: 'command-muted' },
              `${vessel.lat.toFixed(4)}°, ${vessel.lon.toFixed(4)}° · ${date(vessel.observedAt)}`,
            ),
            el(
              'p',
              { class: 'command-note' },
              vessel.stale
                ? 'Last observation is older than 15 minutes.'
                : 'Position from an AIS report. The trail connects retained observations only.',
            ),
          )
        : null,
      el('h2', {}, area.name),
      this.apiError ? el('p', { class: 'command-note warning' }, this.apiError) : null,
      el(
        'p',
        { class: 'command-muted' },
        this.maritime
          ? `${this.maritime.total} vessels observed in this area ${this.timeline.at === null ? 'within the last hour' : 'within the hour before the replay time'}. Ships without received AIS reports are not represented.`
          : this.timeline.at === null
            ? 'Waiting for vessel observations…'
            : 'Loading observations for the replay time…',
      ),
      this.maritime?.truncated
        ? el(
            'p',
            { class: 'command-note' },
            'Map capped at 2,000 recent vessels. Narrow the observation area.',
          )
        : null,
      el(
        'div',
        { class: 'command-vessel-list' },
        ...(this.maritime?.vessels || [])
          .slice(0, 8)
          .map((v) =>
            button(
              `${v.stale ? '○' : '▴'} ${v.name} · ${ago(v.observedAt)}`,
              () => this.selectVessel(v.mmsi),
              '',
              { 'data-vessel': v.mmsi },
            ),
          ),
      ),
      this.portfolio.element,
      ...this.transitCards(area),
      el('div', { class: 'command-panel-title' }, 'OFFICIAL NOTICES'),
      ...notices
        .slice(0, 6)
        .map((n) =>
          el(
            'article',
            { class: 'command-notice' },
            link(n.title, n.url),
            el('small', {}, date(n.publishedAt)),
          ),
        ),
      !notices.length
        ? el(
            'p',
            { class: 'command-muted' },
            'No retained matching notices. Check source status below.',
          )
        : null,
      this.conflictLegend(),
      el('div', { class: 'command-panel-title' }, 'CURRENT SOURCE HEALTH'),
      ...(this.maritime ? [this.sourceCard(this.maritime.source)] : []),
      ...(this.situation?.sources || [])
        .filter((s) => s.id !== 'aisstream')
        .map((s) => this.sourceCard(s)),
    );
    restoreRight();
    restoreSignals();
  }
  private conflictLegend() {
    return el(
      'details',
      { class: 'conflict-legend', 'data-disclosure-key': 'conflict-legend' },
      el('summary', {}, 'Conflict wave legend'),
      ...Object.values(CONFLICT_STYLES).map((style) =>
        el(
          'div',
          { class: 'conflict-legend-row' },
          el('i', { style: `--conflict-color:${style.color}` }),
          `${style.label} · ${style.radius}px`,
        ),
      ),
      el(
        'p',
        { class: 'command-muted' },
        'Wave size is a visual scale, not a blast radius, front line or affected area. Dashed rings indicate country-level positions. Groups use the highest eligible member scale; counts never enlarge a wave.',
      ),
    );
  }
  private conflictEvidence(event: PulseEvent) {
    const visual = conflictVisual(event, this.timeline.time);
    if (!visual.concrete) return null;
    const style = CONFLICT_STYLES[visual.scale];
    return el(
      'section',
      {
        class: 'conflict-scale-evidence',
        'data-conflict-scale': visual.scale,
        style: `--conflict-color:${style.color}`,
      },
      el('span', { class: 'command-kicker' }, 'REPORTED CONFLICT SCALE'),
      el('h3', {}, style.label),
      el('p', { class: 'command-muted' }, visual.reason),
      el(
        'p',
        { class: 'command-muted' },
        `${visual.countryLevel ? 'Country-level position · not an incident coordinate. ' : ''}Visual radius ${style.radius}px · not geographic extent.`,
      ),
      el('small', {}, `Latest qualifying report: ${date(visual.latestReportAt)}`),
      el(
        'details',
        { 'data-disclosure-key': 'conflict-evidence:' + event.id },
        el('summary', {}, 'Scale evidence & sources'),
        ...visual.evidence
          .slice()
          .sort((a, b) => Number(b.scale === visual.scale) - Number(a.scale === visual.scale))
          .slice(0, 8)
          .map((e) =>
            el(
              'article',
              { class: 'conflict-report-evidence' },
              link(e.source.publisher || e.source.name, e.source.url, 'command-source-link'),
              el(
                'p',
                {},
                e.phrase
                  ? `Explicit wording: “${e.phrase}”`
                  : 'No explicit scale wording; scale unknown.',
              ),
              el('p', { class: 'command-muted' }, e.title),
              el('small', {}, date(e.reportedAt)),
            ),
          ),
      ),
    );
  }
  private transitCards(area: StrategicArea) {
    const waterways = (this.situation?.waterways || []).filter(
      (w) =>
        area.id === 'global' ||
        w.id === area.id ||
        (area.id === 'gulf' && w.id === 'hormuz_strait') ||
        (area.id === 'red_sea' && ['suez', 'bab_el_mandeb'].includes(w.id)),
    );
    return waterways.length
      ? [
          el('div', { class: 'command-panel-title' }, 'DAILY TRANSIT OBSERVATIONS'),
          ...waterways.slice(0, area.id === 'global' ? 4 : 13).map((w) => {
            const days = w.days.filter((d) => Date.parse(d.date) <= this.timeline.time);
            const max = Math.max(1, ...days.map((d) => d.count || 0));
            return el(
              'section',
              { class: 'command-transit' },
              el('h3', {}, strategicArea(w.id)?.name || w.id),
              days.length
                ? el(
                    'div',
                    { class: 'transit-bars', role: 'img', 'aria-label': 'Daily transit counts' },
                    ...days.map((d) =>
                      el(
                        'div',
                        {
                          'data-date': d.date,
                          title: `${d.date}: ${d.count === null ? 'Unavailable' : d.count + ' transits'}`,
                        },
                        el('i', {
                          style: `height:${d.count === null ? 0 : Math.max(2, (d.count / max) * 48)}px`,
                        }),
                        el('span', {}, d.count === null ? '—' : String(d.count)),
                      ),
                    ),
                  )
                : el(
                    'p',
                    { class: 'command-muted' },
                    'No observations inside the retained seven-day window.',
                  ),
              el(
                'small',
                {},
                `Latest source date: ${w.source.lastObservation?.slice(0, 10) || 'unavailable'}. Daily data may lag.`,
              ),
            );
          }),
        ]
      : [];
  }
}
