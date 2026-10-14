export type PulseCategory = 'World' | 'Economy' | 'Technology' | 'Disasters';
export type PulseMode = 'world' | 'portfolio' | 'explore';
export type PulseCoverage = 'balanced' | 'global' | 'china' | 'all';
export type PulseCoverageGroup = 'global' | 'china' | 'neutral';
export type PulseTimeBasis = 'source-published' | 'source-updated' | 'first-seen';
export interface PulseSource {
  id: string;
  name: string;
  url: string;
  publisher: string;
  feedId?: string;
  coverageGroup?: PulseCoverageGroup;
  /** Publisher host reported by an aggregator feed; the link itself may be a redirect. */
  domain?: string;
}
export type PulseSort = 'latest' | 'trending' | 'important' | 'personal';
export interface PulseReport {
  id: string;
  title: string;
  summary: string;
  source: PulseSource;
  publishedAt: string | null;
  firstSeenAt: string;
  /** Latest successful retrieval; never used to extend retention. */
  lastFetchedAt?: string;
  /** Which timestamp supplied publishedAt, or first-seen when none was supplied. */
  timeBasis?: PulseTimeBasis;
}
export interface PulseArticle {
  eventId: string;
  reportId: string;
  title: string;
  source: PulseSource;
  sourceUrl: string;
  paragraphs: string[];
  state: 'available' | 'unavailable';
  fetchedAt: string;
  cached: boolean;
  message?: string;
  /** The link was a Google News redirect that was resolved to the publisher. */
  resolvedFrom?: 'google-news';
  /** Reports tried before this one could not be read. */
  skipped?: number;
}
export interface PulseAssessment {
  level: 'unassessed' | 'watch' | 'important' | 'major';
  reasons: string[];
  sourceIds: string[];
  method: 'rules' | 'ai';
  companyId?: string;
  generatedAt?: string;
  contentVersion?: string;
}
export interface PulseHeat {
  level: 'unassessed' | 'rising' | 'popular' | 'high';
  publishers24h: number;
  newReports3h: number;
  reasons: string[];
}
export interface PulseLocation {
  name: string;
  country: string;
  lat: number;
  lon: number;
  precision: 'country' | 'region' | 'exact';
  evidence: string;
}
export interface PulseRelevance {
  decision: 'keep' | 'exclude' | 'uncertain';
  reason: string;
  method: 'rules' | 'ai' | 'pending' | 'restored';
  version: string;
}
export interface PulseFilterStatus {
  enabled: boolean;
  configured: boolean;
  pricingConfigured: boolean;
  budgetRmb: number;
  spentRmb: number;
  pending: number;
  pilotReviewed: boolean;
  pilotProcessed: number;
  inputTokens: number;
  outputTokens: number;
}
export interface PulseEvent {
  relevance?: PulseRelevance;
  earthquakeAlert?: string;
  id: string;
  title: string;
  summary: string;
  category: PulseCategory;
  sources: PulseSource[];
  publishedAt: string | null;
  /** Compatibility alias for the latest successful retrieval. */
  fetchedAt: string;
  firstSeenAt?: string;
  lastFetchedAt?: string;
  timeBasis?: PulseTimeBasis;
  location?: PulseLocation;
  magnitude?: number;
  classificationBasis: string;
  reports?: PulseReport[];
  heat?: PulseHeat;
  importance?: PulseAssessment;
  companyAssessments?: Record<string, PulseAssessment>;
  companies?: {
    id: string;
    symbol: string;
    name: string;
    exchange: string;
    cik?: string;
  }[];
  community?: {
    provider: 'Hacker News';
    score: number;
    comments: number;
    url: string;
  };
  filing?: {
    form: string;
    cik: string;
    accession: string;
    metadataOnly: boolean;
  };
  cluster?: {
    method: 'rules';
    version: string;
    reasons: string[];
    reportIds: string[];
    memberEventIds?: string[];
    pairEvidence?: Array<{
      leftEventId: string;
      rightEventId: string;
      matchedBy: 'title-similarity' | 'action-theme-location';
      titleSimilarity: number;
      sharedEntities: Array<{ kind: string; id: string; label: string }>;
      sharedActions: string[];
      sharedThemes: string[];
      sharedLocations: string[];
    }>;
  };
}
export interface PulseSourceStatus {
  id: string;
  name: string;
  url: string;
  state: 'loading' | 'fresh' | 'stale' | 'error';
  lastSuccess: string | null;
  lastAttempt: string | null;
  nextRefresh: string | null;
  count: number;
  rejected: number;
  error?: string;
  coverage?: string;
  truncated?: boolean;
  intervalMs?: number;
  consecutiveFailures?: number;
  latencyMs?: number;
  coverageGroup?: PulseCoverageGroup;
}
export interface PulseAIControl {
  enabled: boolean;
  configured: boolean;
  effective: boolean;
  inFlight: number;
}
export interface PulseSnapshot {
  filtering?: PulseFilterStatus;
  manualAI?: {
    spentRmb: number;
    inputTokens: number;
    outputTokens: number;
    unknownCalls: number;
  };
  events: PulseEvent[];
  sources: PulseSourceStatus[];
  fetchedAt: string;
  aiConfigured: boolean;
  aiControl?: PulseAIControl;
  coverageSince?: string;
  cacheTruncated?: boolean;
  diagnostics?: {
    serviceRunning: true;
    databaseWritable: boolean;
    databaseIntegrity: 'ok' | 'error';
    lastSuccessfulFetch: string | null;
    sourceCounts: { fresh: number; stale: number; error: number; loading: number };
    coverageSince: string | null;
    ai: {
      configured: boolean;
      state: PulseAIStatus['state'] | 'untested';
      message: string;
      testedAt?: string;
      usage: {
        spentRmb: number;
        inputTokens: number;
        outputTokens: number;
        unknownCalls: number;
      };
    };
  };
}
export interface PulseExplanation {
  eventId: string;
  statements: {
    section: 'core' | 'change' | 'impact' | 'watch';
    kind: 'fact' | 'inference' | 'question';
    text: string;
    sourceIds: string[];
  }[];
  basis: { mode: 'article-excerpts' | 'headlines'; articleCount: number; reportCount: number };
  retention: 'ephemeral';
  limitation: string;
  generatedAt: string;
  cached: boolean;
}
export interface PulseCompany {
  id: string;
  symbol: string;
  name: string;
  exchange: string;
  list: 'holdings' | 'watchlist';
  provenance: 'catalog' | 'user';
  sourceUrl?: string;
  cik?: string;
  verifiedAt?: string;
  aliases?: string[];
  aliasProvenance?: 'catalog' | 'user';
  /** Optional position; kept only in this browser and in exported configuration. */
  position?: { shares: number; cost: number };
  /** Links the user entered; related companies, never direct mentions. */
  links?: PulseCompanyLink[];
}
export interface PulseCompanyLink {
  symbol: string;
  relation: 'supplier' | 'customer' | 'partner' | 'competitor';
  note?: string;
}
export interface PulseDirectory {
  companies: PulseCompany[];
  updatedAt: string | null;
  state: 'fresh' | 'stale' | 'seed' | 'error';
  message?: string;
}
export interface PulseCompanyData {
  company: PulseCompany;
  events: PulseEvent[];
  sources: PulseSourceStatus[];
}
export interface PulseAIStatus {
  state:
    | 'unconfigured'
    | 'disabled'
    | 'available'
    | 'authentication_error'
    | 'insufficient_balance'
    | 'timeout'
    | 'error';
  message: string;
}
export interface PulseMatch {
  companyId: string;
  symbol: string;
  term: string;
  excerpt: string;
  sourceUrl: string;
  provenance?: 'verified' | 'user-provided';
}

export interface PulseQuote {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
  previousClose: number;
  high: number;
  low: number;
  open: number;
  /** Exchange time of the last trade reported by the provider. */
  time: string;
  fetchedAt: string;
  /** Provider that supplied this quote; useful when the free fallback is active. */
  source?: 'finnhub' | 'tiingo';
}
export interface PulseMarketSnapshot {
  configured: boolean;
  status: {
    isOpen: boolean;
    session: 'pre-market' | 'regular' | 'post-market' | 'closed';
    holiday: string | null;
  };
  quotes: Record<string, PulseQuote>;
  /** True when the local per-minute budget or the provider limit held back refreshes. */
  limited: boolean;
  usage: { callsLastMinute: number; limit: number };
  fetchedAt: string;
  providers?: {
    finnhub: { configured: boolean; callsLastMinute: number; limit: number };
    tiingo: {
      configured: boolean;
      callsLastHour: number;
      callsToday: number;
      uniqueSymbolsThisMonth: number;
      hourlyLimit: number;
      dailyLimit: number;
      monthlySymbolLimit: number;
    };
  };
}
export interface PulseCompanyProfile {
  symbol: string;
  name: string;
  exchange?: string;
  industry?: string;
  country?: string;
  /** Millions of USD, as reported by the provider. */
  marketCap?: number;
  weburl?: string;
  peers: string[];
  nextEarnings?: { date: string; hour?: 'bmo' | 'amc'; epsEstimate?: number };
  fetchedAt: string;
}
export interface PulseSearchResult {
  symbol: string;
  description: string;
  type: string;
}
export interface PulseCalendarItem {
  date: string;
  title: string;
  kind: 'fomc' | 'cpi' | 'earnings';
  symbol?: string;
  detail?: string;
}
