import type {
  PulseCategory,
  PulseCompany,
  PulseCoverage,
  PulseEvent,
  PulseMatch,
  PulseMode,
  PulseSort,
} from '../../../shared/world-pulse.ts';
import {
  directCompanyMatch,
  rankEvents,
  observedEventTime,
} from '../../../shared/world-pulse-insights.ts';
import { defaultWorkspace, validWorkspace, type WorkspaceState } from './workspace';
import stocks from '../../../shared/stocks.json' with { type: 'json' };
import {
  eventQuality,
  setOutletPreferences,
  type OutletPreferences,
} from '../../../shared/world-pulse-quality.ts';

export interface ModeState {
  showFiltered?: boolean;
  /** Show events whose every report is low-quality copy. */
  showLowQuality?: boolean;
  sort: PulseSort;
  query: string;
  hours: number;
  categories: PulseCategory[];
  regions: string[];
  sourceIds: string[];
  bounds?: [number, number, number, number];
  camera: { lng: number; lat: number; zoom: number };
  selectedCompany: string;
  list: 'holdings' | 'watchlist';
  coverage: PulseCoverage;
}
export interface AppState {
  version: 3;
  workspace: WorkspaceState;
  modes: Record<PulseMode, ModeState>;
  companies: PulseCompany[];
  savedSearches: { id: string; name: string; state: ModeState }[];
  appearance: 'graphite' | 'midnight';
  /** Outlet keys the viewer blocked or trusts; see shared/world-pulse-quality. */
  outlets?: OutletPreferences;
}

export const STORAGE_KEY = 'world-pulse-state-v1';
const categories: PulseCategory[] = ['World', 'Economy', 'Technology', 'Disasters'];
const ambiguousNames = new Set(['apple', 'amazon', 'oracle', 'meta', 'alphabet', 'visa', 'itc']);
const seedCiks: Record<string, string> = {
  NVDA: '1045810',
  AAPL: '320193',
  MSFT: '789019',
  AMZN: '1018724',
  META: '1326801',
  TSLA: '1318605',
  MRVL: '1835632',
  COHR: '820318',
  ASTS: '1780312',
  IONQ: '1824920',
  GOOGL: '1652044',
  ORCL: '1341439',
  V: '1403161',
};
const identityRows = [
  ['NVDA', 'NVIDIA Corporation', 'NASDAQ', 'https://investor.nvidia.com/'],
  ['AAPL', 'Apple Inc.', 'NASDAQ', 'https://investor.apple.com/'],
  ['MSFT', 'Microsoft Corporation', 'NASDAQ', 'https://www.microsoft.com/en-us/Investor/'],
  ['AMZN', 'Amazon.com, Inc.', 'NASDAQ', 'https://ir.aboutamazon.com/'],
  ['META', 'Meta Platforms, Inc.', 'NASDAQ', 'https://investor.atmeta.com/'],
  ['TSLA', 'Tesla, Inc.', 'NASDAQ', 'https://ir.tesla.com/'],
  ['MRVL', 'Marvell Technology, Inc.', 'NASDAQ', 'https://investor.marvell.com/'],
  ['COHR', 'Coherent Corp.', 'NYSE', 'https://investor.coherent.com/'],
  ['ASTS', 'AST SpaceMobile, Inc.', 'NASDAQ', 'https://investors.ast-science.com/'],
  ['IONQ', 'IonQ, Inc.', 'NYSE', 'https://investors.ionq.com/'],
  ['GOOGL', 'Alphabet Inc.', 'NASDAQ', 'https://abc.xyz/investor/'],
  ['ORCL', 'Oracle Corporation', 'NYSE', 'https://investor.oracle.com/'],
  ['V', 'Visa Inc.', 'NYSE', 'https://investor.visa.com/'],
] as const;

// A reviewed starter identity list, not a live security master. Four additions are
// absent from upstream stocks.json; source URLs expose the identity references.
export const catalog: PulseCompany[] = identityRows.map(([symbol, name, exchange, sourceUrl]) => ({
  id: `${exchange}:${symbol}`,
  symbol,
  name,
  exchange,
  sourceUrl,
  cik: seedCiks[symbol],
  provenance: 'catalog',
  list: 'watchlist',
}));
const aliases = new Map<string, string[]>();
for (const company of catalog) {
  const upstreamName = stocks.symbols.find((row) => row.symbol === company.symbol)?.name;
  const names = [company.name, company.name.replace(/,?\s+(?:Corporation|Corp\.?|Inc\.?)$/i, '')];
  if (upstreamName && !ambiguousNames.has(upstreamName.toLowerCase())) names.push(upstreamName);
  aliases.set(
    company.symbol,
    [...new Set(names)].filter((name) => !ambiguousNames.has(name.toLowerCase())),
  );
}

export function defaultModeState(mode: PulseMode = 'world'): ModeState {
  return {
    sort: mode === 'portfolio' ? 'personal' : 'latest',
    showFiltered: false,
    query: '',
    hours: 24,
    categories: [],
    regions: [],
    sourceIds: [],
    camera: { lng: 10, lat: 20, zoom: 1 },
    selectedCompany: '',
    list: 'holdings',
    coverage: mode === 'world' ? 'balanced' : 'all',
  };
}
export function defaultAppState(): AppState {
  return {
    version: 3,
    workspace: defaultWorkspace(),
    modes: {
      world: defaultModeState(),
      portfolio: defaultModeState('portfolio'),
      explore: defaultModeState(),
    },
    companies: [],
    savedSearches: [],
    appearance: 'midnight',
  };
}
export function safeUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function text(value: unknown, max = 250): value is string {
  return typeof value === 'string' && value.length <= max;
}
function finite(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}
function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 200 && value.every((item) => text(item));
}
function isMode(value: unknown): value is ModeState {
  if (
    !record(value) ||
    (value.showFiltered !== undefined && typeof value.showFiltered !== 'boolean') ||
    (value.showLowQuality !== undefined && typeof value.showLowQuality !== 'boolean') ||
    !['latest', 'trending', 'important', 'personal'].includes(value.sort as string) ||
    !text(value.query, 2000) ||
    ![1, 6, 24, 168].includes(value.hours as number) ||
    !stringList(value.categories) ||
    !value.categories.every((item) => categories.includes(item as PulseCategory)) ||
    !stringList(value.regions) ||
    !stringList(value.sourceIds) ||
    !text(value.selectedCompany) ||
    !['holdings', 'watchlist'].includes(value.list as string) ||
    !['balanced', 'global', 'china', 'all'].includes(value.coverage as string) ||
    !record(value.camera) ||
    !finite(value.camera.lng, -180, 180) ||
    !finite(value.camera.lat, -90, 90) ||
    !finite(value.camera.zoom, 0, 24)
  )
    return false;
  if (value.bounds !== undefined) {
    if (!Array.isArray(value.bounds) || value.bounds.length !== 4) return false;
    const [west, south, east, north] = value.bounds;
    if (
      !finite(west, -180, 180) ||
      !finite(east, -180, 180) ||
      !finite(south, -90, 90) ||
      !finite(north, -90, 90) ||
      south > north
    )
      return false;
  }
  return true;
}
function isCompany(value: unknown): value is PulseCompany {
  if (
    !record(value) ||
    !text(value.id) ||
    !value.id.trim() ||
    !text(value.name) ||
    !value.name.trim() ||
    !text(value.symbol) ||
    !/^[A-Z][A-Z0-9.-]{0,14}$/.test(value.symbol) ||
    !text(value.exchange, 40) ||
    !value.exchange.trim() ||
    !['holdings', 'watchlist'].includes(value.list as string) ||
    !['catalog', 'user'].includes(value.provenance as string) ||
    (value.sourceUrl !== undefined &&
      (!text(value.sourceUrl, 2000) || !safeUrl(value.sourceUrl))) ||
    (value.cik !== undefined && (!text(value.cik, 10) || !/^\d{1,10}$/.test(value.cik))) ||
    (value.verifiedAt !== undefined &&
      (!text(value.verifiedAt, 40) || !Number.isFinite(Date.parse(value.verifiedAt)))) ||
    (value.aliases !== undefined &&
      (!Array.isArray(value.aliases) ||
        value.aliases.length > 20 ||
        !value.aliases.every((alias) => text(alias, 100) && !!alias.trim()))) ||
    (value.aliasProvenance !== undefined &&
      !['catalog', 'user'].includes(value.aliasProvenance as string)) ||
    (value.position !== undefined &&
      (!record(value.position) ||
        !finite(value.position.shares, 0, 1e12) ||
        !finite(value.position.cost, 0, 1e9))) ||
    (value.links !== undefined &&
      (!Array.isArray(value.links) ||
        value.links.length > 30 ||
        !value.links.every(
          (link) =>
            record(link) &&
            text(link.symbol, 15) &&
            /^[A-Z][A-Z0-9.-]{0,14}$/.test(link.symbol) &&
            ['supplier', 'customer', 'partner', 'competitor'].includes(link.relation as string) &&
            (link.note === undefined || text(link.note, 120)),
        )))
  )
    return false;
  // Preserve static seeds, or accept the server's sourced SEC directory record.
  // This is structural validation, not cryptographic authentication of local data.
  return (
    value.provenance !== 'catalog' ||
    catalog.some(
      (company) =>
        company.id === value.id &&
        company.symbol === value.symbol &&
        company.name === value.name &&
        company.exchange === value.exchange &&
        (value.cik === undefined ||
          (typeof value.cik === 'string' && value.cik.replace(/^0+/, '') === company.cik)) &&
        (company.sourceUrl === value.sourceUrl ||
          (value.cik !== undefined &&
            value.sourceUrl === `https://www.sec.gov/edgar/browse/?CIK=${company.cik}`)),
    ) ||
    (!!value.cik &&
      !!value.verifiedAt &&
      typeof value.sourceUrl === 'string' &&
      new URL(value.sourceUrl).hostname === 'www.sec.gov' &&
      new URL(value.sourceUrl).pathname.startsWith('/edgar/') &&
      new URL(value.sourceUrl).searchParams.get('CIK')?.replace(/^0+/, '') ===
        value.cik.replace(/^0+/, ''))
  );
}
function validState(value: unknown): value is AppState {
  if (
    !record(value) ||
    value.version !== 3 ||
    !validWorkspace(value.workspace) ||
    !record(value.modes) ||
    !['world', 'portfolio', 'explore'].every((mode) =>
      isMode(value.modes && (value.modes as Record<string, unknown>)[mode]),
    ) ||
    !Array.isArray(value.companies) ||
    value.companies.length > 500 ||
    !value.companies.every(isCompany) ||
    new Set(value.companies.map((company) => company.id)).size !== value.companies.length ||
    new Set(value.companies.map((company) => `${company.exchange}:${company.symbol}`)).size !==
      value.companies.length ||
    !Array.isArray(value.savedSearches) ||
    value.savedSearches.length > 200 ||
    !value.savedSearches.every(
      (search) =>
        record(search) &&
        text(search.id) &&
        !!search.id &&
        text(search.name) &&
        !!search.name.trim() &&
        isMode(search.state),
    ) ||
    new Set(value.savedSearches.map((search) => search.id)).size !== value.savedSearches.length ||
    !['graphite', 'midnight'].includes(value.appearance as string) ||
    (value.outlets !== undefined &&
      (!record(value.outlets) ||
        !Array.isArray(value.outlets.blocked) ||
        !Array.isArray(value.outlets.trusted) ||
        value.outlets.blocked.length > 500 ||
        value.outlets.trusted.length > 500 ||
        ![...value.outlets.blocked, ...value.outlets.trusted].every((key) => text(key, 200))))
  )
    return false;
  return true;
}
/** Install the viewer's outlet lists for heat, ranking and filtering. */
export function applyOutletPreferences(state: AppState): void {
  setOutletPreferences(state.outlets ?? { blocked: [], trusted: [] });
}
export function loadState(storage: Pick<Storage, 'getItem'>): {
  state: AppState;
  recovered: boolean;
} {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null) return { state: defaultAppState(), recovered: false };
    const state = migrateState(JSON.parse(raw));
    if (validState(state)) return { state, recovered: false };
  } catch {
    /* A blocked storage API is recoverable in the same way as corrupt JSON. */
  }
  return { state: defaultAppState(), recovered: true };
}
function migrateState(value: unknown): unknown {
  if (record(value) && value.version === 1 && record(value.modes)) {
    for (const mode of ['world', 'portfolio', 'explore'] as PulseMode[]) {
        const saved = value.modes[mode];
        if (record(saved) && saved.sort === undefined) saved.sort = defaultModeState(mode).sort;
        if (record(saved) && saved.coverage === undefined)
          saved.coverage = mode === 'world' ? 'balanced' : 'all';
      }
      if (Array.isArray(value.savedSearches))
        for (const search of value.savedSearches) {
          if (record(search) && record(search.state) && search.state.sort === undefined)
            search.state.sort = 'latest';
          if (record(search) && record(search.state) && search.state.coverage === undefined)
            search.state.coverage = 'all';
        }
    value.version = 2;
  }
  if (record(value) && value.version === 2) {
    value.version = 3;
    value.workspace = defaultWorkspace();
  }
  return value;
}
export function saveState(storage: Pick<Storage, 'setItem'>, state: AppState): boolean {
  try {
    if (!validState(state)) return false;
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}
export function exportConfiguration(state: AppState): string | null {
  if (!validState(state)) return null;
  return JSON.stringify(
    {
      format: 'world-pulse-config',
      version: 3,
      exportedAt: new Date().toISOString(),
      configuration: state,
    },
    null,
    2,
  );
}
export function importConfiguration(value: string): AppState | null {
  try {
    const parsed: unknown = JSON.parse(value);
    const candidate = migrateState(
      record(parsed) &&
        parsed.format === 'world-pulse-config' &&
        [1, 2, 3].includes(parsed.version as number)
        ? parsed.configuration
        : parsed,
    );
    return validState(candidate) ? candidate : null;
  } catch {
    return null;
  }
}
export function matchCompanies(event: PulseEvent, companies: PulseCompany[]): PulseMatch[] {
  const matches: PulseMatch[] = [];
  for (const company of companies) {
    const known = catalog.find(
      (entry) =>
        entry.symbol === company.symbol &&
        entry.exchange === company.exchange &&
        entry.name === company.name,
    );
    const reviewed = known ? aliases.get(company.symbol) : [];
    const userAliases = company.aliases ?? [];
    const match = directCompanyMatch(event, company, [...(reviewed ?? []), ...userAliases]);
    if (match)
      matches.push({
        ...match,
        provenance: userAliases.some(
          (alias) => alias.trim().toLocaleLowerCase() === match.term.trim().toLocaleLowerCase(),
        )
          ? 'user-provided'
          : 'verified',
      });
  }
  return matches;
}
export function filterEvents(
  events: PulseEvent[],
  mode: PulseMode,
  state: ModeState,
  companies: PulseCompany[],
  now = Date.now(),
): PulseEvent[] {
  const query = state.query.trim().toLocaleLowerCase();
  const activeCompanies = companies.filter(
    (company) =>
      company.list === state.list &&
      (!state.selectedCompany || company.id === state.selectedCompany),
  );
  const filtered = events.filter((event) => {
    if (mode !== 'portfolio' && !state.showFiltered && event.relevance?.decision === 'exclude')
      return false;
    const quality = eventQuality(event);
    if (quality.onlyBlocked) return false;
    if (quality.onlyLowQuality && !state.showLowQuality) return false;
    const published = observedEventTime(event);
    if (!Number.isFinite(published) || published > now || published < now - state.hours * 3_600_000)
      return false;
    if (query && !`${event.title}\n${event.summary}`.toLocaleLowerCase().includes(query))
      return false;
    if (state.categories.length && !state.categories.includes(event.category)) return false;
    if (
      state.sourceIds.length &&
      !event.sources.some((source) => state.sourceIds.includes(source.feedId || source.id))
    )
      return false;
    if (
      state.regions.length &&
      (!event.location ||
        !state.regions.some((region) =>
          [event.location!.country, event.location!.name].some(
            (name) => name.toLocaleLowerCase() === region.toLocaleLowerCase(),
          ),
        ))
    )
      return false;
    if (state.bounds) {
      if (!event.location) return false;
      const [west, south, east, north] = state.bounds;
      const { lon, lat } = event.location;
      if (
        lat < south ||
        lat > north ||
        (west <= east ? lon < west || lon > east : lon < west && lon > east)
      )
        return false;
    }
    if (mode === 'world' && state.coverage !== 'balanced' && state.coverage !== 'all') {
      const groups = eventCoverageGroups(event);
      if (state.coverage === 'china' && !groups.has('china')) return false;
      if (state.coverage === 'global' && !groups.has('global')) return false;
    }
    return mode !== 'portfolio' || matchCompanies(event, activeCompanies).length > 0;
  });
  const ranked = rankEvents(
    filtered,
    state.sort || (mode === 'portfolio' ? 'personal' : 'latest'),
    mode === 'portfolio' ? activeCompanies : [],
    now,
  );
  return mode === 'world' && state.coverage === 'balanced' ? balanceWorldEvents(ranked) : ranked;
}

function eventCoverageGroups(event: PulseEvent): Set<'global' | 'china'> {
  const groups = new Set<'global' | 'china'>();
  for (const source of event.sources) {
    const feedId = source.feedId || source.id;
    if (source.coverageGroup === 'china' || feedId.startsWith('cn-')) groups.add('china');
    else groups.add('global');
  }
  return groups;
}

function presentationRegion(event: PulseEvent): 'global' | 'china' {
  const groups = eventCoverageGroups(event);
  return groups.has('global') ? 'global' : 'china';
}

/** Stable display scheduling only; event scores and timestamps remain unchanged. */
export function balanceWorldEvents(events: PulseEvent[]): PulseEvent[] {
  const pending = [...events];
  const output: PulseEvent[] = [];
  const violates = (event: PulseEvent) => {
    const lastThree = output.slice(-3);
    const regionBlocked =
      lastThree.length === 3 &&
      lastThree.every((item) => presentationRegion(item) === presentationRegion(event));
    const lastTwo = output.slice(-2);
    const publisher = event.sources[0]?.publisher || event.sources[0]?.name || '';
    const publisherBlocked =
      !!publisher &&
      lastTwo.length === 2 &&
      lastTwo.every(
        (item) => (item.sources[0]?.publisher || item.sources[0]?.name || '') === publisher,
      );
    return regionBlocked || publisherBlocked;
  };
  while (pending.length) {
    let index = 0;
    if (violates(pending[0]!)) {
      const alternative = pending.slice(1, 13).findIndex((event) => !violates(event));
      if (alternative >= 0) index = alternative + 1;
    }
    output.push(pending.splice(index, 1)[0]!);
  }
  return output;
}
