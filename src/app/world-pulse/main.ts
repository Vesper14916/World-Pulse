import './pulse.css';
import './workspace.css';
import { CommandView } from './command';
import { ago, button, date, el, link, setChildren, type Child } from './dom';
import { attentionGauge } from '../../components/world-pulse/attention-gauge';
import { attentionForEvent, eventContentVersion } from '../../../shared/world-pulse-insights';
import { PulseMap, type CityPoint } from '../../components/world-pulse/map';
import {
  catalog,
  defaultAppState,
  defaultModeState,
  exportConfiguration,
  filterEvents,
  importConfiguration,
  loadState,
  matchCompanies,
  applyOutletPreferences,
  saveState,
  type AppState,
  type ModeState,
} from '../../services/world-pulse/model';
import type {
  PulseCategory,
  PulseCompany,
  PulseEvent,
  PulseExplanation,
  PulseMode,
  PulseSnapshot,
  PulseSort,
  PulseAssessment,
  PulseDirectory,
  PulseCompanyData,
  PulseAIStatus,
  PulseAIControl,
  PulseArticle,
  PulseCoverage,
  PulseReport,
  PulseMarketSnapshot,
  PulseCompanyProfile,
  PulseQuote,
  PulseCalendarItem,
  PulseCompanyLink,
} from '../../../shared/world-pulse';
import {
  assessReport,
  cleanHeadline,
  eventQuality,
  outletPreferences,
  reportTitle,
  sourceOutlet,
} from '../../../shared/world-pulse-quality';
import { CHINESE_NAMES, deriveReportingNames } from '../../../shared/company-names';
import {
  RADAR,
  companyEvents,
  coverageRegions,
  coverageTimeline,
  morningBrief,
  portfolioSummary,
  positionValue,
  radarFor,
  sinceReport,
} from '../../services/world-pulse/portfolio';

const categories: PulseCategory[] = ['World', 'Economy', 'Technology', 'Disasters'];
const names = new Intl.DisplayNames(['en'], { type: 'region' });
interface LocalAIConfig {
  apiUrl: string;
  model: string;
  inputPricePerMillion: number | null;
  outputPricePerMillion: number | null;
  keyConfigured: boolean;
}
let localAIConfig: LocalAIConfig | undefined;
let aiConfigRequest: Promise<void> | undefined;
function regionName(code: string) {
  try {
    return names.of(code) || code;
  } catch {
    return code;
  }
}
let initial: ReturnType<typeof loadState>;
try {
  initial = loadState(localStorage);
} catch {
  initial = { state: defaultAppState(), recovered: true };
}
let state: AppState = initial.state;
applyOutletPreferences(state);
let mode: PulseMode = readMode();
let snapshot: PulseSnapshot = {
  events: [],
  sources: [],
  fetchedAt: '',
  aiConfigured: false,
  aiControl: { enabled: false, configured: false, effective: false, inFlight: 0 },
};
let loaded = false;
let busy = false;
let connectionError = '';
let selected: PulseEvent | null = null;
const selectedByMode: Partial<Record<PulseMode, PulseEvent>> = {};
let displayed = 50;
let map: PulseMap | undefined;
let dialog: HTMLDialogElement | null = null;
const explanations = new Map<string, PulseExplanation>();
const explanationVersions = new Map<string, string>();
function eventVersion(e: PulseEvent) {
  return eventContentVersion(e);
}
const explanationErrors = new Map<string, string>();
const pendingAI = new Set<string>();
let aiViewEpoch = 0;
let aiViewContext = '';
function syncAIView() {
  const next = JSON.stringify([state.workspace.active, mode, selected?.id,
    current().list, current().selectedCompany, portfolioView]);
  if (aiViewContext && aiViewContext !== next) clearTransientAI();
  aiViewContext = next;
}
const aiViewRequests = new Set<AbortController>();
function clearTransientAI() {
  aiViewEpoch++;
  for (const controller of aiViewRequests) controller.abort();
  aiViewRequests.clear(); pendingAI.clear();
  explanations.clear(); explanationVersions.clear(); explanationErrors.clear();
  briefAI = undefined; briefError = ''; briefPending = false;
  document.querySelectorAll('.ai-content, .brief-ai, .event-indicators').forEach((node) => node.remove());
  for (const event of [...snapshot.events, ...Object.values(selectedByMode), selected]) {
    if (!event) continue;
    if (event.importance?.method === 'ai') delete event.importance;
    if (event.companyAssessments) {
      event.companyAssessments = Object.fromEntries(Object.entries(event.companyAssessments).filter(([, a]) => a.method !== 'ai'));
      if (!Object.keys(event.companyAssessments).length) delete event.companyAssessments;
    }
  }
}
window.addEventListener('pagehide', () => { clearTransientAI(); detail.replaceChildren(); board.replaceChildren(); });
window.addEventListener('pageshow', (event) => { if (event.persisted) render(); });
const articles = new Map<string, PulseArticle>();
const pendingArticles = new Set<string>();
const selectedArticleReports = new Map<string, string>();
// Portfolio market data (Finnhub via the local service). Quotes are never persisted in the browser.
let market: PulseMarketSnapshot | undefined;
let marketError = '';
let marketPending = false;
const profiles = new Map<string, PulseCompanyProfile & { quotes: Record<string, PulseQuote> }>();
const profilePending = new Set<string>();
const profileErrors = new Map<string, string>();
let calendarItems: PulseCalendarItem[] = [];
let calendarAt = 0;
let calendarPending = false;
let calendarError = '';
let portfolioView: 'overview' | 'map' = 'overview';
let briefAI: { key: string; text: string; generatedAt: string } | undefined;
let briefPending = false;
let briefError = '';
const reportPrices = new Map<string, number | null>();
let newsLayer = true;
let contextLayer = true;
let cityLayer = true;
let saveErrorShown = false;
function readMode(): PulseMode {
  const path = location.pathname.slice(1);
  return path === 'portfolio' || path === 'explore' ? path : 'world';
}
function current(): ModeState {
  return state.modes[mode];
}
function persist() {
  let ok = false;
  try {
    ok = saveState(localStorage, state);
  } catch {
    /* restricted storage */
  }
  if (!ok && !saveErrorShown) {
    saveErrorShown = true;
    toast('Local storage unavailable. Changes last for this session only.');
  }
}
function navigate(next: PulseMode, replace = false) {
  clearTransientAI();
  selectedByMode[mode] = selected || undefined;
  state.workspace.active = 'reading';
  state.workspace.lastReading = next;
  mode = next;
  selected = selectedByMode[mode] || null;
  displayed = 50;
  closeCityPanel();
  if (replace) history.replaceState({}, '', '/' + next);
  else if (location.pathname !== '/' + next) history.pushState({}, '', '/' + next);
  map?.restore(current().camera);
  applyWorkspace();
  persist();
  updateHeader();
  render();
  void fetchCompanyData();
  refreshPortfolioData();
}
/** Market data is requested only while Portfolio is open. */
function refreshPortfolioData(forceCalendar = false) {
  if (mode !== 'portfolio') return;
  void fetchMarket();
  void fetchCalendar(forceCalendar);
  const selectedCompany = state.companies.find((c) => c.id === current().selectedCompany);
  if (selectedCompany) void fetchProfile(selectedCompany.symbol);
}
window.addEventListener('popstate', () => {
  if(location.pathname === '/command') switchWorkspace('command', true);
  else navigate(readMode(), true);
});

const root = document.querySelector<HTMLElement>('#pulse-root')!;
const toastBox = el('div', {
  class: 'toast glass-floating glass-interactive',
  role: 'status',
  'aria-live': 'polite',
});
let toastTimer: ReturnType<typeof setTimeout>;
function toast(message: string, action?: { label: string; run: () => void }) {
  if (action) {
    toastBox.classList.add('has-action');
    setChildren(
      toastBox,
      el('span', {}, message),
      button(action.label, () => {
        action.run();
        toastBox.classList.remove('visible', 'has-action');
      }, 'toast-action'),
    );
  } else {
    toastBox.classList.remove('has-action');
    toastBox.textContent = message;
  }
  toastBox.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastBox.classList.remove('visible'), 5000);
}
const search = el('input', {
  type: 'search',
  'aria-label': 'Search World events',
  placeholder: 'Search world events…',
  oninput: () => {
    current().query = search.value;
    persist();
    render();
  },
});
const timeSelect = el(
  'select',
  {
    'aria-label': 'Time range',
    onchange: () => {
      current().hours = Number(timeSelect.value);
      persist();
      render();
    },
  },
  ...[
    [1, '1 hour'],
    [6, '6 hours'],
    [24, '24 hours'],
    [168, '7 days'],
  ].map(([v, label]) => el('option', { value: v }, String(label))),
);
const nav = el(
  'nav',
  { class: 'mode-nav', 'aria-label': 'Primary navigation' },
  ...(['world', 'portfolio', 'explore'] as PulseMode[]).map((m, i) =>
    button(m[0]!.toUpperCase() + m.slice(1), () => navigate(m), '', {
      'data-mode': m,
      'data-index': '0' + (i + 1),
    }),
  ),
);
const refreshButton = button('↻ Refresh', () => void fetchData(true), 'quiet');
const aiToggleButton = button('AI Off', () => {
  const enabled = snapshot.aiControl?.enabled ?? false;
  void changeAIEnabled(!enabled);
}, 'quiet ai-master-toggle', { 'aria-label': 'Toggle all AI functions' });
const header = el(
  'header',
  { class: 'topbar glass-shell glass-interactive' },
  el(
    'a',
    {
      class: 'brand',
      href: '/world',
      onclick: (e: Event) => {
        e.preventDefault();
        navigate('world');
      },
    },
    el('span', { class: 'brand-mark' }, '◈'),
    el('span', {}, 'WORLD', el('b', {}, 'PULSE')),
  ),
  el('nav', {class:'workspace-nav','aria-label':'Workspace'},
    button('Reading',()=>switchWorkspace('reading'),'',{'data-workspace-button':'reading'}),
    button('Command',()=>switchWorkspace('command'),'',{'data-workspace-button':'command'})),
  nav,
  el(
    'div',
    { class: 'top-tools' },
    el('label', { class: 'searchbox' }, el('span', { 'aria-hidden': true }, '⌕'), search),
    timeSelect,
    refreshButton,
    aiToggleButton,
    button('⚙ Settings', () => settings(), 'quiet'),
  ),
);
const side = el('aside', {
  class: 'sidebar',
  'aria-label': 'Mode controls and events',
});
const detail = el('aside', {
  class: 'detail glass-panel glass-interactive',
  'aria-label': 'Event details',
  hidden: true,
});
const mapEl = el('div', {
  class: 'map-canvas',
  'aria-label': 'Interactive world map',
  role: 'region',
});
const mapTitle = el('div', { class: 'map-heading glass-floating glass-interactive' });
const mapMeta = el('span', { class: 'mono' }, 'MAP INITIALIZING');
const coordinates = el('span', { class: 'mono' });
const areaButton = button(
  'Search this area',
  () => {
    if (!map) return;
    current().bounds = map.bounds();
    persist();
    render();
    toast('Explore now uses this map area.');
  },
  'area-button',
);
const mapTools = el(
  'div',
  { class: 'map-tools glass-controls glass-interactive', 'aria-label': 'Map tools' },
  button('+', () => map?.zoom(1), '', { 'aria-label': 'Zoom in' }),
  button('−', () => map?.zoom(-1), '', { 'aria-label': 'Zoom out' }),
  button('◎', () => map?.reset(), '', { 'aria-label': 'Reset map to global' }),
  button('Layers', () => layerDialog()),
  button('Legend', () => legendDialog()),
);
const boardReturn = button('← Portfolio overview', () => {
  portfolioView = 'overview';
  render();
}, 'board-return glass-floating', { hidden: true });
const mapStage = el(
  'section',
  { class: 'map-stage' },
  boardReturn,
  mapEl,
  mapTitle,
  el('div', { class: 'map-topnote' }, el('span', { class: 'status-dot' }), 'GEOGRAPHIC CONTEXT'),
  mapTools,
  areaButton,
  el('div', { class: 'map-caption' }, mapMeta, coordinates),
);
const board = el('section', { class: 'portfolio-board', 'aria-label': 'Portfolio overview' });
const workspace = el('main', { class: 'workspace' }, side, board, mapStage, detail);
const widthControl = el('input', {type:'range',min:280,max:520,step:10,value:state.workspace.readingWidth,'aria-label':'Reading column width',oninput:()=>{state.workspace.readingWidth=Number(widthControl.value);workspace.style.setProperty('--reading-width',widthControl.value+'px');persist();}});
mapTools.append(el('label',{class:'reading-resize'},'Column',widthControl));
const command = new CommandView(()=>state, persist, event=>{navigate('world');setEvent(event);}, id=>{state.modes.portfolio.selectedCompany=id;const company=state.companies.find(c=>c.id===id);if(company)state.modes.portfolio.list=company.list;portfolioView='overview';navigate('portfolio');});
const footerStatus = button('Connecting to sources…', () => settings('sources'), 'source-status');
const footer = el(
  'footer',
  { class: 'footer' },
  el('span', { class: 'mono' }, 'LOCAL WORKSPACE'),
  footerStatus,
  el('span', { class: 'footer-right' }, 'SOURCE-LED · NO TRADING SIGNALS'),
);
root.replaceChildren(header, workspace, command.element, footer, toastBox);
function applyWorkspace() {
  const active=state.workspace.active;
  document.documentElement.dataset.workspace=active;
  root.dataset.workspace=active;
  workspace.hidden=active==='command';
  command.setActive(active==='command');
  nav.hidden=active==='command';
  search.closest('label')!.toggleAttribute('hidden',active==='command');
  timeSelect.hidden=active==='command';
  workspace.style.setProperty('--reading-width',state.workspace.readingWidth+'px');
  widthControl.value=String(state.workspace.readingWidth);
  for(const b of header.querySelectorAll<HTMLButtonElement>('[data-workspace-button]')) {
    b.classList.toggle('active',b.dataset.workspaceButton===active);
    b.setAttribute('aria-pressed',String(b.dataset.workspaceButton===active));
  }
  command.update(snapshot);
}
function switchWorkspace(active: 'reading' | 'command', replace=false) {
  if(active==='reading') {navigate(state.workspace.lastReading,replace);return;}
  clearTransientAI();
  state.workspace.active='command';
  if(replace)history.replaceState({},'', '/command');
  else if(location.pathname!=='/command')history.pushState({},'', '/command');
  closeCityPanel(); applyWorkspace(); persist(); updateHeader();
}

function updateHeader() {
  for (const b of nav.querySelectorAll('button')) {
    const active = b.dataset.mode === mode;
    b.classList.toggle('active', active);
    if (active) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  search.value = current().query;
  search.placeholder = `Search ${mode} events…`;
  search.setAttribute('aria-label', `Search ${mode} events`);
  timeSelect.value = String(current().hours);
  areaButton.hidden = mode !== 'explore';
  document.title = `World Pulse · ${mode[0]!.toUpperCase() + mode.slice(1)}`;
  root.setAttribute('data-appearance', state.appearance);
  if(state.workspace.active==='command')document.title='World Pulse · Command';
  const ai = snapshot.aiControl;
  const aiLabel = !ai?.enabled ? 'AI Off' : ai.effective ? 'AI On' : 'AI Setup';
  aiToggleButton.textContent = aiLabel;
  aiToggleButton.classList.toggle('active', !!ai?.effective);
  aiToggleButton.setAttribute('aria-pressed', String(!!ai?.enabled));
  aiToggleButton.setAttribute(
    'title',
    ai?.effective
      ? 'AI requests are enabled'
      : ai?.enabled
        ? 'AI is enabled but no provider is configured'
        : 'All AI requests are blocked locally',
  );
}

root.addEventListener('pointermove', (event) => {
  const pointer = event as PointerEvent;
  if (pointer.pointerType && pointer.pointerType !== 'mouse') return;
  const target = (pointer.target as Element | null)?.closest<HTMLElement>('.glass-interactive');
  if (!target) return;
  const bounds = target.getBoundingClientRect();
  target.style.setProperty('--glass-x', `${pointer.clientX - bounds.left}px`);
  target.style.setProperty('--glass-y', `${pointer.clientY - bounds.top}px`);
});
const companyLoads = new Map<
  string,
  { at: number; message: string; state: 'loading' | 'ready' | 'partial' | 'error' }
>();
let directoryEntries: PulseCompany[] = [...catalog];
function activeCompanies() {
  return state.companies.filter(
    (c) =>
      c.list === current().list &&
      (!current().selectedCompany || c.id === current().selectedCompany),
  );
}
async function fetchCompanyData() {
  if (mode !== 'portfolio') return;
  const selectedId = state.modes.portfolio.selectedCompany;
  const companies = [...state.companies].sort(
    (left, right) =>
      Number(right.id === selectedId) - Number(left.id === selectedId) ||
      Number(left.list === 'watchlist') - Number(right.list === 'watchlist'),
  );
  const due = companies.filter((company) => {
    if (company.provenance !== 'catalog') return false;
    const previous = companyLoads.get(company.id);
    return !previous || (previous.state !== 'loading' && Date.now() - previous.at >= 30 * 60_000);
  });
  if (!due.length) return;
  for (const company of due)
    companyLoads.set(company.id, {
      at: Date.now(),
      state: 'loading',
      message: 'Loading public reports…',
    });
  render();
  const returnedStatuses: PulseSnapshot['sources'] = [];
  let index = 0;
  let anySucceeded = false;
  await Promise.all(
    Array.from({ length: Math.min(2, due.length) }, async () => {
      while (index < due.length) {
        const company = due[index++]!;
        try {
          const response = await fetch('/api/world-pulse/company-data', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ companyId: company.id }),
            signal: AbortSignal.timeout(60000),
          });
          if (!response.ok)
            throw new Error('Company sources failed; global matches remain available.');
          const data = (await response.json()) as PulseCompanyData;
          if (!Array.isArray(data.events) || !Array.isArray(data.sources))
            throw new Error('Invalid company response');
          anySucceeded = true;
          returnedStatuses.push(...data.sources);
          if (
            data.company?.provenance === 'catalog' &&
            data.company.id === company.id &&
            data.company.symbol === company.symbol &&
            data.company.exchange === company.exchange &&
            data.company.cik
          )
            state.companies = state.companies.map((candidate) =>
              candidate.id === company.id && candidate.provenance === 'catalog'
                ? {
                    ...data.company,
                    list: candidate.list,
                    aliases: candidate.aliases,
                    aliasProvenance: candidate.aliasProvenance,
                    // Local-only fields the server never sees.
                    ...(candidate.position ? { position: candidate.position } : {}),
                    ...(candidate.links?.length ? { links: candidate.links } : {}),
                  }
                : candidate,
            );
          const partial = data.sources.some(
            (source) => source.state === 'error' || source.state === 'stale',
          );
          companyLoads.set(company.id, {
            at: partial ? Date.now() - 29 * 60_000 : Date.now(),
            state: partial ? 'partial' : 'ready',
            message: partial
              ? 'Partial company coverage · see source status'
              : `${data.events.length} company-source reports checked`,
          });
        } catch (error) {
          companyLoads.set(company.id, {
            at: Date.now() - 29 * 60_000,
            state: 'error',
            message: error instanceof Error ? error.message : 'Company sources failed',
          });
        }
        if (mode === 'portfolio') render();
      }
    }),
  );
  persist();
  if (anySucceeded) {
    try {
      // Reload once after all company channels settle so every mode consumes one canonical event set.
      const canonicalResponse = await fetch('/api/world-pulse/status', {
        signal: AbortSignal.timeout(30000),
      });
      if (!canonicalResponse.ok)
        throw new Error('Reports loaded, but the unified event view could not refresh.');
      const canonical = (await canonicalResponse.json()) as PulseSnapshot;
      if (!Array.isArray(canonical.events) || !Array.isArray(canonical.sources))
        throw new Error('Invalid unified event view');
      snapshot = canonical;
      for (const status of returnedStatuses)
        if (!snapshot.sources.some((source) => source.id === status.id))
          snapshot.sources.push(status);
    } catch {
      toast('Company reports loaded, but the unified event view could not refresh.');
    }
  }
  if (mode === 'portfolio') render();
}
function discoveryTime(event: PulseEvent) {
  return (
    event.reports
      ?.map((r) => r.firstSeenAt)
      .filter((t) => Number.isFinite(Date.parse(t)))
      .sort()[0] || null
  );
}
function indicator(event: PulseEvent) {
  const attention = attentionForEvent(event, mode === 'portfolio' ? activeCompanies() : undefined);
  const { heat, importance } = attention;
  const title = mode === 'portfolio' ? 'Your priority' : 'Importance';
  const status =
    attention.state === 'unassessed'
      ? 'Not assessed'
      : importance.method === 'ai'
        ? 'Attention'
        : 'Attention · rules';
  const description =
    attention.position === null
      ? 'Not assessed: not enough importance evidence, so no needle is shown'
      : attention.position < 0.35
        ? 'Low attention'
        : attention.position < 0.65
          ? 'Medium attention'
          : 'High attention';
  return el(
    'details',
    { class: 'event-indicators', 'data-attention-state': attention.state },
    el(
      'summary',
      { 'aria-label': description + '. Expand for the basis.' },
      attentionGauge(attention.position),
      el('span', { class: 'attention-label' }, status),
    ),
    el(
      'p',
      {},
      'Attention is a reading priority, not a bullish or bearish signal or a price direction. Importance weighs most; coverage heat supplements it.',
    ),
    snapshot.sources.some((source) => source.state !== 'fresh')
      ? el('p', { class: 'notice' }, 'Some sources are stale or unavailable, so coverage may be incomplete.')
      : null,
    el(
      'p',
      {},
      `Heat · ${heat.publishers24h} independent outlets in 24h · ${heat.newReports3h} new reports in 3h`,
    ),
    ...heat.reasons.map((reason) => el('p', {}, reason)),
    el(
      'p',
      {},
      `${title} · ${importance.method === 'ai' ? 'AI assessment' : 'Reviewable rules'}${mode === 'portfolio' ? ' · equal company weighting' : ''}`,
    ),
    ...importance.reasons.map((reason) => el('p', {}, reason)),
    ...importance.sourceIds.map((id) => {
      const source = event.sources.find((s) => s.id === id);
      return source ? link('Evidence ↗', source.url) : null;
    }),
    el(
      'p',
      { class: 'micro' },
      'Coverage is limited to collected reports. Source outages and conservative grouping may undercount heat. No price direction is inferred.',
    ),
    snapshot.aiControl?.effective
      ? button(
          mode === 'portfolio'
            ? 'Assess company priority with AI'
            : 'Assess public importance with AI',
          () => void assessEvent(event),
          'small',
        )
      : el('span', { class: 'micro' }, 'AI assessment is off; reviewable rules remain active.'),
    button('Inspect reports & sources', () => setEvent(event), 'small'),
  );
}
function sortingControls() {
  const options: [PulseSort, string][] =
    mode === 'portfolio'
      ? [
          ['personal', 'For you'],
          ['latest', 'Latest'],
          ['trending', 'Trending'],
        ]
      : [
          ['latest', 'Latest'],
          ['trending', 'Trending'],
          ['important', 'Important'],
        ];
  const select = el(
    'select',
    {
      'aria-label': 'Sort events',
      onchange: () => {
        current().sort = select.value as PulseSort;
        persist();
        render();
      },
    },
    ...options.map(([value, label]) => el('option', { value }, label)),
  );
  select.value = current().sort;
  return el(
    'div',
    { class: 'list-heading' },
    field('SORT', select),
    el(
      'span',
      {},
      current().sort === 'trending'
        ? 'Up to 20 · collected sources'
        : current().sort === 'personal'
          ? 'Current list · equal weighting'
          : current().sort === 'important'
            ? 'Public importance'
            : 'Newest first ↓',
    ),
  );
}
async function changeFiltering(body: { enabled?: boolean; eventId?: string }) {
  try {
    const res = await fetch('/api/world-pulse/filter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error('Filter update failed');
    snapshot = await res.json();
    render();
    if (body.enabled !== undefined) settings('ai');
  } catch {
    toast('Unable to update filtering. Your current view is retained.');
  }
}
async function changeAIEnabled(enabled: boolean, reopenSettings = false) {
  aiToggleButton.disabled = true;
  clearTransientAI();
  try {
    const response = await fetch('/api/world-pulse/ai-control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error('AI control update failed');
    const control = (await response.json()) as PulseAIControl;
    if (
      typeof control.enabled !== 'boolean' ||
      typeof control.configured !== 'boolean' ||
      typeof control.effective !== 'boolean' ||
      !Number.isSafeInteger(control.inFlight)
    )
      throw new Error('Invalid AI control response');
    snapshot.aiControl = control;
    snapshot.aiConfigured = control.configured;
    updateHeader();
    render();
    toast(
      control.enabled
        ? control.effective
          ? 'AI enabled. Requests run only when required.'
          : 'AI enabled. Configure a local endpoint, model, and API key before requests can run.'
        : 'AI disabled. All provider requests are blocked locally.',
    );
    if (reopenSettings) settings('ai');
  } catch {
    toast('Unable to update the AI safety switch. The previous state is retained.');
  } finally {
    aiToggleButton.disabled = false;
  }
}

function coverageControls() {
  const options: Array<[PulseCoverage, string]> = [
    ['balanced', 'Balanced'],
    ['global', 'Global'],
    ['china', 'China'],
    ['all', 'All'],
  ];
  return el(
    'section',
    { class: 'coverage-control glass-controls', 'aria-label': 'World coverage' },
    el('span', { class: 'eyebrow' }, 'COVERAGE'),
    el(
      'div',
      { class: 'segmented' },
      ...options.map(([value, label]) =>
        button(
          label,
          () => {
            current().coverage = value;
            displayed = 50;
            persist();
            render();
          },
          current().coverage === value ? 'active' : '',
          { 'aria-pressed': String(current().coverage === value) },
        ),
      ),
    ),
    el(
      'p',
      { class: 'micro' },
      current().coverage === 'balanced'
        ? 'Mixes coverage without changing event scores or timestamps.'
        : current().coverage === 'all'
          ? 'Strict current sort order.'
          : `Only ${current().coverage} coverage.`,
    ),
  );
}
function relevanceBadge(event: PulseEvent) {
  const r = event.relevance;
  if (!r) return null;
  const reasons: Record<string, string> = {
    routine_filing: 'Routine filing; directly related companies remain visible in Portfolio',
    routine_enforcement: 'Routine termination of enforcement action',
    sport_result: 'Routine sports result',
    celebrity_gossip: 'Celebrity gossip',
    lifestyle: 'Lifestyle or personal advice',
    relevant: 'Relevant topic',
    unprocessed: 'Not yet assessed',
    invalid_result: 'Invalid AI response; kept visible',
    request_incomplete: 'AI request incomplete; kept visible',
    user_restored: 'Manually restored',
    small_earthquake: 'Below World earthquake display threshold',
    earthquake_display_threshold: 'Meets earthquake display threshold',
    sports: 'Routine sports result',
    entertainment: 'Routine entertainment',
    promotion: 'Shopping or promotion',
    local: 'Routine local item',
    personal: 'Personal advice',
    routine: 'Routine update',
    low_magnitude: 'Below World earthquake display threshold',
    uncertain: 'Title does not establish scope',
  };
  return el(
    'details',
    { class: 'relevance-note' },
    el(
      'summary',
      {},
      r.decision === 'exclude'
        ? '◌ Filtered · outside World scope'
        : r.method === 'restored'
          ? '↩ Restored by you'
          : r.decision === 'uncertain'
            ? '◇ Pending / uncertain · kept visible'
            : '✓ Within topic scope',
    ),
    el(
      'p',
      {},
      `${reasons[r.reason] || r.reason} · ${r.method}. Topic selection is separate from importance.`,
    ),
    r.decision === 'exclude'
      ? button('Restore event', () => void changeFiltering({ eventId: event.id }), 'small')
      : null,
  );
}
function results() {
  return filterEvents(snapshot.events, mode, current(), state.companies);
}
function reportsForArticle(event: PulseEvent): PulseReport[] {
  if (event.reports?.length) return event.reports;
  return event.sources.map((source, index) => ({
    id: source.id || `${event.id}:${index}`,
    title: event.title,
    summary: event.summary,
    source,
    publishedAt: event.publishedAt,
    firstSeenAt: event.firstSeenAt ?? event.fetchedAt,
    lastFetchedAt: event.lastFetchedAt ?? event.fetchedAt,
    timeBasis: event.timeBasis,
  }));
}
function articleKey(event: PulseEvent, report: PulseReport) {
  return `${event.id}:${report.id}`;
}
function activeArticleReport(event: PulseEvent): PulseReport | undefined {
  const reports = reportsForArticle(event);
  const chosen = selectedArticleReports.get(event.id);
  return reports.find((report) => report.id === chosen) ?? reports[0];
}
const autoArticle = new Set<string>();
/**
 * Without an explicit choice the local service reads the best available
 * outlet (direct publisher links and reviewed newsrooms first) and reports
 * which one it used.
 */
async function loadArticle(event: PulseEvent, report?: PulseReport) {
  const chosen = report ?? (selectedArticleReports.has(event.id) ? activeArticleReport(event) : undefined);
  const key = chosen ? articleKey(event, chosen) : `${event.id}:auto`;
  if (chosen) selectedArticleReports.set(event.id, chosen.id);
  if ((chosen && articles.has(key)) || pendingArticles.has(key) || (!chosen && autoArticle.has(event.id))) return;
  pendingArticles.add(key);
  renderDetail(results());
  try {
    const response = await fetch('/api/world-pulse/article', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chosen ? { eventId: event.id, reportId: chosen.id } : { eventId: event.id }),
      signal: AbortSignal.timeout(45000),
    });
    const article = (await response.json()) as PulseArticle;
    const known = reportsForArticle(event).find((r) => r.id === article.reportId);
    if (
      !response.ok ||
      article.eventId !== event.id ||
      !known ||
      (chosen && article.reportId !== chosen.id) ||
      !['available', 'unavailable'].includes(article.state) ||
      !Array.isArray(article.paragraphs) ||
      article.paragraphs.some((paragraph) => typeof paragraph !== 'string')
    )
      throw new Error('Invalid article response');
    articles.set(articleKey(event, known), article);
    if (!chosen) {
      autoArticle.add(event.id);
      selectedArticleReports.set(event.id, known.id);
    }
  } catch {
    const fallback = chosen ?? activeArticleReport(event);
    if (fallback) {
      selectedArticleReports.set(event.id, fallback.id);
      articles.set(articleKey(event, fallback), {
        eventId: event.id,
        reportId: fallback.id,
        title: reportTitle(fallback),
        source: fallback.source,
        sourceUrl: fallback.source.url,
        paragraphs: [],
        state: 'unavailable',
        fetchedAt: new Date().toISOString(),
        cached: false,
        message: 'The local reader could not load this report. Open the original source instead.',
      });
    }
  } finally {
    pendingArticles.delete(key);
    if (selected?.id === event.id) renderDetail(results());
  }
}
/** One button per outlet, reviewed newsrooms first, at most eight. */
function pickerReports(reports: PulseReport[], active?: PulseReport) {
  const rank = { A: 0, B: 1, C: 2, blocked: 3 } as const;
  const seen = new Set<string>();
  const picked: PulseReport[] = [];
  for (const report of [...reports].sort((a, b) => rank[assessReport(a).quality] - rank[assessReport(b).quality])) {
    const key = sourceOutlet(report.source).key;
    if (seen.has(key) || assessReport(report).quality === 'blocked') continue;
    seen.add(key);
    picked.push(report);
  }
  const top = picked.slice(0, 8);
  if (active && !top.some((r) => r.id === active.id)) top.unshift(active);
  return top;
}
function nextReadableReport(event: PulseEvent, current?: PulseReport) {
  const reports = reportsForArticle(event);
  return reports.find(
    (report) =>
      report.id !== current?.id &&
      !articles.has(articleKey(event, report)) &&
      assessReport(report).quality !== 'blocked',
  );
}
function setEvent(event: PulseEvent) {
  if (selected?.id !== event.id) clearTransientAI();
  selected = event;
  selectedByMode[mode] = event;
  render();
  void loadArticle(event);
  // Keep map and list in sync: fly only when the point is off-screen,
  // and always bring the matching list card into view with a flash.
  map?.reveal(event.location?.lon ?? NaN, event.location?.lat ?? NaN);
  const card = side.querySelector<HTMLElement>(
    `[data-event-id="${CSS.escape(event.id)}"]`,
  );
  if (card) {
    card.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' });
    card.classList.remove('flash');
    void card.offsetWidth; // restart the animation
    card.classList.add('flash');
  }
}
function chip(text: string, remove: () => void) {
  return button(text + ' ×', remove, 'filter-chip', {
    'aria-label': 'Remove ' + text,
  });
}
function toggle<T>(values: T[], value: T) {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
}
function chips() {
  const c = current();
  const box = el('div', { class: 'active-filters' });
  for (const region of c.regions)
    box.append(
      chip(regionName(region), () => {
        c.regions = c.regions.filter((x) => x !== region);
        persist();
        render();
      }),
    );
  for (const category of c.categories)
    box.append(
      chip(category, () => {
        c.categories = c.categories.filter((x) => x !== category);
        persist();
        render();
      }),
    );
  for (const source of c.sourceIds)
    box.append(
      chip(snapshot.sources.find((s) => s.id === source)?.name || source, () => {
        c.sourceIds = c.sourceIds.filter((x) => x !== source);
        persist();
        render();
      }),
    );
  if (c.query)
    box.append(
      chip(`“${c.query}”`, () => {
        c.query = '';
        search.value = '';
        persist();
        render();
      }),
    );
  if (c.bounds)
    box.append(
      chip('Map area', () => {
        delete c.bounds;
        persist();
        render();
      }),
    );
  return box;
}
function topicButtons() {
  return el(
    'div',
    { class: 'topic-tabs' },
    button(
      'All',
      () => {
        current().categories = [];
        persist();
        render();
      },
      !current().categories.length ? 'active' : '',
    ),
    ...categories.map((cat) =>
      button(
        cat,
        () => {
          current().categories = toggle(current().categories, cat);
          persist();
          render();
        },
        current().categories.includes(cat) ? 'active' : '',
      ),
    ),
  );
}
function exploreControls() {
  const regionSelect = el(
    'select',
    {
      'aria-label': 'Add region',
      onchange: () => {
        if (regionSelect.value) {
          current().regions = toggle(current().regions, regionSelect.value);
          persist();
          render();
        }
      },
    },
    el('option', { value: '' }, '＋ Region'),
    ...Array.from(
      new Set(snapshot.events.map((e) => e.location?.country).filter(Boolean) as string[]),
    )
      .sort((a, b) => regionName(a).localeCompare(regionName(b)))
      .map((code) => el('option', { value: code }, regionName(code))),
  );
  const sourceSelect = el(
    'select',
    {
      'aria-label': 'Add source',
      onchange: () => {
        if (sourceSelect.value) {
          current().sourceIds = toggle(current().sourceIds, sourceSelect.value);
          persist();
          render();
        }
      },
    },
    el('option', { value: '' }, '＋ Source'),
    ...snapshot.sources.map((s) => el('option', { value: s.id }, s.name)),
  );
  const saved = el(
    'select',
    {
      'aria-label': 'Saved searches',
      onchange: () => {
        const entry = state.savedSearches.find((s) => s.id === saved.value);
        if (entry) {
          state.modes.explore = structuredClone(entry.state);
          map?.restore(current().camera);
          persist();
          updateHeader();
          render();
          toast(`Loaded “${entry.name}”`);
        }
      },
    },
    el('option', { value: '' }, 'Saved searches'),
    ...state.savedSearches.map((s) => el('option', { value: s.id }, s.name)),
  );
  return el(
    'section',
    { class: 'explore-controls' },
    el('div', { class: 'control-row' }, regionSelect, sourceSelect),
    topicButtons(),
    el(
      'div',
      { class: 'control-row' },
      button('Save search', saveSearch, 'small'),
      button(
        'Clear filters',
        () => {
          const camera = current().camera;
          state.modes.explore = { ...defaultModeState(), camera };
          persist();
          updateHeader();
          render();
        },
        'small quiet',
      ),
    ),
    el('div', { class: 'control-row' }, saved, button('Manage', manageSearches, 'small quiet')),
  );
}
// ---------------------------------------------------------------------------
// Portfolio: market data, radar, brief, calendar and company panel

function allSymbols() {
  return [...new Set(state.companies.map((company) => company.symbol))];
}
async function postJson<T>(path: string, body: unknown, timeout = 20000): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((data as { error?: string }).error || 'Local service unavailable');
  return data as T;
}
async function fetchMarket() {
  const symbols = allSymbols();
  if (!symbols.length || marketPending) return;
  marketPending = true;
  try {
    const next = await postJson<PulseMarketSnapshot>('/api/world-pulse/market', { symbols });
    if (!next || typeof next.quotes !== 'object' || !next.status) throw new Error('Invalid market response');
    market = next;
    marketError = next.configured
      ? ''
      : 'Add FINNHUB_API_KEY or TIINGO_API_KEY to .env.local and restart to show prices.';
    void fetchReportPrices();
  } catch (error) {
    marketError = error instanceof Error ? error.message : 'Market data unavailable';
  } finally {
    marketPending = false;
    if (mode === 'portfolio') render();
  }
}
type MarketHealth = 'loading' | 'fresh' | 'stale' | 'limited' | 'no-key' | 'partial' | 'error';
function marketHealth(): { state: MarketHealth; detail: string } {
  if (!market && marketPending) return { state: 'loading', detail: 'Loading market data…' };
  if (!market) return { state: marketError ? 'error' : 'loading', detail: marketError || 'Market data has not loaded.' };
  if (!market.configured)
    return { state: 'no-key', detail: 'No market-data key · news and company coverage remain available.' };
  const symbols = allSymbols();
  const missing = symbols.filter((symbol) => !market!.quotes[symbol]);
  const maxAge = market.status.session === 'closed' ? 6 * 3_600_000 : 6 * 60_000;
  const stale = symbols.filter((symbol) => {
    const fetched = Date.parse(market!.quotes[symbol]?.fetchedAt || '');
    return !Number.isFinite(fetched) || Date.now() - fetched > maxAge;
  });
  if (marketError && !Object.keys(market.quotes).length)
    return { state: 'error', detail: 'Market provider failed · news and company coverage remain available.' };
  if (market.limited)
    return { state: 'limited', detail: 'Market refresh limited · cached quotes are shown where available.' };
  if (missing.length || stale.length)
    return {
      state: missing.length === symbols.length ? 'partial' : 'stale',
      detail: missing.length
        ? `${missing.length} of ${symbols.length} symbols have no current quote · news remains available.`
        : 'Some quotes are stale · the last successful values remain visible.',
    };
  if (marketError) return { state: 'stale', detail: 'Refresh failed · the last successful quotes remain visible.' };
  return { state: 'fresh', detail: 'Quotes current for this session.' };
}
async function fetchCalendar(force = false) {
  if (!force && Date.now() - calendarAt < 30 * 60_000) return;
  calendarAt = Date.now();
  calendarPending = true;
  calendarError = '';
  if (mode === 'portfolio') render();
  try {
    const items = await postJson<PulseCalendarItem[]>('/api/world-pulse/calendar', { symbols: allSymbols() }, 30000);
    if (Array.isArray(items)) calendarItems = items;
  } catch (error) {
    calendarError = error instanceof Error ? error.message : 'Calendar unavailable';
    calendarAt = 0;
  } finally {
    calendarPending = false;
  }
  if (mode === 'portfolio') render();
}
async function fetchProfile(symbol: string) {
  if (profiles.has(symbol) || profilePending.has(symbol)) return;
  profilePending.add(symbol);
  profileErrors.delete(symbol);
  try {
    const profile = await postJson<PulseCompanyProfile & { quotes: Record<string, PulseQuote> }>(
      '/api/world-pulse/profile',
      { symbol },
      30000,
    );
    if (profile?.symbol !== symbol || !Array.isArray(profile.peers)) throw new Error('Invalid profile');
    profiles.set(symbol, profile);
  } catch (error) {
    profileErrors.set(symbol, error instanceof Error ? error.message : 'Profile unavailable');
  } finally {
    profilePending.delete(symbol);
    if (mode === 'portfolio') render();
  }
}
/** "Since this report" uses prices this service recorded; nothing is back-filled. */
async function fetchReportPrices() {
  if (mode !== 'portfolio' || !market) return;
  const lookups: { symbol: string; time: string }[] = [];
  for (const event of results().slice(0, 30)) {
    const time = event.publishedAt || event.firstSeenAt;
    if (!time) continue;
    for (const match of matchCompanies(event, activeCompanies())) {
      const key = `${match.symbol}|${time}`;
      if (!reportPrices.has(key) && lookups.length < 60) lookups.push({ symbol: match.symbol, time });
    }
  }
  if (!lookups.length) return;
  try {
    const prices = await postJson<Record<string, number | null>>('/api/world-pulse/prices', { lookups });
    for (const [key, value] of Object.entries(prices)) reportPrices.set(key, typeof value === 'number' ? value : null);
    render();
  } catch {
    /* Deltas are optional context. */
  }
}
function quoteFor(symbol: string): PulseQuote | undefined {
  return market?.quotes[symbol] ?? [...profiles.values()].find((p) => p.quotes[symbol])?.quotes[symbol];
}
function money(value: number, digits = 2) {
  return (value < 0 ? '−$' : '$') + Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function signedMoney(value: number) {
  return (value > 0 ? '+' : '') + money(value);
}
function pct(value: number) {
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(2)}%`;
}
function tone(value: number | undefined) {
  return value === undefined ? '' : value > 0 ? ' up' : value < 0 ? ' down' : '';
}
function sessionLabel() {
  if (!market) return marketError || 'Market data loading…';
  if (!market.configured) return 'Market data off · add FINNHUB_API_KEY or TIINGO_API_KEY';
  const s = market.status;
  const finnhub = market.providers?.finnhub.configured ?? true;
  const label = !finnhub
    ? 'Tiingo quotes · exchange session unavailable'
    : s.holiday
      ? `US markets closed · ${s.holiday}`
      : s.session === 'regular'
        ? 'US market open'
        : s.session === 'pre-market'
          ? 'US pre-market'
          : s.session === 'post-market'
            ? 'US after-hours'
            : 'US market closed';
  const tiingo = market.providers?.tiingo;
  return tiingo?.configured ? `${label} · Tiingo ${tiingo.callsLastHour}/${tiingo.hourlyLimit}h` : label;
}
function radarBar(level: 'move' | 'spike' | 'quiet') {
  return el('span', { class: 'radar-bar radar-' + level, 'aria-hidden': true });
}
function portfolioControls() {
  const list = current().list;
  const companies = state.companies.filter((c) => c.list === list);
  const quotes = market?.quotes ?? {};
  const readings = new Map(companies.map((c) => [c.id, radarFor(c, snapshot.events, quotes[c.symbol])]));
  const order = { move: 0, spike: 1, quiet: 2 } as const;
  const sorted = [...companies].sort(
    (a, b) =>
      order[readings.get(a.id)!.level] - order[readings.get(b.id)!.level] ||
      readings.get(b.id)!.stories24h - readings.get(a.id)!.stories24h ||
      a.symbol.localeCompare(b.symbol),
  );
  const summary = list === 'holdings' ? portfolioSummary(companies, quotes) : undefined;
  const count = (l: 'holdings' | 'watchlist') => state.companies.filter((c) => c.list === l).length;
  const rows = sorted.map((c) => {
    const quote = quotes[c.symbol];
    const reading = readings.get(c.id)!;
    return el(
      'div',
      {
        class: 'company-row' + (current().selectedCompany === c.id ? ' selected' : ''),
        title: reading.reasons.join(' '),
      },
      radarBar(reading.level),
      button(
        c.symbol,
        () => {
          current().selectedCompany = current().selectedCompany === c.id ? '' : c.id;
          if (current().selectedCompany) void fetchProfile(c.symbol);
          persist();
          render();
        },
        'company-select',
        { 'aria-label': `Select ${c.name}`, 'aria-pressed': String(current().selectedCompany === c.id) },
      ),
      el('span', { class: 'company-name', title: c.name }, displayName(c)),
      el(
        'span',
        { class: 'company-quote' },
        el('span', { class: 'mono' }, quote ? quote.price.toFixed(2) : '—'),
        el('span', { class: 'mono change' + tone(quote?.changePercent) }, quote ? pct(quote.changePercent) : ''),
      ),
      el('span', { class: 'story-badge', title: `${reading.stories24h} stories in 24 hours` }, String(reading.stories24h)),
      button('Edit', () => companyDialog(c), 'small quiet row-edit', { 'aria-label': `Edit ${c.symbol}` }),
    );
  });
  return el(
    'section',
    { class: 'portfolio-controls' },
    summary
      ? el(
          'div',
          { class: 'holdings-summary' },
          el('span', { class: 'eyebrow' }, 'HOLDINGS VALUE'),
          el('strong', { class: 'mono' }, summary.priced ? money(summary.value) : '—'),
          el(
            'div',
            { class: 'summary-line' },
            el('span', { class: 'mono' + tone(summary.dayChange) }, `Today ${signedMoney(summary.dayChange)} (${pct(summary.dayChangePercent)})`),
            el('span', { class: 'mono' + tone(summary.unrealized) }, `Total ${signedMoney(summary.unrealized)}`),
          ),
          el(
            'span',
            { class: 'micro' },
            summary.priced < summary.positions
              ? `${summary.priced}/${summary.positions} positions priced. Shares and cost stay in this browser.`
              : 'Shares and cost stay in this browser.',
          ),
        )
      : null,
    el(
      'div',
      { class: 'portfolio-list-head' },
      el(
        'div',
        { class: 'segmented' },
        ...(['holdings', 'watchlist'] as const).map((l) =>
          button(
            `${l === 'holdings' ? 'Holdings' : 'Watchlist'} ${count(l)}`,
            () => {
              current().list = l;
              current().selectedCompany = '';
              persist();
              render();
              void fetchCompanyData();
            },
            l === list ? 'active' : '',
          ),
        ),
      ),
      companies.length
        ? button('＋', () => companyDialog(), 'add-company-icon', { 'aria-label': 'Add company' })
        : null,
    ),
    companies.length
      ? el('p', { class: 'micro radar-legend' }, `Sorted by needs attention · red: move of ±${RADAR.movePercent}% or more · amber: coverage spike · number: stories in 24h`)
      : null,
    ...rows,
    companies.length && current().selectedCompany
      ? button('All companies', () => {
          current().selectedCompany = '';
          persist();
          render();
        }, 'small quiet')
      : null,
    !companies.length
      ? el('div', { class: 'portfolio-empty' },
          el('p', { class: 'muted' }, 'Add your first company. Your list stays in this browser.'))
      : null,
    el('p', { class: 'micro' }, 'DIRECT MENTIONS ONLY · No impact prediction'),
  );
}
/** SEC names arrive in capitals; show them the way reporters write them. */
function prettyName(name: string) {
  if (name !== name.toUpperCase()) return name;
  return name
    .toLowerCase()
    .replace(/\b([a-z])/g, (letter) => letter.toUpperCase())
    .replace(/\b(Inc|Corp|Co|Ltd|Plc|Llc|Nv|Sa|Ag|Adr)\b/g, (word) => (word.length <= 3 && /^(Nv|Sa|Ag)$/.test(word) ? word.toUpperCase() : word));
}
function displayName(company: PulseCompany) {
  const derived = deriveReportingNames(company.name).names;
  return derived.sort((a, b) => a.length - b.length)[0] || company.name;
}
function matchingNames(company: PulseCompany) {
  const derived = company.provenance === 'catalog' ? deriveReportingNames(company.name) : { names: [], contextual: [] };
  return {
    auto: [...new Set([...derived.names, ...(company.provenance === 'catalog' ? CHINESE_NAMES[company.symbol] ?? [] : [])])],
    contextual: derived.contextual,
    user: company.aliases ?? [],
  };
}

function renderBoard(matches: PulseEvent[]) {
  workspace.classList.toggle('portfolio-mode', mode === 'portfolio');
  workspace.classList.toggle('portfolio-map', mode === 'portfolio' && portfolioView === 'map');
  if (mode !== 'portfolio') {
    boardReturn.hidden = true;
    board.replaceChildren();
    return;
  }
  const company = state.companies.find((c) => c.id === current().selectedCompany);
  const head = el(
    'div',
    { class: 'board-head' },
    el('div', {}, el('span', { class: 'eyebrow' }, company ? 'COMPANY' : 'YOUR COMPANIES, IN CONTEXT'), el('h1', {}, company ? `${company.symbol} · ${displayName(company)}` : 'Portfolio')),
    el(
      'div',
      { class: 'board-tools' },
      el('span', { class: 'session mono' }, sessionLabel()),
      el(
        'div',
        { class: 'segmented' },
        ...(['overview', 'map'] as const).map((view) =>
          button(view === 'overview' ? 'Overview' : 'Map', () => {
            clearTransientAI();
            portfolioView = view;
            render();
          }, portfolioView === view ? 'active' : '', { 'aria-pressed': String(portfolioView === view) }),
        ),
      ),
    ),
  );
  boardReturn.hidden = portfolioView !== 'map';
  if (portfolioView === 'map') {
    board.replaceChildren();
    return;
  }
  setChildren(board, head, ...(company ? companyPanel(company) : overviewPanel(matches)));
}
function overviewPanel(matches: PulseEvent[]): Child[] {
  const companies = state.companies.filter((c) => c.list === current().list);
  if (!companies.length)
    return [
      el('div', { class: 'board-card board-empty' },
        el('h2', {}, 'Start with the companies you follow'),
        el('p', { class: 'muted' }, 'Search by name or ticker. Prices, coverage, earnings dates and peers appear here; reporting still links back to its source.'),
        button('＋ Add company', () => companyDialog(), 'primary')),
    ];
  const quotes = market?.quotes ?? {};
  const brief = morningBrief(companies, snapshot.events, quotes, calendarItems);
  const briefKey = JSON.stringify(brief.lines.map((line) => `${line.symbol}: ${line.text}`));
  if (briefAI && briefAI.key !== briefKey) briefAI = undefined;
  const week = filterEvents(snapshot.events, 'portfolio', { ...current(), hours: 168, sort: 'latest' }, state.companies);
  const timeline = coverageTimeline(week);
  const max = Math.max(1, ...timeline.map((day) => day.count));
  const regions = coverageRegions(matches).slice(0, 6);
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = calendarItems.filter((item) => item.date >= today).slice(0, 8);
  const marketStatus = marketHealth();
  const calendarStatus = calendarPending
    ? 'Loading public calendars…'
    : calendarError
      ? 'Calendar source unavailable; news and quotes remain usable.'
      : upcoming.length
        ? `${upcoming.length} upcoming items`
        : 'No scheduled items in the coming weeks.';
  return [
    el(
      'section',
      { class: 'board-card brief' },
      el('div', { class: 'section-head' },
        el('h2', {}, 'Morning brief'),
        el('span', { class: 'micro' }, 'Rules · every line links to its reports'),
        snapshot.aiControl?.effective
          ? button(briefPending ? 'Polishing…' : 'Polish with AI', () => void polishBrief(brief.lines.map((line) => `${line.symbol}: ${line.text}`), briefKey), 'small', {
              disabled: briefPending || !brief.lines.length,
              title: 'Sends the brief text below (tickers, price changes, public headlines). Shares, costs and your lists are not sent.',
            })
          : null),
      brief.lines.length
        ? el('div', { class: 'brief-lines' },
            ...brief.lines.map((line) =>
              el('div', { class: 'brief-line brief-' + line.level },
                el('span', { class: 'mono brief-symbol' }, line.symbol),
                el('span', {}, line.text),
                line.eventIds.length
                  ? button(`${line.eventIds.length} ${line.eventIds.length === 1 ? 'report' : 'reports'}`, () => {
                      const target = state.companies.find((c) => c.symbol === line.symbol && c.list === current().list);
                      if (target) {
                        current().selectedCompany = target.id;
                        void fetchProfile(target.symbol);
                        persist();
                        render();
                      }
                    }, 'small quiet')
                  : null)))
        : el('p', { class: 'muted' }, market?.configured === false ? 'Prices are off, and no coverage spikes were found.' : 'Nothing flagged: no large price moves or coverage spikes.'),
      brief.quiet.length ? el('p', { class: 'micro' }, `Quiet: ${brief.quiet.join(' · ')}`) : null,
      briefAI?.key === briefKey ? el('div', { class: 'brief-ai', lang: 'zh-CN' }, el('span', { class: 'eyebrow' }, 'AI WORDING · FACTS ABOVE'), el('p', {}, briefAI.text), button('Clear AI wording', () => { clearTransientAI(); render(); }, 'small quiet'), el('p', { class: 'micro' }, 'Temporary view · Not saved by this app')) : null,
      briefError ? el('p', { class: 'notice' }, briefError) : null,
      el('p', { class: `micro market-health market-${marketStatus.state}` }, marketStatus.detail),
    ),
    el(
      'section',
      { class: 'board-card' },
      el('div', { class: 'section-head' }, el('h2', {}, 'Coverage · last 7 days'), el('span', { class: 'micro' }, `${week.length} direct-mention stories this week`)),
      el('div', { class: 'coverage-bars', role: 'img', 'aria-label': 'Stories per day over the last seven days' },
        ...timeline.map((day) =>
          el('div', { class: 'coverage-day', title: `${day.count} ${day.count === 1 ? 'story' : 'stories'}` },
            el('span', { class: 'mono count' }, String(day.count)),
            el('span', { class: 'bar', style: `height:${Math.round((day.count / max) * 100)}%` }),
            el('span', { class: 'micro' }, new Date(day.end).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'Asia/Shanghai' }))))),
    ),
    el(
      'div',
      { class: 'board-grid' },
      el('section', { class: 'board-card' },
        el('h2', {}, 'Upcoming'),
        upcoming.length
          ? el('div', { class: 'agenda' }, ...upcoming.map((item) =>
              el('div', { class: 'agenda-row agenda-' + item.kind },
                el('span', { class: 'mono agenda-date' }, new Date(item.date + 'T12:00:00Z').toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })),
                el('span', {}, item.title, item.detail ? el('small', {}, item.detail) : null))))
          : el('p', { class: 'muted' }, market?.configured === false ? 'Earnings dates need a market-data key. Scheduled FOMC and CPI releases appear when due.' : calendarStatus),
        el('p', { class: 'micro' }, 'Earnings: Finnhub calendar. FOMC: Federal Reserve schedule. CPI: BLS schedule.')),
      el('section', { class: 'board-card' },
        el('h2', {}, 'Where the coverage is'),
        regions.length
          ? el('div', { class: 'region-bars' }, ...regions.map((region) =>
              el('button', {
                type: 'button',
                class: 'region-row' + (current().regions.includes(region.country) ? ' active' : ''),
                'aria-pressed': String(current().regions.includes(region.country)),
                onclick: () => {
                  current().regions = current().regions.includes(region.country) ? [] : [region.country];
                  persist();
                  render();
                },
              },
                el('span', { class: 'region-name' }, regionName(region.country)),
                el('span', { class: 'region-meter' }, el('span', { style: `width:${Math.round((region.count / regions[0]!.count) * 100)}%` })),
                el('span', { class: 'mono micro' }, String(region.count)))))
          : el('p', { class: 'muted' }, 'No places are named in the current reporting.'),
        el('p', { class: 'micro' }, 'Counts only places named in the reporting. Click one to filter the list.')),
    ),
  ];
}
function companyPanel(company: PulseCompany): Child[] {
  const quote = quoteFor(company.symbol);
  const profile = profiles.get(company.symbol);
  const position = positionValue(company, quote);
  const stories = companyEvents(snapshot.events, company);
  const timeline = coverageTimeline(stories);
  const max = Math.max(1, ...timeline.map((day) => day.count));
  const names = matchingNames(company);
  const radar = radarFor(company, snapshot.events, quote);
  const peerQuotes = profile?.quotes ?? {};
  const marketStatus = marketHealth();
  return [
    el(
      'section',
      { class: 'board-card company-hero' },
      el('div', { class: 'hero-price' },
        el('strong', { class: 'mono' }, quote ? quote.price.toFixed(2) : '—'),
        quote ? el('span', { class: 'mono change' + tone(quote.change) }, `${quote.change > 0 ? '+' : ''}${quote.change.toFixed(2)} (${pct(quote.changePercent)})`) : null),
      el('p', { class: 'micro' },
        [prettyName(company.name), company.exchange, profile?.industry].filter(Boolean).join(' · '),
        quote ? ` · ${quote.source === 'tiingo' ? 'Tiingo fallback' : 'Finnhub'} · last trade ${date(quote.time)}` : ''),
      el('p', { class: `micro market-health market-${marketStatus.state}` }, marketStatus.detail),
      el('p', { class: 'radar-note radar-text-' + radar.level }, radar.reasons.join(' ')),
      company.list === 'holdings' || company.position
        ? el('div', { class: 'position-grid' },
            ...(company.position
              ? [
                  ['Shares', company.position.shares.toLocaleString('en-US')],
                  ['Avg cost', money(company.position.cost)],
                  ['Value', position ? money(position.value) : '—'],
                  ['Today', position ? signedMoney(position.day) : '—', position?.day],
                  ['Unrealised', position ? `${signedMoney(position.unrealized)} (${pct(position.unrealizedPercent)})` : '—', position?.unrealized],
                ].map(([label, value, sign]) =>
                  el('div', {}, el('span', { class: 'micro' }, String(label)), el('span', { class: 'mono' + tone(sign as number | undefined) }, String(value))))
              : [el('p', { class: 'muted' }, 'Add shares and average cost to see value and P&L. They stay in this browser.')]),
            button(company.position ? 'Edit position' : 'Add position', () => companyDialog(company), 'small'))
        : null,
    ),
    el(
      'section',
      { class: 'board-card' },
      el('div', { class: 'section-head' }, el('h2', {}, 'Coverage · last 7 days'), el('span', { class: 'micro' }, `${stories.length} direct-mention stories`)),
      el('div', { class: 'coverage-bars', role: 'img', 'aria-label': 'Stories per day' },
        ...timeline.map((day) =>
          el('div', { class: 'coverage-day' },
            el('span', { class: 'mono count' }, String(day.count)),
            el('span', { class: 'bar', style: `height:${Math.round((day.count / max) * 100)}%` }),
            el('span', { class: 'micro' }, new Date(day.end).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'Asia/Shanghai' }))))),
    ),
    el(
      'div',
      { class: 'board-grid' },
      el('section', { class: 'board-card' },
        el('div', { class: 'section-head' }, el('h2', {}, 'Peers'), el('span', { class: 'micro' }, 'Finnhub peers · not mentions')),
        profilePending.has(company.symbol)
          ? el('p', { class: 'muted' }, 'Loading profile…')
          : profile?.peers.length
            ? el('div', { class: 'peer-list' }, ...profile.peers.slice(0, 6).map((peer) => {
                const q = peerQuotes[peer] ?? market?.quotes[peer];
                const followed = state.companies.find((c) => c.symbol === peer);
                const mentions = snapshot.events.filter((event) => new RegExp(`\\$${peer}\\b|\\(${peer}\\)`).test(event.title)).length;
                return el('div', { class: 'peer-row' },
                  el('span', { class: 'mono' }, peer),
                  el('span', { class: 'micro' }, followed ? `In your ${followed.list}` : mentions ? `${mentions} tagged stories` : ''),
                  el('span', { class: 'mono change' + tone(q?.changePercent) }, q ? pct(q.changePercent) : '—'));
              }))
            : el('p', { class: 'muted' }, profileErrors.get(company.symbol) || (market?.configured === false ? 'Peers need FINNHUB_API_KEY.' : 'No peers listed.'))),
      el('section', { class: 'board-card' },
        el('div', { class: 'section-head' }, el('h2', {}, 'Supply chain'), button('＋ Link', () => linkDialog(company), 'small quiet')),
        company.links?.length
          ? el('div', { class: 'peer-list' }, ...company.links.map((item) =>
              el('div', { class: 'peer-row' },
                el('span', { class: 'relation relation-' + item.relation }, item.relation.toUpperCase()),
                el('span', { class: 'mono' }, item.symbol),
                el('span', { class: 'micro' }, item.note || ''),
                el('span', { class: 'mono change' + tone(quoteFor(item.symbol)?.changePercent) }, quoteFor(item.symbol) ? pct(quoteFor(item.symbol)!.changePercent) : ''))))
          : el('p', { class: 'muted' }, 'Add suppliers, customers or partners you want to keep in view.'),
        el('p', { class: 'micro' }, 'Links you add are shown as related, never as direct mentions.')),
      el('section', { class: 'board-card' },
        el('h2', {}, 'Next earnings'),
        profile?.nextEarnings
          ? el('p', { class: 'mono earnings-date' }, new Date(profile.nextEarnings.date + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
              profile.nextEarnings.hour === 'amc' ? ' · after close' : profile.nextEarnings.hour === 'bmo' ? ' · before open' : '')
          : el('p', { class: 'muted' }, profilePending.has(company.symbol) ? 'Loading…' : 'Not announced in the next four months.'),
        profile?.nextEarnings?.epsEstimate !== undefined ? el('p', { class: 'micro' }, `EPS estimate ${profile.nextEarnings.epsEstimate.toFixed(2)} · Finnhub calendar`) : null),
      el('section', { class: 'board-card' },
        el('div', { class: 'section-head' }, el('h2', {}, 'Names used for matching'), button('Edit', () => companyDialog(company), 'small quiet')),
        el('div', { class: 'name-chips' },
          ...names.auto.map((name) => el('span', { class: 'name-chip' }, name)),
          ...names.contextual.map((name) => el('span', { class: 'name-chip contextual', title: 'Counts only with a company word nearby (shares, CEO, earnings…)' }, name)),
          ...names.user.map((name) => el('span', { class: 'name-chip user', title: 'Added by you' }, name)),
          el('span', { class: 'name-chip ticker', title: 'Tickers count as $TICKER, NASDAQ:TICKER, (TICKER.O) or “TICKER stock”' }, '$' + company.symbol)),
        el('p', { class: 'micro' }, company.provenance === 'catalog' ? 'Blue: from the verified company name and reviewed dictionary. Dashed: needs a company word nearby. Solid white: yours.' : 'Manual identity: only your aliases and ticker tags are used.')),
    ),
  ];
}
async function polishBrief(lines: string[], key: string) {
  if (briefPending) return;
  const epoch = aiViewEpoch;
  briefPending = true;
  briefError = '';
  render();
  try {
    const result = await postJson<{ text: string; generatedAt: string }>('/api/world-pulse/brief', { lines }, 40000);
    if (typeof result.text !== 'string' || !result.text.trim()) throw new Error('Empty AI wording');
    if (epoch !== aiViewEpoch) return;
    briefAI = { key, text: result.text, generatedAt: result.generatedAt };
  } catch (error) {
    if (epoch === aiViewEpoch) briefError = error instanceof Error ? error.message : 'AI wording unavailable';
  } finally {
    if (epoch === aiViewEpoch) { briefPending = false; render(); }
  }
}
function linkDialog(company: PulseCompany) {
  const symbol = el('input', { required: true, maxlength: 15, placeholder: 'e.g. TSM', 'aria-label': 'Linked ticker' });
  const relation = el('select', { 'aria-label': 'Relation' },
    ...(['supplier', 'customer', 'partner', 'competitor'] as const).map((r) => el('option', { value: r }, r[0]!.toUpperCase() + r.slice(1))));
  const note = el('input', { maxlength: 120, placeholder: 'Optional note, e.g. foundry', 'aria-label': 'Note' });
  const error = el('p', { class: 'form-error', role: 'alert' });
  const links = company.links ?? [];
  openDialog(
    `${company.symbol} · supply chain`,
    links.length
      ? el('div', {}, ...links.map((item, index) =>
          el('div', { class: 'saved-row' },
            el('span', {}, `${item.relation} · ${item.symbol}${item.note ? ' · ' + item.note : ''}`),
            button('Remove', () => {
              updateCompany(company.id, { links: links.filter((_, i) => i !== index) });
              closeDialog();
              render();
            }, 'small quiet'))))
      : null,
    el('form', {
      onsubmit: (event: Event) => {
        event.preventDefault();
        const ticker = symbol.value.trim().toUpperCase();
        if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(ticker) || ticker === company.symbol) {
          error.textContent = 'Enter another US ticker.';
          return;
        }
        if (links.length >= 30) {
          error.textContent = 'At most 30 links per company.';
          return;
        }
        const entry: PulseCompanyLink = { symbol: ticker, relation: relation.value as PulseCompanyLink['relation'], ...(note.value.trim() ? { note: note.value.trim().slice(0, 120) } : {}) };
        updateCompany(company.id, { links: [...links.filter((l) => l.symbol !== ticker), entry] });
        closeDialog();
        render();
        void fetchMarket();
      },
    },
      el('div', { class: 'control-row' }, field('TICKER', symbol), field('RELATION', relation)),
      field('NOTE', note),
      error,
      el('p', { class: 'micro' }, 'Your own notes. Linked companies are never counted as direct mentions.'),
      el('div', { class: 'dialog-actions' }, el('button', { type: 'submit', class: 'primary' }, 'Add link'))),
  );
}
function updateCompany(id: string, patch: Partial<PulseCompany>) {
  state.companies = state.companies.map((c) => {
    if (c.id !== id) return c;
    const next = { ...c, ...patch };
    if (patch.links && !patch.links.length) delete next.links;
    if ('position' in patch && !patch.position) delete next.position;
    return next;
  });
  persist();
}
function preserveFocus(container: HTMLElement) {
  const active = document.activeElement as HTMLElement | null;
  if (!active || !container.contains(active)) return () => {};
  const tag = active.tagName,
    label = active.getAttribute('aria-label'),
    text = active.textContent,
    eventId = active.closest('[data-event-id]')?.getAttribute('data-event-id');
  return () => {
    const replacement = Array.from(
      container.querySelectorAll<HTMLElement>('button,a,select,input,summary'),
    ).find(
      (e) =>
        e.tagName === tag &&
        e.getAttribute('aria-label') === label &&
        (label !== null || e.textContent === text) &&
        e.closest('[data-event-id]')?.getAttribute('data-event-id') === eventId,
    );
    replacement?.focus({ preventScroll: true });
  };
}
function worldRegionSelect() {
  const input = el(
    'select',
    {
      'aria-label': 'World region',
      onchange: () => {
        current().regions = input.value ? [input.value] : [];
        persist();
        render();
      },
    },
    el('option', { value: '' }, 'All regions'),
    ...Array.from(
      new Set(snapshot.events.map((e) => e.location?.country).filter(Boolean) as string[]),
    )
      .sort((a, b) => regionName(a).localeCompare(regionName(b)))
      .map((code) => el('option', { value: code }, regionName(code))),
  );
  input.value = current().regions[0] || '';
  return el('div', { class: 'world-region' }, input);
}
function render() {
  syncAIView();
  updateHeader();
  const openIndicators = new Set(
    [...side.querySelectorAll<HTMLDetailsElement>('.event-indicators[open]')].map((node) =>
      node.closest('[data-event-id]')?.getAttribute('data-event-id'),
    ),
  );
  const restoreSideFocus = preserveFocus(side);
  command.update(snapshot);
  const matches = results();
  const titles = {
    world: [
      'THE WORLD, IN CONTEXT',
      'World overview',
      'A clear view of the stories unfolding around us.',
    ],
    portfolio: [
      'YOUR COMPANIES, IN CONTEXT',
      'Portfolio lens',
      'Trace company mentions back to the reporting.',
    ],
    explore: [
      'FOLLOW YOUR CURIOSITY',
      'Explore the signals',
      'Combine regions, topics and sources.',
    ],
  };
  const info = titles[mode];
  mapTitle.replaceChildren(
    el('span', { class: 'eyebrow' }, info[0]!),
    el('h1', {}, info[1]!),
    el('p', {}, info[2]!),
  );
  const countButton = button(
    `${matches.length} events`,
    () => side.querySelector('.event-list')?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    'event-count',
    { 'aria-label': 'View counted events' },
  );
  side.replaceChildren(
    el(
      'div',
      { class: 'sidebar-heading' },
      el(
        'span',
        { class: 'eyebrow' },
        mode === 'explore'
          ? 'BUILD A QUERY'
          : mode === 'portfolio'
            ? 'MY COMPANIES'
            : 'EVENT STREAM',
      ),
      countButton,
    ),
  );
  if (mode === 'world') side.append(topicButtons(), coverageControls(), worldRegionSelect());
  if (mode === 'portfolio') side.append(portfolioControls());
  if (mode === 'explore') side.append(exploreControls());
  side.append(chips());
  if (mode === 'world' && (current().regions.length || current().categories.length))
    side.append(
      button(
        'Explore this selection →',
        () => exploreFrom(current().regions, current().categories),
        'explore-link',
      ),
    );
  if (mode !== 'portfolio') {
    const candidates = filterEvents(
      snapshot.events,
      mode,
      { ...current(), showFiltered: true, sort: 'latest' },
      state.companies,
    );
    const hiddenCount = candidates.filter((e) => e.relevance?.decision === 'exclude').length;
    side.append(
      button(
        `${current().showFiltered ? 'Hide' : 'Show'} filtered (${hiddenCount})`,
        () => {
          current().showFiltered = !current().showFiltered;
          persist();
          render();
        },
        'quiet',
        { 'aria-pressed': String(!!current().showFiltered) },
      ),
    );
  }
  {
    const lowCandidates = filterEvents(
      snapshot.events,
      mode,
      { ...current(), showLowQuality: true, sort: 'latest' },
      state.companies,
    ).filter((e) => eventQuality(e).onlyLowQuality).length;
    if (lowCandidates || current().showLowQuality)
      side.append(
        button(
          `${current().showLowQuality ? 'Hide' : 'Show'} low-quality sources (${lowCandidates})`,
          () => {
            current().showLowQuality = !current().showLowQuality;
            persist();
            render();
          },
          'quiet',
          {
            'aria-pressed': String(!!current().showLowQuality),
            title: 'Stories reported only by promotional, press-release or SEO outlets, or by publishers you blocked.',
          },
        ),
      );
  }
  side.append(sortingControls());
  if (snapshot.cacheTruncated)
    side.append(
      el(
        'p',
        { class: 'notice' },
        'Local history reached its 15,000-record limit. Some coverage was truncated.',
      ),
    );
  if (!loaded && busy)
    side.append(
      el(
        'div',
        { class: 'empty-state' },
        el('span', { class: 'loading-line' }),
        el('h3', {}, 'Connecting the dots'),
        el('p', {}, 'Reading original sources. The map is ready to explore.'),
      ),
    );
  else if (!matches.length) {
    const failed =
      connectionError ||
      (snapshot.sources.length && snapshot.sources.every((s) => s.state === 'error'));
    const portfolioCompanies = state.companies.filter((company) => company.list === current().list);
    const portfolioLoads = portfolioCompanies.flatMap((company) => {
      const load = companyLoads.get(company.id);
      return load ? [load] : [];
    });
    const portfolioPending = portfolioLoads.some((load) => load.state === 'loading');
    const portfolioFailed =
      !!portfolioCompanies.length &&
      portfolioLoads.length === portfolioCompanies.filter((c) => c.provenance === 'catalog').length &&
      portfolioLoads.length > 0 &&
      portfolioLoads.every((load) => load.state === 'error');
    side.append(
      el(
        'div',
        { class: 'empty-state' },
        el('div', { class: 'empty-icon' }, '◎'),
        el(
          'h3',
          {},
          failed
            ? 'Sources unavailable'
            : mode === 'portfolio' && !portfolioCompanies.length
              ? 'Your world starts here'
              : mode === 'portfolio' && portfolioPending
                ? 'Fetching company reports'
                : mode === 'portfolio' && portfolioFailed
                  ? 'Company sources unavailable'
              : 'No matching reports',
        ),
        el(
          'p',
          {},
          failed
            ? 'Source retrieval failed. Open source status or retry.'
            : mode === 'portfolio'
              ? portfolioPending
                ? 'Loading company news… Results will appear as each company finishes.'
                : portfolioFailed
                  ? 'Every company-specific source failed. Global reporting remains available in World and Explore.'
                  : 'Reports were checked, but none contain a reliable direct mention in the current filters. Try the last 7 days.'
              : 'Try a wider time range or remove a filter.',
        ),
        button('View source status', () => settings('sources'), 'small'),
      ),
    );
  }
  const eventList = el('div', {
    class: 'event-list',
    'aria-label': 'Event results',
  });
  for (const event of matches.slice(0, displayed)) {
    const direct =
      mode === 'portfolio'
        ? matchCompanies(
            event,
            state.companies.filter(
              (c) =>
                c.list === current().list &&
                (!current().selectedCompany || c.id === current().selectedCompany),
            ),
          )
        : [];
    const lead = event.reports?.[0]?.source ?? event.sources[0];
    const quality = eventQuality(event);
    const leadOutlet = lead ? sourceOutlet(lead) : undefined;
    const reportTime = event.publishedAt || event.firstSeenAt || '';
    const card = el(
      'article',
      {
        class: 'event-card' + (selected?.id === event.id ? ' selected' : ''),
        'data-event-id': event.id,
      },
      el(
        'div',
        { class: 'card-meta' },
        el('span', {
          class: 'category-dot cat-' + event.category.toLowerCase(),
        }),
        el('span', {}, event.category.toUpperCase()),
        el(
          'time',
          { datetime: event.publishedAt || event.firstSeenAt || discoveryTime(event) || '' },
          event.publishedAt ? ago(event.publishedAt) : 'Discovered ' + ago(discoveryTime(event)),
        ),
      ),
      button(event.title, () => setEvent(event), 'event-title'),
      indicator(event),
      relevanceBadge(event),
      el(
        'div',
        { class: 'card-bottom' },
        lead &&
          link(
            `${leadOutlet!.label}${quality.outlets.length > 1 ? ` +${quality.outlets.length - 1}` : ''} ↗`,
            lead.url,
            'source-link',
          ),
        el(
          'span',
          { class: 'location-label' },
          event.location
            ? `${event.location.precision === 'exact' ? '⌖' : '◇'} ${event.location.name}`
            : 'Location unavailable',
        ),
      ),
      quality.onlyLowQuality
        ? el('p', { class: 'quality-note' }, `Low-quality source · ${assessReport({ title: event.title, source: lead! }).reason}`)
        : quality.lowQuality.length
          ? el('p', { class: 'quality-note micro' }, `${quality.lowQuality.length} low-quality ${quality.lowQuality.length === 1 ? 'copy' : 'copies'} folded away`)
          : null,
      direct.length
        ? el(
            'div',
            { class: 'match-badges' },
            ...direct.map((m) => {
              const since = sinceReport(reportPrices.get(`${m.symbol}|${reportTime}`), quoteFor(m.symbol));
              return el(
                'span',
                { title: since === undefined ? 'Direct mention in the reporting' : 'Price change since this report, from prices recorded locally. Timing only, not cause.' },
                m.symbol + ' · direct mention' + (since === undefined ? '' : ` · since ${pct(since)}`),
              );
            }),
          )
        : null,
    );
    eventList.append(card);
  }
  if (matches.length > displayed)
    eventList.append(
      button(
        `Show more (${matches.length - displayed} remaining)`,
        () => {
          displayed += 50;
          render();
        },
        'load-more',
      ),
    );
  side.append(eventList);
  const dated = snapshot.events
    .map((e) => e.publishedAt || discoveryTime(e))
    .filter((value): value is string => !!value)
    .sort();
  side.append(
    el(
      'p',
      { class: 'coverage-note' },
      dated.length
        ? `Observed publication/discovery coverage: ${date(dated[0]!)} — ${date(dated[dated.length - 1]!)}. Feeds are partial, not a complete archive.`
        : 'Coverage will appear after sources respond.',
    ),
  );
  const base = filterEvents(
    snapshot.events,
    'world',
    { ...defaultModeState(), hours: current().hours },
    [],
  );
  map?.update(
    matches,
    mode === 'portfolio' ? base.filter((e) => !matches.some((m) => m.id === e.id)) : [],
    selected?.id || '',
  );
  const fresh = snapshot.sources.filter((s) => s.state === 'fresh').length;
  footerStatus.textContent = busy
    ? '↻ Updating sources…'
    : `${fresh}/${snapshot.sources.length || 6} sources fresh · ${connectionError ? 'connection error' : snapshot.fetchedAt ? 'Checked ' + date(snapshot.fetchedAt) : 'Waiting for data'} ↗`;
  footerStatus.classList.toggle('degraded', fresh < snapshot.sources.length || !!connectionError);
  renderBoard(matches);
  renderDetail(matches);
  for (const node of side.querySelectorAll<HTMLDetailsElement>('.event-indicators'))
    if (openIndicators.has(node.closest('[data-event-id]')?.getAttribute('data-event-id')))
      node.open = true;
  restoreSideFocus();
}
function exploreFrom(regions: string[], cats: PulseCategory[]) {
  state.modes.explore = {
    ...defaultModeState(),
    regions: [...regions],
    categories: [...cats],
    hours: current().hours,
    camera: { ...current().camera },
  };
  persist();
  navigate('explore');
  toast('Selection opened in Explore.');
}
function setOutletList(key: string, list: 'blocked' | 'trusted' | 'none') {
  const current = state.outlets ?? outletPreferences();
  state.outlets = {
    blocked: list === 'blocked' ? [...new Set([...current.blocked, key])] : current.blocked.filter((k) => k !== key),
    trusted: list === 'trusted' ? [...new Set([...current.trusted, key])] : current.trusted.filter((k) => k !== key),
  };
  applyOutletPreferences(state);
  persist();
  render();
}
function sourcesSection(e: PulseEvent) {
  const reports = reportsForArticle(e);
  const groups = new Map<string, { outlet: ReturnType<typeof sourceOutlet>; items: { report: PulseReport; quality: ReturnType<typeof assessReport> }[] }>();
  for (const report of reports) {
    const quality = assessReport(report);
    const group = groups.get(quality.outlet.key) ?? { outlet: quality.outlet, items: [] };
    group.items.push({ report, quality });
    groups.set(quality.outlet.key, group);
  }
  const ordered = [...groups.values()].sort((a, b) => {
    const rank = (g: typeof a) => ({ A: 0, B: 1, C: 2, blocked: 3 })[g.items[0]!.quality.quality];
    return rank(a) - rank(b) || a.outlet.label.localeCompare(b.outlet.label);
  });
  const prefs = outletPreferences();
  const counted = ordered.filter((g) => !['C', 'blocked'].includes(g.items[0]!.quality.quality)).length;
  return el(
    'section',
    { class: 'detail-section' },
    el('h3', {}, `Sources · ${counted} independent ${counted === 1 ? 'outlet' : 'outlets'} · ${reports.length} ${reports.length === 1 ? 'report' : 'reports'}`),
    el('p', { class: 'micro' }, 'One outlet counts once however many feeds or names it appears under. Grey rows are low-quality or blocked and do not count toward heat.'),
    ...ordered.map((group, index) => {
      const q = group.items[0]!.quality.quality;
      const blocked = prefs.blocked.includes(group.outlet.key);
      const trusted = prefs.trusted.includes(group.outlet.key);
      return el(
        'div',
        { class: 'outlet-group tier-' + q },
        el(
          'div',
          { class: 'outlet-head' },
          el('span', { class: 'source-number' }, String(index + 1).padStart(2, '0')),
          el('span', { class: 'tier-badge', title: group.items[0]!.quality.reason }, q === 'blocked' ? 'BLOCKED' : q),
          el('strong', {}, group.outlet.label),
          el(
            'span',
            { class: 'outlet-actions' },
            button(blocked ? 'Unblock' : 'Block', () => setOutletList(group.outlet.key, blocked ? 'none' : 'blocked'), 'small quiet', { 'aria-label': `${blocked ? 'Unblock' : 'Block'} ${group.outlet.label}` }),
            group.outlet.tier === 'C' || trusted
              ? button(trusted ? 'Untrust' : 'Trust', () => setOutletList(group.outlet.key, trusted ? 'none' : 'trusted'), 'small quiet', { 'aria-label': `${trusted ? 'Stop trusting' : 'Trust'} ${group.outlet.label}` })
              : null,
          ),
        ),
        ...group.items.map(({ report }) => link(`${reportTitle(report)} ↗`, report.source.url, 'outlet-report')),
        q === 'C' ? el('p', { class: 'micro' }, group.items[0]!.quality.reason) : null,
      );
    }),
  );
}
function renderDetail(matches: PulseEvent[]) {
  syncAIView();
  const restoreDetailFocus = preserveFocus(detail);
  const metricsOpen =
    detail.querySelector<HTMLDetailsElement>('.event-indicators')?.open &&
    detail.dataset.eventId === selected?.id;
  const evidenceOpen =
    detail.querySelector<HTMLDetailsElement>('details.provenance')?.open &&
    detail.dataset.eventId === selected?.id;
  detail.hidden = !selected;
  workspace.classList.toggle('has-detail', !!selected);
  if (!selected) {
    detail.replaceChildren();
    return;
  }
  const e = snapshot.events.find((x) => x.id === selected!.id) || selected;
  selected = e;
  const sources = e.sources;
  const articleReports = reportsForArticle(e);
  const articleReport = activeArticleReport(e);
  const articleId = articleReport ? articleKey(e, articleReport) : '';
  const article = articleId ? articles.get(articleId) : undefined;
  const articleLoading =
    (!!articleId && pendingArticles.has(articleId)) || pendingArticles.has(`${e.id}:auto`);
  const nextReport = article?.state === 'unavailable' ? nextReadableReport(e, articleReport) : undefined;
  detail.dataset.eventId = e.id;
  const ai = explanationVersions.get(e.id) === eventVersion(e) ? explanations.get(e.id) : undefined;
  const analysisSections = ai ? (['core', 'change', 'impact', 'watch'] as const).map((section) => {
    const items = ai.statements.filter((statement) => statement.section === section);
    if (!items.length) return null;
    const labels = { core: 'Core facts', change: 'Key changes', impact: 'Why it matters', watch: 'What to verify next' };
    return el('section', { class: `ai-insight-block ai-${section}` },
      el('h4', {}, labels[section], el('span', { class: 'ai-kind' }, section === 'impact' ? 'INFERENCE' : section === 'watch' ? 'OPEN QUESTIONS' : 'REPORTED')),
      ...items.map((item) => el('p', { lang: 'zh-CN' }, item.text, ' ', ...item.sourceIds.map((id) => {
        const source = sources.find((value) => value.id === id);
        return source ? link(`[${sources.indexOf(source) + 1}]`, source.url, 'citation') : null;
      }))));
  }) : [];
  const direct =
    mode === 'portfolio'
      ? matchCompanies(
          e,
          state.companies.filter(
            (c) =>
              c.list === current().list &&
              (!current().selectedCompany || c.id === current().selectedCompany),
          ),
        )
      : [];
  setChildren(
    detail,
    el(
      'div',
      { class: 'detail-top' },
      el('span', { class: 'eyebrow' }, 'EVENT BRIEF'),
      button(
        '×',
        () => {
          clearTransientAI();
          selected = null;
          selectedByMode[mode] = undefined;
          render();
        },
        'close',
        { 'aria-label': 'Close event details' },
      ),
    ),
    !matches.some((m) => m.id === e.id)
      ? el(
          'p',
          { class: 'notice' },
          'This event is outside the current results. Kept open for your reading.',
        )
      : null,
    el(
      'div',
      { class: 'detail-meta' },
      e.category.toUpperCase(),
      ' · ',
      e.location?.precision.toUpperCase() || 'UNLOCATED',
    ),
    el('h2', {}, sources[0] ? link(e.title, sources[0].url) : e.title),
    indicator(e),
    e.community
      ? el(
          'p',
          { class: 'notice' },
          `HN community · ${e.community.score} points · ${e.community.comments} comments · `,
          link('Discussion ↗', e.community.url),
        )
      : null,
    e.filing?.metadataOnly
      ? el(
          'p',
          { class: 'notice' },
          `${e.filing.form} filing metadata only. The document text has not been read or summarized.`,
        )
      : null,
    el(
      'p',
      { class: 'detail-summary' },
      e.summary || 'The feed provides a headline only. Open the original report for full context.',
    ),
    el('section', { class: 'detail-section ai-section', 'aria-label': 'AI insight' },
      el('div', { class: 'section-head' }, el('h3', {}, 'AI insight'), el('span', { class: 'micro' }, 'CHAT COMPLETIONS · ENGLISH')),
      ai
        ? el('div', { class: 'ai-content' },
            el('p', { class: 'ai-basis' }, ai.basis.mode === 'article-excerpts' ? `Based on ${ai.basis.articleCount} article excerpt(s) + ${ai.basis.reportCount} report(s)` : `Based on ${ai.basis.reportCount} headline / summary report(s)`),
            ...analysisSections,
            el('p', { class: 'micro', lang: 'zh-CN' }, ai.limitation))
        : el('p', { class: 'muted' }, snapshot.aiControl?.effective
            ? 'Extract the core facts, understand the implications, and identify what to verify next. Uses available article text; inference is labeled separately.'
            : snapshot.aiControl?.enabled ? 'No AI provider is configured.' : 'AI is off.'),
      explanationErrors.has(e.id) ? el('p', { class: 'notice', role: 'alert' }, explanationErrors.get(e.id)!) : null,
      el('div', { class: 'ai-actions' },
        button(pendingAI.has(e.id) ? 'Analyzing…' : snapshot.aiControl?.effective ? ai ? 'Regenerate analysis' : 'Analyze this story' : 'AI is off',
          () => snapshot.aiControl?.effective ? void explain(e.id) : settings('ai'), 'ai-button',
          { disabled: pendingAI.has(e.id) || !snapshot.aiControl?.effective }),
        ai || pendingAI.has(e.id) ? button(pendingAI.has(e.id) ? 'Cancel analysis' : 'Clear analysis', () => { clearTransientAI(); render(); }, 'quiet small') : null),
      el('p', { class: 'ai-privacy micro' }, 'Temporary view · Cleared on close or switch · Not saved by this app'),
    ),
    articleReport
      ? el(
          'section',
          { class: 'detail-section article-reader' },
          el(
            'div',
            { class: 'section-head' },
            el('h3', {}, 'Original article'),
            link('Open publisher ↗', article?.sourceUrl || articleReport.source.url),
          ),
          articleReports.length > 1
            ? el(
                'div',
                { class: 'article-source-picker', 'aria-label': 'Select an outlet to read' },
                ...pickerReports(articleReports, articleReport).map((report) =>
                  button(
                    sourceOutlet(report.source).label,
                    () => {
                      clearTransientAI();
                      selectedArticleReports.set(e.id, report.id);
                      renderDetail(results());
                      void loadArticle(e, report);
                    },
                    report.id === articleReport.id ? 'active' : 'quiet',
                    { 'aria-pressed': String(report.id === articleReport.id) },
                  ),
                ),
                pickerReports(articleReports, articleReport).length < new Set(articleReports.map((r) => sourceOutlet(r.source).key)).size
                  ? el('span', { class: 'micro' }, 'More outlets in Sources below')
                  : null,
              )
            : null,
          el(
            'p',
            { class: 'micro' },
            article?.cached
              ? 'Saved locally within the seven-day reading window.'
              : 'Requested from the publisher when you opened this event.',
            article?.resolvedFrom === 'google-news' ? ' Publisher link resolved from Google News.' : '',
            article?.skipped ? ` ${article.skipped} other outlet${article.skipped === 1 ? '' : 's'} could not be read first.` : '',
          ),
          articleLoading
            ? el('p', { class: 'reader-loading', role: 'status' }, 'Loading public article text…')
            : article?.state === 'available'
              ? el(
                  'article',
                  { class: 'article-copy', lang: 'auto' },
                  ...article.paragraphs.map((paragraph) => el('p', {}, paragraph)),
                )
              : article?.state === 'unavailable'
                ? el(
                    'div',
                    { class: 'reader-unavailable' },
                    el(
                      'p',
                      { class: 'notice' },
                      article.message || 'Open the original report to read this publisher’s version.',
                    ),
                    articleReport && articleReport.summary && cleanHeadline(articleReport.summary, articleReport.source) !== reportTitle(articleReport)
                      ? el('blockquote', { class: 'summary-only' }, el('span', { class: 'eyebrow' }, 'FEED SUMMARY ONLY'), el('p', {}, articleReport.summary))
                      : null,
                    el(
                      'div',
                      { class: 'control-row' },
                      nextReport
                        ? button(`Read ${sourceOutlet(nextReport.source).label} instead`, () => void loadArticle(e, nextReport), 'small')
                        : null,
                      button(
                        'Try again',
                        () => {
                          articles.delete(articleId);
                          void loadArticle(e, articleReport);
                        },
                        'small quiet',
                      ),
                    ),
                  )
                : el('p', { class: 'reader-loading', role: 'status' }, 'Preparing public article text…'),
        )
      : null,
    el(
      'dl',
      { class: 'fact-grid' },
      e.timeBasis === 'source-updated'
        ? el('dt', {}, 'Source updated')
        : e.timeBasis === 'source-published'
          ? el('dt', {}, 'Source published')
          : null,
      e.timeBasis === 'source-updated' || e.timeBasis === 'source-published'
        ? el('dd', {}, date(e.publishedAt))
        : null,
      el('dt', {}, 'First discovered'),
      el('dd', {}, date(e.firstSeenAt || discoveryTime(e), 'Unavailable')),
      el('dt', {}, 'Last synchronized'),
      el('dd', {}, date(e.lastFetchedAt || e.fetchedAt)),
      el('dt', {}, 'Location'),
      el(
        'dd',
        {},
        e.location ? `${e.location.name} · ${e.location.precision}` : 'Location unavailable',
      ),
    ),
    e.magnitude !== undefined
      ? el('p', { class: 'notice' }, `USGS reported magnitude: ${e.magnitude}`)
      : null,
    el(
      'details',
      { class: 'provenance' },
      el('summary', {}, 'Classification & location evidence'),
      el('p', {}, 'System classification: ', e.classificationBasis),
      el(
        'p',
        {},
        e.location
          ? `Location evidence: ${e.location.evidence}`
          : 'No reliable location identified. Company headquarters are never substituted.',
      ),
    ),
    e.cluster?.memberEventIds && e.cluster.memberEventIds.length > 1
      ? el(
          'details',
          { class: 'provenance cluster-evidence' },
          el('summary', {}, `Why ${e.cluster.memberEventIds.length} reports form one story`),
          e.cluster.reasons.includes('same-article')
            ? el('p', {}, 'Same article: copies of one headline reached us through several feeds within 72 hours (for example a publisher’s own RSS and its Google News listing).')
            : null,
          (e.cluster.pairEvidence ?? []).length
            ? el('p', {}, 'Same event: grouped only when time, category, reliable entities and title or action evidence agree, and no country, company, figure or policy direction conflicts.')
            : null,
          ...(e.cluster.pairEvidence ?? []).map((pair) =>
            el(
              'p',
              { class: 'micro' },
              `${pair.matchedBy === 'title-similarity' ? 'Similar titles' : 'Matching action, topic and place'} · ${pair.sharedEntities.map((entity) => entity.label).join(', ')}`,
            ),
          ),
        )
      : null,
    direct.length
      ? el(
          'section',
          { class: 'detail-section' },
          el('h3', {}, 'Why it appears in Portfolio'),
          ...direct.map((m) =>
            el(
              'div',
              { class: 'evidence' },
              el('b', {}, `${m.symbol} · direct mention`),
              el('p', {}, `Matched “${m.term}”`),
              m.provenance === 'user-provided'
                ? el('p', { class: 'micro' }, 'User provided alias')
                : null,
              el('blockquote', {}, m.excerpt),
              link('Read the evidence ↗', m.sourceUrl),
            ),
          ),
          el(
            'p',
            { class: 'micro' },
            'Mention ≠ business impact. No direction of price movement is inferred.',
          ),
        )
      : null,
    sourcesSection(e),
    button(
      'Explore this topic →',
      () => exploreFrom(e.location?.country ? [e.location.country] : [], [e.category]),
      'explore-link',
    ),
  );
  if (evidenceOpen) detail.querySelector<HTMLDetailsElement>('details.provenance')!.open = true;
  if (metricsOpen) detail.querySelector<HTMLDetailsElement>('.event-indicators')!.open = true;
  restoreDetailFocus();
}
async function fetchData(force = false) {
  if (busy) return;
  busy = true;
  refreshButton.disabled = true;
  render();
  try {
    const res = await fetch('/api/world-pulse/events' + (force ? '?refresh=1' : ''), {
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) throw new Error('Local data service unavailable');
    const next = (await res.json()) as PulseSnapshot;
    if (!Array.isArray(next.events) || !Array.isArray(next.sources))
      throw new Error('Unexpected data response');
    for (const [id, version] of explanationVersions) {
      const event = next.events.find((e) => e.id === id);
      if (!event || eventVersion(event) !== version) {
        explanations.delete(id);
        explanationVersions.delete(id);
      }
    }
    snapshot = next;
    pruneClientNews();
    connectionError = '';
    loaded = true;
    void fetchCompanyData();
    refreshPortfolioData();
  } catch {
    connectionError = 'Local data service unavailable';
    loaded = true;
    toast('Unable to update. Previous data is retained.');
  } finally {
    busy = false;
    refreshButton.disabled = false;
    render();
  }
}
function formInput(form: HTMLFormElement, name: string): HTMLInputElement | undefined {
  return form.querySelector<HTMLInputElement>(`[name="${name}"]`) ?? undefined;
}
function setAIConfigStatus(message: string) {
  const status = document.querySelector<HTMLElement>('#ai-config-status');
  if (status) status.textContent = message;
}
function populateAIConfigForm() {
  const form = document.querySelector<HTMLFormElement>('#ai-provider-form');
  if (!form || !localAIConfig) return;
  const url = formInput(form, 'apiUrl');
  const model = formInput(form, 'model');
  const key = formInput(form, 'apiKey');
  const inputPrice = formInput(form, 'inputPricePerMillion');
  const outputPrice = formInput(form, 'outputPricePerMillion');
  if (url) url.value = localAIConfig.apiUrl;
  if (model) model.value = localAIConfig.model;
  if (key) {
    key.value = '';
    key.placeholder = localAIConfig.keyConfigured
      ? 'Saved key is hidden; leave blank to keep it'
      : 'Enter your API key';
  }
  if (inputPrice)
    inputPrice.value = localAIConfig.inputPricePerMillion?.toString() ?? '';
  if (outputPrice)
    outputPrice.value = localAIConfig.outputPricePerMillion?.toString() ?? '';
  const keyState = document.querySelector<HTMLElement>('#ai-key-state');
  if (keyState) keyState.textContent = localAIConfig.keyConfigured ? 'Key saved · hidden' : 'No key saved';
  const clearButton = document.querySelector<HTMLButtonElement>('#ai-clear-key');
  if (clearButton) clearButton.disabled = !localAIConfig.keyConfigured;
  setAIConfigStatus('Local configuration loaded. The API key value is never returned.');
}
async function loadAIConfiguration() {
  if (localAIConfig) {
    populateAIConfigForm();
    return;
  }
  if (aiConfigRequest) return aiConfigRequest;
  aiConfigRequest = (async () => {
    try {
      const response = await fetch('/api/world-pulse/ai-config', {
        cache: 'no-store',
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error('Configuration unavailable');
      const result = (await response.json()) as LocalAIConfig;
      if (
        typeof result.apiUrl !== 'string' ||
        typeof result.model !== 'string' ||
        typeof result.keyConfigured !== 'boolean' ||
        (result.inputPricePerMillion !== null && typeof result.inputPricePerMillion !== 'number') ||
        (result.outputPricePerMillion !== null && typeof result.outputPricePerMillion !== 'number')
      )
        throw new Error('Invalid configuration response');
      localAIConfig = result;
      populateAIConfigForm();
    } catch {
      setAIConfigStatus('Unable to load local AI settings. The current values are unchanged.');
    } finally {
      aiConfigRequest = undefined;
    }
  })();
  return aiConfigRequest;
}
async function reloadLocalStatus() {
  try {
    const response = await fetch('/api/world-pulse/status', {
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
    if (response.ok) snapshot = (await response.json()) as PulseSnapshot;
  } catch {
    /* The saved configuration remains available even if the status refresh fails. */
  }
  render();
  settings('ai');
}
async function saveAIConfiguration() {
  const form = document.querySelector<HTMLFormElement>('#ai-provider-form');
  if (!form) return;
  const values = new FormData(form);
  const keyInput = formInput(form, 'apiKey');
  const submit = form.querySelector<HTMLButtonElement>('[type="submit"]');
  if (submit) submit.disabled = true;
  setAIConfigStatus('Saving configuration to this computer…');
  try {
    const response = await fetch('/api/world-pulse/ai-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({
        apiUrl: String(values.get('apiUrl') ?? ''),
        model: String(values.get('model') ?? ''),
        apiKey: String(values.get('apiKey') ?? ''),
        inputPricePerMillion: String(values.get('inputPricePerMillion') ?? ''),
        outputPricePerMillion: String(values.get('outputPricePerMillion') ?? ''),
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('Configuration rejected');
    localAIConfig = (await response.json()) as LocalAIConfig;
    if (keyInput) keyInput.value = '';
    populateAIConfigForm();
    setAIConfigStatus('Saved in the ignored local environment file. The key remains hidden.');
    await reloadLocalStatus();
  } catch {
    setAIConfigStatus('Unable to save configuration. Check the endpoint and token prices.');
  } finally {
    if (submit) submit.disabled = false;
  }
}
async function clearSavedAIKey() {
  const clearButton = document.querySelector<HTMLButtonElement>('#ai-clear-key');
  if (clearButton) clearButton.disabled = true;
  setAIConfigStatus('Clearing the saved API key…');
  try {
    const response = await fetch('/api/world-pulse/ai-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ clearApiKey: true }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('Key removal failed');
    localAIConfig = (await response.json()) as LocalAIConfig;
    await reloadLocalStatus();
    setAIConfigStatus('Saved API key removed from the local environment file.');
  } catch {
    setAIConfigStatus('Unable to clear the saved API key.');
  } finally {
    if (clearButton) clearButton.disabled = false;
  }
}
async function testAIConnection() {
  const status = document.querySelector('#ai-connection-status');
  if (status) status.textContent = 'Testing the configured provider…';
  try {
    const response = await fetch('/api/world-pulse/ai-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(35000),
    });
    const result = (await response.json()) as PulseAIStatus;
    if (status) status.textContent = `${result.state}: ${result.message}`;
  } catch {
    if (status)
      status.textContent =
        'Connection test failed or timed out. Original reports remain available.';
  }
}
async function assessEvent(event: PulseEvent) {
  if (!snapshot.aiControl?.effective) {
    settings('ai');
    return;
  }
  const company =
    mode === 'portfolio'
      ? activeCompanies().find((c) => matchCompanies(event, [c]).length)
      : undefined;
  if (mode === 'portfolio' && !company) {
    toast('No direct company evidence to assess.');
    return;
  }
  if (
    mode === 'portfolio' &&
    activeCompanies().filter((c) => matchCompanies(event, [c]).length).length > 1
  ) {
    toast('Select one company in the sidebar before requesting its AI assessment.');
    return;
  }
  const version = eventVersion(event);
  const key = event.id + ':' + (company?.id || 'public');
  const epoch = aiViewEpoch;
  const controller = new AbortController();
  if (pendingAI.has(key)) return;
  pendingAI.add(key);
  aiViewRequests.add(controller);
  toast('Assessing fetched evidence…');
  try {
    const response = await fetch('/api/world-pulse/assess', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventId: event.id,
        ...(company ? { companyId: company.id } : {}),
      }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(35000)]),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Assessment unavailable');
    if (epoch !== aiViewEpoch) return;
    const assessment = data as PulseAssessment;
    if (
      !['unassessed', 'watch', 'important', 'major'].includes(assessment.level) ||
      !Array.isArray(assessment.reasons) ||
      !assessment.sourceIds?.length ||
      assessment.sourceIds.some((id) => !event.sources.some((s) => s.id === id))
    )
      throw new Error('Invalid assessment evidence');
    const latest = snapshot.events.find((e) => e.id === event.id);
    if (!latest || eventVersion(latest) !== version)
      throw new Error('Reporting changed. Request a new assessment.');
    if (company)
      latest.companyAssessments = {
        ...latest.companyAssessments,
        [company.id]: assessment,
      };
    else latest.importance = assessment;
    render();
    toast('Assessment added with source evidence.');
  } catch (error) {
    if (epoch === aiViewEpoch) toast(error instanceof Error ? error.message : 'Assessment failed');
  } finally {
    aiViewRequests.delete(controller);
    if (epoch === aiViewEpoch) pendingAI.delete(key);
  }
}
async function explain(eventId: string) {
  const initialEvent = snapshot.events.find((e) => e.id === eventId);
  if (!initialEvent) return;
  const requestedVersion = eventVersion(initialEvent);
  const epoch = aiViewEpoch;
  const controller = new AbortController();
  if (pendingAI.has(eventId)) return;
  pendingAI.add(eventId);
  aiViewRequests.add(controller);
  explanations.delete(eventId); explanationVersions.delete(eventId);
  explanationErrors.delete(eventId);
  renderDetail(results());
  try {
    const res = await fetch('/api/world-pulse/explain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]),
    });
    if (!res.ok)
      throw new Error('AI could not complete this request. Check configuration or try again.');
    const result = (await res.json()) as PulseExplanation;
    if (epoch !== aiViewEpoch || selected?.id !== eventId || state.workspace.active !== 'reading') return;
    const event = snapshot.events.find((e) => e.id === eventId);
    if (
      !event || result.eventId !== eventId || result.retention !== 'ephemeral' ||
      !result.basis || !['headlines', 'article-excerpts'].includes(result.basis.mode) ||
      typeof result.limitation !== 'string' ||
      !Array.isArray(result.statements) ||
      !result.statements.length ||
      result.statements.some(
        (s) =>
          !['core', 'change', 'impact', 'watch'].includes(s.section) ||
          ({ core: 'fact', change: 'fact', impact: 'inference', watch: 'question' })[s.section] !== s.kind ||
          typeof s.text !== 'string' ||
          !Array.isArray(s.sourceIds) ||
          !s.sourceIds.length ||
          s.sourceIds.some((id) => !event.sources.some((source) => source.id === id)),
      )
    )
      throw new Error('AI returned unverifiable references. The response was not displayed.');
    if (eventVersion(event) !== requestedVersion)
      throw new Error(
        'This report changed while the explanation was generated. Please request a new explanation.',
      );
    explanations.set(eventId, result);
    explanationVersions.set(eventId, requestedVersion);
  } catch (error) {
    if (epoch === aiViewEpoch) explanationErrors.set(eventId, error instanceof Error ? error.message : 'AI request failed');
  } finally {
    aiViewRequests.delete(controller);
    if (epoch === aiViewEpoch) { pendingAI.delete(eventId); renderDetail(results()); }
  }
}
function openDialog(title: string, ...content: Child[]) {
  dialog?.close();
  dialog?.remove();
  dialog = el(
    'dialog',
    { class: 'pulse-dialog glass-panel glass-interactive', 'aria-label': title },
    el(
      'div',
      { class: 'dialog-heading' },
      el('h2', {}, title),
      button('×', closeDialog, 'close', { 'aria-label': 'Close dialog' }),
    ),
    ...content,
  );
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) {
      const b = dialog!.getBoundingClientRect();
      if (e.clientX < b.left || e.clientX > b.right || e.clientY < b.top || e.clientY > b.bottom)
        closeDialog();
    }
  });
  document.body.append(dialog);
  dialog.showModal();
}
function closeDialog() {
  dialog?.close();
  dialog?.remove();
  dialog = null;
}
function field(label: string, input: HTMLElement) {
  return el('label', { class: 'form-field' }, el('span', {}, label), input);
}
function companyDialog(existing?: PulseCompany) {
  let chosen: PulseCompany | undefined =
    existing?.provenance === 'catalog' ? directoryEntries.find((c) => c.id === existing.id) || existing : undefined;
  const error = el('p', { class: 'form-error', role: 'alert' });
  const list = el(
    'select',
    { 'aria-label': 'Company list' },
    el('option', { value: 'holdings' }, 'Holdings'),
    el('option', { value: 'watchlist' }, 'Watchlist'),
  );
  list.value = existing?.list || current().list;
  const aliasInput = el('input', {
    maxlength: 2000,
    value: existing?.aliases?.join(', ') || '',
    placeholder: 'Extra names reporters use, comma-separated',
    'aria-label': 'Your aliases',
  });
  const shares = el('input', {
    type: 'number', min: '0', step: 'any', inputmode: 'decimal',
    value: existing?.position ? String(existing.position.shares) : '',
    placeholder: 'e.g. 120', 'aria-label': 'Shares',
  });
  const cost = el('input', {
    type: 'number', min: '0', step: 'any', inputmode: 'decimal',
    value: existing?.position ? String(existing.position.cost) : '',
    placeholder: 'e.g. 118.25', 'aria-label': 'Average cost per share (USD)',
  });
  // Manual identity, for listings the directory does not know.
  const symbol = el('input', { maxlength: 15, value: existing?.provenance === 'user' ? existing.symbol : '', placeholder: 'e.g. NVDA', 'aria-label': 'Stock symbol' });
  const name = el('input', { maxlength: 250, value: existing?.provenance === 'user' ? existing.name : '', placeholder: 'Company name', 'aria-label': 'Company name' });
  const exchange = el(
    'select',
    { 'aria-label': 'Exchange' },
    ...Array.from(new Set(['NASDAQ', 'NYSE', 'NYSE American', 'Other US', existing?.exchange || '']))
      .filter(Boolean)
      .map((x) => el('option', { value: x }, x)),
  );
  exchange.value = existing?.exchange || 'NASDAQ';
  const manual = el(
    'details',
    { class: 'manual-identity', ...(existing?.provenance === 'user' ? { open: true } : {}) },
    el('summary', {}, 'Advanced · enter a listing manually'),
    el('p', { class: 'micro' }, 'Manual identities match only your aliases and ticker tags ($TICKER, NASDAQ:TICKER).'),
    el('div', { class: 'control-row' }, field('SYMBOL', symbol), field('EXCHANGE', exchange)),
    field('COMPANY NAME', name),
  );
  const selectedBox = el('div', { class: 'selected-identity' });
  const preview = el('p', { class: 'micro', role: 'status' });
  const candidate = (): PulseCompany | undefined => {
    const aliases = [...new Set(aliasInput.value.split(/[,，\n]/).map((a) => a.trim()).filter(Boolean))];
    const base: PulseCompany | undefined = chosen
      ? { ...chosen, list: list.value as PulseCompany['list'], provenance: 'catalog' }
      : symbol.value.trim() && name.value.trim()
        ? {
            id: existing?.provenance === 'user' ? existing.id : 'manual:' + symbol.value.trim().toUpperCase(),
            symbol: symbol.value.trim().toUpperCase(),
            name: name.value.trim(),
            exchange: exchange.value,
            list: list.value as PulseCompany['list'],
            provenance: 'user',
          }
        : undefined;
    if (!base) return undefined;
    delete base.aliases;
    delete base.aliasProvenance;
    return aliases.length ? { ...base, aliases, aliasProvenance: 'user' } : base;
  };
  const updatePreview = () => {
    const c = candidate();
    if (!c) {
      selectedBox.replaceChildren(el('p', { class: 'muted' }, 'Choose a result above, or enter a listing manually.'));
      preview.textContent = '';
      return;
    }
    const names = matchingNames(c);
    selectedBox.replaceChildren(
      el('div', { class: 'section-head' },
        el('strong', {}, `${c.symbol} · ${c.exchange}`),
        el('span', { class: 'micro' }, c.provenance === 'catalog' ? (c.cik ? 'SEC-verified identity' : 'Reviewed starter identity') : 'Manual identity · not verified')),
      el('p', { class: 'muted' }, prettyName(c.name)),
      el('div', { class: 'name-chips' },
        ...names.auto.map((n) => el('span', { class: 'name-chip' }, n)),
        ...names.contextual.map((n) => el('span', { class: 'name-chip contextual', title: 'Needs a company word nearby' }, n)),
        ...names.user.map((n) => el('span', { class: 'name-chip user' }, n)),
        el('span', { class: 'name-chip ticker' }, '$' + c.symbol)),
    );
    const week = Date.now() - 7 * 86_400_000;
    const hits = snapshot.events.filter((event) => {
      const time = Date.parse(event.publishedAt || event.firstSeenAt || '');
      return time > week && matchCompanies(event, [c]).length > 0;
    }).length;
    preview.textContent = `${hits} ${hits === 1 ? 'story' : 'stories'} in the last 7 days would match these names.`;
  };
  const results = el('div', { class: 'search-results', role: 'listbox', 'aria-label': 'Company search results' });
  const status = el('p', { class: 'micro', role: 'status' }, existing ? '' : 'Search by name, brand or ticker. US listings.');
  let sequence = 0;
  let timer: ReturnType<typeof setTimeout>;
  const renderResults = (companies: PulseCompany[]) =>
    results.replaceChildren(
      ...companies.slice(0, 8).map((c) =>
        el('button', {
          type: 'button',
          role: 'option',
          class: 'search-result' + (chosen?.id === c.id ? ' active' : ''),
          'aria-selected': String(chosen?.id === c.id),
          onclick: () => {
            chosen = c;
            symbol.value = '';
            name.value = '';
            renderResults(companies);
            updatePreview();
            shares.focus();
          },
        },
          el('span', {}, displayName(c), el('small', {}, prettyName(c.name))),
          el('span', { class: 'mono' }, `${c.symbol} · ${c.exchange}`),
          state.companies.some((x) => x.id === c.id) ? el('span', { class: 'micro' }, 'In your lists') : null),
      ),
    );
  const query = el('input', {
    type: 'search',
    placeholder: 'e.g. tsmc, nvidia, MSFT',
    'aria-label': 'Search companies',
    autocomplete: 'off',
    oninput: () => {
      clearTimeout(timer);
      const current = ++sequence;
      const q = query.value.trim();
      if (!q) {
        results.replaceChildren();
        status.textContent = 'Search by name, brand or ticker. US listings.';
        return;
      }
      timer = setTimeout(async () => {
        status.textContent = 'Searching…';
        try {
          const response = await fetch('/api/world-pulse/companies?q=' + encodeURIComponent(q), { signal: AbortSignal.timeout(20000) });
          if (!response.ok) throw new Error('Directory unavailable');
          const data = (await response.json()) as PulseDirectory;
          if (current !== sequence) return;
          if (!Array.isArray(data.companies)) throw new Error('Invalid directory');
          directoryEntries = [...new Map([...directoryEntries, ...data.companies].map((c) => [c.id, c])).values()];
          renderResults(data.companies);
          status.textContent = data.companies.length
            ? `${Math.min(8, data.companies.length)} of ${data.companies.length} results · SEC identities${data.state === 'fresh' ? '' : ' (cached)'}`
            : 'No US listing found. Try the ticker, or enter it manually below.';
        } catch {
          if (current === sequence) status.textContent = 'Search unavailable. You can still enter a listing manually.';
        }
      }, 300);
    },
  });
  for (const input of [symbol, name, exchange])
    input.addEventListener('input', () => {
      if (symbol.value.trim() || name.value.trim()) chosen = undefined;
      updatePreview();
    });
  aliasInput.addEventListener('input', updatePreview);
  list.addEventListener('change', updatePreview);
  updatePreview();
  const form = el(
    'form',
    {
      onsubmit: (event: Event) => {
        event.preventDefault();
        const entry = candidate();
        if (!entry) {
          error.textContent = 'Choose a company from the results, or enter a symbol and name.';
          return;
        }
        if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(entry.symbol)) {
          error.textContent = 'Enter a valid US ticker.';
          return;
        }
        if ((entry.aliases?.length ?? 0) > 20 || entry.aliases?.some((a) => a.length > 100)) {
          error.textContent = 'Use at most 20 aliases, each under 100 characters.';
          return;
        }
        const sharesValue = shares.value.trim() ? Number(shares.value) : undefined;
        const costValue = cost.value.trim() ? Number(cost.value) : undefined;
        if ((sharesValue === undefined) !== (costValue === undefined) ||
          (sharesValue !== undefined && (!Number.isFinite(sharesValue) || sharesValue < 0 || !Number.isFinite(costValue!) || costValue! < 0))) {
          error.textContent = 'Enter both shares and average cost, or leave both empty.';
          return;
        }
        if (state.companies.some((c) => c.id !== existing?.id && (c.id === entry.id || (c.symbol === entry.symbol && c.exchange === entry.exchange)))) {
          error.textContent = 'This company is already in your lists. Edit that entry instead.';
          return;
        }
        const next: PulseCompany = {
          ...entry,
          ...(sharesValue !== undefined && sharesValue > 0 ? { position: { shares: sharesValue, cost: costValue! } } : {}),
          ...(existing?.links?.length ? { links: existing.links } : {}),
        };
        if (!next.position) delete next.position;
        if (existing) state.companies = state.companies.map((c) => (c.id === existing.id ? next : c));
        else state.companies.push(next);
        current().list = next.list;
        current().selectedCompany = next.id;
        persist();
        closeDialog();
        render();
        toast(`${next.symbol} saved to ${next.list}.`);
        void fetchCompanyData();
        refreshPortfolioData(true);
      },
    },
    existing
      ? null
      : el('div', { class: 'company-search' }, field('FIND A COMPANY', query), status, results),
    existing && existing.provenance === 'catalog'
      ? el('p', { class: 'muted' }, `${existing.name} · ${existing.exchange}`)
      : null,
    selectedBox,
    el('div', { class: 'control-row' }, field('LIST', list)),
    el('div', { class: 'control-row' }, field('SHARES · OPTIONAL', shares), field('AVG COST (USD)', cost)),
    field('YOUR ALIASES · OPTIONAL', aliasInput),
    preview,
    existing?.provenance === 'catalog' ? null : manual,
    error,
    el(
      'div',
      { class: 'dialog-actions' },
      existing
        ? button(
            'Remove company',
            () => {
              openDialog(
                'Remove ' + existing.symbol + '?',
                el('p', {}, 'This removes the company, its position and links from this browser.'),
                button('Remove', () => {
                  state.companies = state.companies.filter((c) => c.id !== existing.id);
                  if (current().selectedCompany === existing.id) current().selectedCompany = '';
                  persist();
                  closeDialog();
                  render();
                }, 'danger'),
                button('Cancel', () => companyDialog(existing), 'quiet'),
              );
            },
            'danger quiet',
          )
        : null,
      el('button', { type: 'submit', class: 'primary' }, existing ? 'Save changes' : 'Add company'),
    ),
  );
  openDialog(existing ? `Edit ${existing.symbol}` : 'Add company', form);
  if (!existing) query.focus();
}
function saveSearch() {
  const name = el('input', {
    required: true,
    maxlength: 60,
    placeholder: 'e.g. Technology in East Asia',
    'aria-label': 'Search name',
  });
  openDialog(
    'Save this search',
    el(
      'p',
      { class: 'muted' },
      'Saves your filters in this browser. No background monitoring is created.',
    ),
    el(
      'form',
      {
        onsubmit: (e: Event) => {
          e.preventDefault();
          if (!name.value.trim()) return;
          state.savedSearches.push({
            id: crypto.randomUUID(),
            name: name.value.trim(),
            state: structuredClone(current()),
          });
          persist();
          closeDialog();
          render();
          toast('Search saved.');
        },
      },
      field('NAME', name),
      el('button', { class: 'primary', type: 'submit' }, 'Save search'),
    ),
  );
}
function manageSearches() {
  openDialog(
    'Saved searches',
    state.savedSearches.length
      ? el(
          'div',
          {},
          ...state.savedSearches.map((s) =>
            el(
              'div',
              { class: 'saved-row' },
              el('span', {}, s.name),
              button(
                'Delete',
                () => {
                  state.savedSearches = state.savedSearches.filter((x) => x.id !== s.id);
                  persist();
                  render();
                  manageSearches();
                },
                'small quiet',
              ),
            ),
          ),
        )
      : el('p', { class: 'muted' }, 'No saved searches yet.'),
  );
}
function downloadConfiguration() {
  const content = exportConfiguration(state);
  if (!content) {
    toast('Configuration could not be exported.');
    return;
  }
  const href = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
  const anchor = el('a', {
    href,
    download: `world-pulse-config-${new Date().toISOString().slice(0, 10)}.json`,
  });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(href);
  toast('Local configuration exported.');
}
function chooseConfigurationImport() {
  const input = el('input', { type: 'file', accept: 'application/json,.json' });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file || file.size > 1_000_000) {
      toast('Choose a World Pulse configuration file under 1 MB.');
      return;
    }
    const imported = importConfiguration(await file.text());
    if (!imported) {
      toast('This file is not a valid World Pulse configuration.');
      return;
    }
    state = imported;
    applyOutletPreferences(state);
    persist();
    closeDialog();
    updateHeader();
    render();
    void fetchCompanyData();
    refreshPortfolioData(true);
    switchWorkspace(state.workspace.active,true);
    toast('Configuration imported.');
  });
  input.click();
}
function settings(tab: 'appearance' | 'sources' | 'ai' | 'local' = 'appearance') {
  const ai = snapshot.aiControl ?? {
    enabled: snapshot.aiConfigured,
    configured: snapshot.aiConfigured,
    effective: snapshot.aiConfigured,
    inFlight: 0,
  };
  const tabs = el(
    'div',
    { class: 'segmented settings-tabs' },
    ...(['appearance', 'sources', 'ai', 'local'] as const).map((t) =>
      button(
        t === 'ai'
          ? 'AI configuration'
          : t === 'sources'
            ? 'Data sources'
            : t === 'local'
              ? 'Local workspace'
              : 'Appearance',
        () => settings(t),
        t === tab ? 'active' : '',
      ),
    ),
  );
  let content: HTMLElement;
  if (tab === 'appearance')
    content = el(
      'div',
      {},
      el('p', { class: 'muted' }, 'Reading uses a daylight palette. Command uses a tactical green palette. Switch workspaces from the top navigation.'),
      el(
        'div',
        { class: 'appearance-options' },
        ...(['reading', 'command'] as const).map((theme) =>
          button(
            theme === 'reading' ? '◉ Daylight Reading' : '◉ Tactical Command',
            () => {
              switchWorkspace(theme);
              persist();
              updateHeader();
              settings();
            },
            state.workspace.active === theme ? 'active' : '',
          ),
        ),
      ),
      el(
        'p',
        { class: 'micro' },
        'English interface · headlines stay in their original language · AI analysis in English · respects reduced motion',
      ),
    );
  else if (tab === 'ai') {
    const configForm = el(
      'form',
      { id: 'ai-provider-form', class: 'ai-config-form' },
      el('h3', {}, 'OpenAI-compatible Chat Completions'),
      el(
        'p',
        { class: 'micro' },
        'Enter the complete endpoint URL and model name. No provider or model is selected by default.',
      ),
      el(
        'label',
        { class: 'ai-config-field' },
        el('span', {}, 'Chat Completions URL'),
        el('input', {
          name: 'apiUrl',
          type: 'url',
          inputmode: 'url',
          placeholder: 'https://provider.example/v1/chat/completions',
          maxlength: 2048,
          autocomplete: 'url',
        }),
      ),
      el(
        'label',
        { class: 'ai-config-field' },
        el('span', {}, 'Model'),
        el('input', {
          name: 'model',
          type: 'text',
          maxlength: 200,
          placeholder: 'Your provider model name',
          autocomplete: 'off',
        }),
      ),
      el(
        'label',
        { class: 'ai-config-field' },
        el('span', {}, 'API key · ', el('span', { id: 'ai-key-state' }, 'Loading…')),
        el('input', {
          name: 'apiKey',
          type: 'password',
          autocomplete: 'new-password',
          autocapitalize: 'none',
          spellcheck: false,
          maxlength: 4096,
          placeholder: 'Leave blank to keep the saved key',
        }),
      ),
      el('p', { class: 'micro' }, 'The key is written to this computer’s ignored .env.local file. It is never returned to this page.'),
      el(
        'div',
        { class: 'ai-price-grid' },
        el(
          'label',
          { class: 'ai-config-field' },
          el('span', {}, 'Input price · RMB per 1M tokens'),
          el('input', {
            name: 'inputPricePerMillion',
            type: 'number',
            min: 0,
            max: 100000,
            step: 'any',
            placeholder: 'Required for automatic filtering',
            inputmode: 'decimal',
          }),
        ),
        el(
          'label',
          { class: 'ai-config-field' },
          el('span', {}, 'Output price · RMB per 1M tokens'),
          el('input', {
            name: 'outputPricePerMillion',
            type: 'number',
            min: 0,
            max: 100000,
            step: 'any',
            placeholder: 'Required for automatic filtering',
            inputmode: 'decimal',
          }),
        ),
      ),
      el(
        'div',
        { class: 'control-row' },
        el('button', { type: 'submit', class: 'primary' }, 'Save on this computer'),
        button('Clear saved API key', () => void clearSavedAIKey(), 'small danger', {
          id: 'ai-clear-key',
          disabled: !localAIConfig?.keyConfigured,
        }),
      ),
      el('p', { id: 'ai-config-status', role: 'status', class: 'micro' }, 'Loading local configuration…'),
    );
    configForm.addEventListener('submit', (event) => {
      event.preventDefault();
      void saveAIConfiguration();
    });
    content = el(
      'div',
      {},
      el(
        'section',
        { class: 'ai-master-panel glass-controls' },
        el(
          'div',
          { class: 'section-head' },
          el('div', {}, el('h3', {}, 'AI master switch'), el('p', { class: 'micro' }, 'Local safety control')),
          button(
            ai.enabled ? 'AI On' : 'AI Off',
            () => void changeAIEnabled(!ai.enabled, true),
            ai.effective ? 'active ai-switch' : 'ai-switch',
            { role: 'switch', 'aria-checked': String(ai.enabled) },
          ),
        ),
        el(
          'p',
          { class: ai.enabled ? 'muted' : 'notice' },
          ai.enabled
            ? ai.effective
              ? 'Provider access is enabled. Automatic and on-demand AI may make requests.'
              : 'AI is enabled, but a local endpoint, model, and API key are not configured.'
            : 'AI requests are blocked by this local safety switch.',
        ),
      ),
      configForm,
      el('p', { id: 'ai-connection-status', role: 'status', class: 'micro' },
        snapshot.diagnostics?.ai
          ? `${snapshot.diagnostics.ai.state}: ${snapshot.diagnostics.ai.message}${snapshot.diagnostics.ai.testedAt ? ` · tested ${date(snapshot.diagnostics.ai.testedAt)}` : ''}`
          : 'Connection has not been tested. Testing sends one small request and may incur provider usage.'),
      ai.enabled
        ? button('Test provider connection', () => void testAIConnection(), 'primary', {
            disabled: !ai.configured,
          })
        : null,
      el(
        'p',
        { class: 'notice' },
        'The provider you choose receives public report content when you request AI analysis. Automatic filtering sends titles only. Company lists and holdings are not sent. AI responses are temporary and are not saved.',
      ),
      el(
        'section',
        { class: 'filter-settings glass-controls' },
        el('h3', {}, 'Conservative headline filtering'),
        el(
          'p',
          {},
          snapshot.filtering
            ? snapshot.filtering.pricingConfigured
              ? `Automatic: ${snapshot.filtering.enabled ? 'on' : 'off'} · ¥${snapshot.filtering.spentRmb.toFixed(4)} / ¥${snapshot.filtering.budgetRmb.toFixed(2)} this month · ${snapshot.filtering.pending} pending`
              : 'Automatic filtering is paused until both token prices are configured. Headlines remain visible.'
            : 'Filtering status unavailable.',
        ),
        el(
          'p',
          { class: 'micro' },
          'Titles only. Uncertain items remain visible. The ¥2 monthly cap uses conservative reservations when usage is unavailable. At the limit, new items remain unassessed. News and classification records expire after 168 hours; generated analysis is not saved.',
        ),
        el(
          'p',
          { class: 'micro' },
          snapshot.filtering?.pilotReviewed
            ? 'Initial review completed.'
            : `Initial safety review: ${snapshot.filtering?.pilotProcessed || 0}/100 titles. Expansion waits for review.`,
        ),
        button(
          snapshot.filtering?.enabled ? 'Pause automatic filtering' : 'Enable automatic filtering',
          () => void changeFiltering({ enabled: !snapshot.filtering?.enabled }),
          'small',
          { disabled: !ai.enabled || !snapshot.filtering?.pricingConfigured },
        ),
        el(
          'p',
          { class: 'micro' },
          `On-demand AI: ¥${(snapshot.manualAI?.spentRmb || 0).toFixed(4)} in estimated known costs · ${snapshot.manualAI?.unknownCalls || 0} request(s) with unknown cost this month. Manual analysis can run without prices; costs will be marked unknown.`,
        ),
      ),
      el(
        'p',
        { class: 'micro' },
        'Only the local service calls the configured API. It binds to the loopback interface and rejects cross-origin requests. The app does not provide a shared hosted AI service.',
      ),
    );
    void loadAIConfiguration();
  }
  else if (tab === 'sources')
    content = el(
      'div',
      {},
      connectionError ? el('p', { class: 'notice' }, connectionError) : null,
      el(
        'article',
        { class: 'source-health glass-controls' },
        el(
          'div',
          { class: 'section-head' },
          link('Portfolio market data ↗', 'https://finnhub.io/docs/api'),
          el('span', { class: 'health-' + marketHealth().state }, marketHealth().state.toUpperCase()),
        ),
        el('p', { class: 'micro' }, market ? `${sessionLabel()} · ${marketHealth().detail}` : 'Opens with Portfolio.'),
        el('p', { class: 'micro' }, market ? `${market.usage.callsLastMinute}/${market.usage.limit} Finnhub calls in the last minute${market.providers?.tiingo.configured ? ` · Tiingo ${market.providers.tiingo.callsLastHour}/${market.providers.tiingo.hourlyLimit} this hour` : ''}` : 'Quotes refresh every minute while Portfolio is open and every 5 minutes in the background during US trading sessions.'),
        el('p', { class: 'micro' }, 'Profiles, peers and earnings dates are cached for a day. No historical candles are requested.'),
        marketError ? el('p', { class: 'notice' }, marketError) : null,
      ),
      ...snapshot.sources.map((s) =>
        el(
          'article',
          { class: 'source-health glass-controls' },
          el(
            'div',
            { class: 'section-head' },
            link(s.name + ' ↗', s.url),
            el(
              'span',
              { class: 'health-' + s.state },
              `${s.coverageGroup ? s.coverageGroup.toUpperCase() + ' · ' : ''}${s.state.toUpperCase()}`,
            ),
          ),
          el('p', { class: 'micro' }, `Last success: ${date(s.lastSuccess)}`),
          el(
            'p',
            { class: 'micro' },
            `Last attempt: ${date(s.lastAttempt)} · Next: ${date(s.nextRefresh)}`,
          ),
          el(
            'p',
            { class: 'micro' },
            `Interval: ${s.intervalMs ? Math.round(s.intervalMs / 60000) + ' min' : 'unknown'} · Consecutive failures: ${s.consecutiveFailures ?? 0} · Last latency: ${s.latencyMs === undefined ? 'unknown' : s.latencyMs + ' ms'}`,
          ),
          el(
            'div',
            { class: 'source-records' },
            s.id === 'sec-directory'
              ? link(`${s.count} company identities · SEC dataset ↗`, s.url, 'small')
              : button(
                  `${retainedSourceReports(s.id).length} retained reports ↗`,
                  () => sourceRecords(s.id),
                  'small quiet',
                ),
            el('span', { class: 'micro' }, `Latest fetch: ${s.count} records`),
            el('span', { class: 'micro' }, `${s.rejected} rejected`),
          ),
          s.error ? el('p', { class: 'notice' }, s.error) : null,
          s.coverage ? el('p', { class: 'micro' }, s.coverage) : null,
          s.truncated
            ? el('p', { class: 'notice' }, 'Source result limit reached; coverage is truncated.')
            : null,
        ),
      ),
      !snapshot.sources.length
        ? el('p', {}, 'Waiting for local service. Retry refresh to inspect source status.')
        : null,
      el(
        'p',
        { class: 'micro' },
        'Counts describe fetched records, not global completeness. Refresh does not bypass source backoff.',
      ),
    );
  else {
    const diagnostics = snapshot.diagnostics;
    const counts = diagnostics?.sourceCounts;
    content = el(
      'div',
      {},
      el('h3', {}, 'Local diagnostics'),
      el(
        'dl',
        { class: 'fact-grid' },
        el('dt', {}, 'Service'),
        el('dd', {}, diagnostics?.serviceRunning ? 'Running' : 'Unavailable'),
        el('dt', {}, 'Local database'),
        el(
          'dd',
          {},
          diagnostics?.databaseWritable && diagnostics.databaseIntegrity === 'ok'
            ? 'Writable · integrity OK'
            : 'Needs attention',
        ),
        el('dt', {}, 'Last successful collection'),
        el('dd', {}, date(diagnostics?.lastSuccessfulFetch)),
        el('dt', {}, 'Source health'),
        el(
          'dd',
          {},
          counts
            ? `${counts.fresh} fresh · ${counts.stale} stale · ${counts.error} error · ${counts.loading} loading`
            : 'Unavailable',
        ),
        el('dt', {}, 'Seven-day coverage'),
        el(
          'dd',
          {},
          diagnostics?.coverageSince
            ? `${date(diagnostics.coverageSince)} — now`
            : 'No retained reports yet',
        ),
        el('dt', {}, 'AI provider'),
        el(
          'dd',
          {},
          diagnostics?.ai
            ? `${diagnostics.ai.state} · ¥${diagnostics.ai.usage.spentRmb.toFixed(4)} recorded this month`
            : ai.configured
              ? 'Configured · status unavailable'
              : 'Not configured',
        ),
      ),
      el(
        'p',
        { class: 'micro' },
        'The service collects only while this terminal process is running. Closing the browser does not stop it; Mac sleep or shutdown pauses collection, and overdue sources resume after wake or restart.',
      ),
      el('h3', {}, 'Configuration backup'),
      el(
        'p',
        { class: 'muted' },
        'Exports holdings and watchlist (including shares, cost and links you entered), saved searches, publisher lists and settings. News, API keys and AI caches are excluded.',
      ),
      el(
        'div',
        { class: 'control-row' },
        button('Export configuration', downloadConfiguration, 'primary'),
        button('Import configuration', chooseConfigurationImport, 'small'),
      ),
      el('h3', {}, 'Publishers you blocked or trust'),
      (() => {
        const prefs = outletPreferences();
        const rows = [
          ...prefs.blocked.map((key) => ['blocked', key] as const),
          ...prefs.trusted.map((key) => ['trusted', key] as const),
        ];
        return rows.length
          ? el(
              'div',
              {},
              ...rows.map(([kind, key]) =>
                el(
                  'div',
                  { class: 'saved-row' },
                  el('span', {}, `${kind === 'blocked' ? 'Blocked' : 'Trusted'} · ${key}`),
                  button('Remove', () => {
                    setOutletList(key, 'none');
                    settings('local');
                  }, 'small quiet'),
                ),
              ),
            )
          : el('p', { class: 'muted' }, 'None yet. Use Block or Trust in an event’s source list.');
      })(),
      el('p', { class: 'micro' }, 'Included in the configuration backup. Blocked publishers are hidden everywhere and never count toward heat.'),
    );
  }
  openDialog('Workspace settings', tabs, content);
}
function retainedSourceReports(sourceId: string) {
  const reports = snapshot.events
    .flatMap((event) =>
      event.reports?.length
        ? event.reports
        : event.sources.map((source) => ({
            title: event.title,
            source,
            publishedAt: event.publishedAt,
            firstSeenAt: event.fetchedAt,
          })),
    )
    .filter((report) => (report.source.feedId || report.source.id) === sourceId);
  return [...new Map(reports.map((report) => [report.source.url, report])).values()];
}
function sourceRecords(sourceId: string) {
  const source = snapshot.sources.find((s) => s.id === sourceId);
  const records = retainedSourceReports(sourceId);
  openDialog(
    (source?.name || sourceId) + ' · retained reports',
    el(
      'p',
      { class: 'notice' },
      `${records.length} retained distinct report URLs, across the local seven-day cache and outside current mode filters. Latest fetch supplied ${source?.count || 0} records; older fetch records may have expired. Feeds are not a complete archive.`,
    ),
    ...records.map((report) =>
      el(
        'article',
        { class: 'source-health' },
        link(report.title, report.source.url),
        el(
          'p',
          { class: 'micro' },
          report.publishedAt ? date(report.publishedAt) : 'Discovered ' + date(report.firstSeenAt),
        ),
      ),
    ),
    !records.length
      ? el('p', { class: 'muted' }, 'No retained reports available for this source.')
      : null,
    button('Back to source status', () => settings('sources'), 'small'),
  );
}
/** Great-circle distance in km — used to attribute reports to a city point. */
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const rad = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}
/**
 * Reports attributed to a city. Only `exact`-precision locations count:
 * country- and region-level coordinates are approximate centroids, and
 * attaching them to a city would misstate where a report happened.
 */
function eventsForCity(city: CityPoint) {
  const CITY_RADIUS_KM = 50;
  return snapshot.events
    .filter((e) => e.location?.precision === 'exact')
    .map((e) => ({
      event: e,
      km: haversineKm(e.location!.lat, e.location!.lon, city.lat, city.lng),
    }))
    .filter((m) => m.km <= CITY_RADIUS_KM)
    .sort(
      (a, b) => (b.event.publishedAt || '').localeCompare(a.event.publishedAt || '') || a.km - b.km,
    );
}
let cityPanel: HTMLElement | null = null;
let cityPanelEsc: ((e: KeyboardEvent) => void) | null = null;
function closeCityPanel() {
  if (!cityPanel) return;
  if (cityPanelEsc) document.removeEventListener('keydown', cityPanelEsc);
  cityPanelEsc = null;
  const panel = cityPanel;
  cityPanel = null;
  panel.classList.add('closing');
  setTimeout(() => panel.remove(), 190);
}
function cityDialog(city: CityPoint) {
  closeCityPanel();
  const matches = eventsForCity(city);
  const panel = el(
    'div',
    { class: 'city-panel glass', role: 'dialog', 'aria-label': `${city.name} reports` },
    el(
      'div',
      { class: 'dialog-heading' },
      el('h2', {}, city.name),
      button('×', closeCityPanel, 'close', { 'aria-label': 'Close city panel' }),
    ),
    link(
      'City dataset · Natural Earth ↗',
      'https://www.naturalearthdata.com/downloads/10m-cultural-vectors/10m-populated-places/',
    ),
    el(
      'p',
      { class: 'muted' },
      `${city.country}${city.capital ? ' · capital' : ''} · reference map location`,
    ),
    el(
      'p',
      { class: 'micro' },
      `Reports with exact-precision locations within 50 km of the city point. Country-level records are not attributed to cities. · ${matches.length} report${matches.length === 1 ? '' : 's'} in coverage`,
    ),
    ...matches.map(({ event, km }) =>
      el(
        'article',
        { class: 'source-health' },
        el(
          'div',
          { class: 'section-head' },
          el('span', {
            class: 'category-dot cat-' + event.category.toLowerCase(),
          }),
          button(
            event.title,
            () => {
              closeCityPanel();
              setEvent(event);
            },
            'event-title',
          ),
        ),
        el(
          'p',
          { class: 'micro' },
          `${event.category} · ${ago(event.publishedAt)} · ${km < 1 ? '<1' : Math.round(km)} km from city point`,
        ),
      ),
    ),
    !matches.length
      ? el(
          'p',
          { class: 'muted' },
          'No exact-precision reports near this city in the current coverage window. Try a wider time range.',
        )
      : null,
    el(
      'div',
      { class: 'dialog-actions' },
      button(
        'Center map on city',
        () => {
          map?.focusCity(city.lng, city.lat);
        },
        'small',
      ),
      button('Close', closeCityPanel, 'small quiet'),
    ),
  );
  cityPanel = panel;
  mapEl.append(panel);
  cityPanelEsc = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeCityPanel();
  };
  document.addEventListener('keydown', cityPanelEsc);
  panel.querySelector<HTMLButtonElement>('button[aria-label="Close city panel"]')?.focus();
}
function layerDialog() {
  const check = (label: string, checked: boolean, set: (value: boolean) => void) => {
    const input = el('input', { type: 'checkbox' });
    input.checked = checked;
    input.addEventListener('change', () => {
      set(input.checked);
      map?.layers(newsLayer, contextLayer);
      map?.cities(cityLayer);
    });
    return el('label', { class: 'check-row' }, input, label);
  };
  openDialog(
    'Map layers',
    check('Event markers', newsLayer, (v) => (newsLayer = v)),
    check('World context in Portfolio', contextLayer, (v) => (contextLayer = v)),
    check('Cities: Auto / Off', cityLayer, (v) => (cityLayer = v)),
    el(
      'p',
      { class: 'micro' },
      'Layers change map visibility only. Event results remain searchable.',
    ),
  );
}
function legendDialog() {
  openDialog(
    'Map legend',
    ...categories.map((c) =>
      el(
        'div',
        { class: 'legend-row' },
        el('span', { class: 'category-dot cat-' + c.toLowerCase() }),
        c,
      ),
    ),
    el('p', {}, 'Larger circles group nearby events. Click to expand.'),
    el(
      'p',
      {},
      'City dots mark major world cities (Natural Earth). Click a city for reports attributed to it; only exact-precision locations within 50 km are included.',
    ),
    el(
      'p',
      {},
      'A bright outer ring marks the selected event. Country and region locations are approximate, not incident coordinates.',
    ),
    el(
      'p',
      { class: 'micro' },
      'Disasters use an amber category marker. Magnitude and source facts are shown in details; color alone is not a severity rating.',
    ),
  );
}
updateHeader();
render();
try {
  map = new PulseMap(mapEl, current().camera, {
    event: (id) => {
      const event = snapshot.events.find((e) => e.id === id);
      if (event) setEvent(event);
    },
    country: (code, name) => {
      if (code && code !== '-99') {
        const c = current();
        const previous = [...c.regions];
        c.regions = mode === 'explore' ? toggle(c.regions, code) : [code];
        persist();
        render();
        toast(
          mode === 'explore'
            ? `Region filter: ${name}`
            : `Region filter: ${name} (replaced previous)`,
          {
            label: 'Undo',
            run: () => {
              c.regions = previous;
              persist();
              render();
            },
          },
        );
      }
    },
    city: (city) => cityDialog(city),
    camera: (camera) => {
      current().camera = camera;
      coordinates.textContent = `${camera.lat.toFixed(1)}° N  /  ${camera.lng.toFixed(1)}° E  ·  Z${camera.zoom.toFixed(1)}`;
      persist();
    },
    status: (text) => {
      mapMeta.textContent = text.toUpperCase();
    },
  });
} catch {
  mapMeta.textContent = 'WEBGL UNAVAILABLE · EVENT LIST ACTIVE';
  mapEl.append(
    el(
      'p',
      { class: 'map-fallback' },
      'Map rendering is unavailable in this browser. You can still explore all events in the list.',
    ),
  );
}
if(location.pathname==='/command')switchWorkspace('command',true);
else if(location.pathname==='/' && state.workspace.active==='command')switchWorkspace('command',true);
else {state.workspace.active='reading';state.workspace.lastReading=mode;applyWorkspace();}
if (initial.recovered)
  toast('Some saved data was invalid. Defaults restored; review your local lists.');
function pruneClientNews() {
  const cutoff = Date.now() - 168 * 3600000;
  const expired = (e: PulseEvent) => {
    const dates = e.reports?.map((r) => r.publishedAt || r.firstSeenAt) || [
      e.publishedAt || e.fetchedAt,
    ];
    return dates.every((d) => !Number.isFinite(Date.parse(d)) || Date.parse(d) <= cutoff);
  };
  snapshot.events = snapshot.events.filter((e) => !expired(e));
  for (const m of ['world', 'portfolio', 'explore'] as const) {
    if (selectedByMode[m] && expired(selectedByMode[m]!)) selectedByMode[m] = undefined;
  }
  if (selected && expired(selected)) {
    clearTransientAI();
    selected = null;
    toast('This event expired after 168 hours.');
  }
  for (const id of explanations.keys())
    if (!snapshot.events.some((e) => e.id === id)) {
      explanations.delete(id);
      explanationVersions.delete(id);
    }
}
void fetchData();
refreshPortfolioData();
setInterval(() => {
  pruneClientNews();
  if (!document.hidden) {
    render();
    void fetchData();
  }
}, 60000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshPortfolioData();
});
document.documentElement.dataset.wmEventHandlersReady = 'true';
