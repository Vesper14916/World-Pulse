import type {
  PulseEvent,
  PulseReport,
  PulseSource,
} from "../../shared/world-pulse";
import {
  articleKey,
  assessReport,
  cleanHeadline,
  cleanSummary,
} from "../../shared/world-pulse-quality";

const WINDOW_MS = 24 * 60 * 60 * 1000;
const SIMILARITY_THRESHOLD = 0.45;
const VERSION = "wp015-two-layer-v1" as const;
const SAME_ARTICLE_WINDOW_MS = 72 * 60 * 60 * 1000;

type EntityKind = "company" | "country" | "city" | "facility" | "organization";
type SignalKind = "action" | "theme" | "direction";

interface DictionaryEntry<K extends EntityKind | SignalKind> {
  kind: K;
  id: string;
  label: string;
  aliases: readonly string[];
}

export interface PulseClusterEntity {
  kind: EntityKind;
  id: string;
  label: string;
}

export interface PulseClusterPairEvidence {
  leftEventId: string;
  rightEventId: string;
  matchedBy: "title-similarity" | "action-theme-location";
  titleSimilarity: number;
  sharedEntities: PulseClusterEntity[];
  sharedActions: string[];
  sharedThemes: string[];
  sharedLocations: string[];
}

export interface PulseClusterEvidence {
  version: typeof VERSION;
  clustered: boolean;
  representativeEventId: string;
  memberEventIds: string[];
  pairEvidence: PulseClusterPairEvidence[];
  basis: string[];
}

export interface PulseEventCluster {
  event: PulseEvent;
  evidence: PulseClusterEvidence;
}

export type PulseClusterRejection =
  | "different-category"
  | "outside-24h-window"
  | "missing-reliable-time"
  | "distinct-usgs-events"
  | "incompatible-sec-filings"
  | "filing-versus-news"
  | "conflicting-countries"
  | "conflicting-companies"
  | "conflicting-numbers"
  | "conflicting-policy-direction"
  | "no-strong-shared-entity"
  | "insufficient-title-or-context-match";

export type PulseClusteringDecision =
  | { eligible: true; evidence: PulseClusterPairEvidence }
  | { eligible: false; reason: PulseClusterRejection };

const ENTITIES: readonly DictionaryEntry<EntityKind>[] = [
  {
    kind: "country",
    id: "china",
    label: "China",
    aliases: ["China", "Chinese", "中国", "中方"],
  },
  {
    kind: "country",
    id: "united-states",
    label: "United States",
    aliases: [
      "United States",
      "United States of America",
      "U.S.",
      "USA",
      "US",
      "美国",
      "美方",
    ],
  },
  {
    kind: "country",
    id: "russia",
    label: "Russia",
    aliases: ["Russia", "Russian", "俄罗斯", "俄方"],
  },
  {
    kind: "country",
    id: "ukraine",
    label: "Ukraine",
    aliases: ["Ukraine", "Ukrainian", "乌克兰", "乌方"],
  },
  {
    kind: "country",
    id: "israel",
    label: "Israel",
    aliases: ["Israel", "Israeli", "以色列", "以方"],
  },
  {
    kind: "country",
    id: "iran",
    label: "Iran",
    aliases: ["Iran", "Iranian", "伊朗", "伊方"],
  },
  {
    kind: "country",
    id: "taiwan",
    label: "Taiwan",
    aliases: ["Taiwan", "Taiwanese", "台湾"],
  },
  {
    kind: "country",
    id: "japan",
    label: "Japan",
    aliases: ["Japan", "Japanese", "日本"],
  },
  {
    kind: "country",
    id: "south-korea",
    label: "South Korea",
    aliases: ["South Korea", "S. Korea", "韩国"],
  },
  {
    kind: "country",
    id: "north-korea",
    label: "North Korea",
    aliases: ["North Korea", "DPRK", "朝鲜"],
  },
  {
    kind: "country",
    id: "india",
    label: "India",
    aliases: ["India", "Indian", "印度"],
  },
  {
    kind: "country",
    id: "united-kingdom",
    label: "United Kingdom",
    aliases: ["United Kingdom", "Britain", "British", "UK", "英国"],
  },
  {
    kind: "country",
    id: "france",
    label: "France",
    aliases: ["France", "French", "法国"],
  },
  {
    kind: "country",
    id: "germany",
    label: "Germany",
    aliases: ["Germany", "German", "德国"],
  },
  {
    kind: "country",
    id: "european-union",
    label: "European Union",
    aliases: ["European Union", "EU", "欧盟"],
  },
  {
    kind: "country",
    id: "canada",
    label: "Canada",
    aliases: ["Canada", "Canadian", "加拿大"],
  },
  {
    kind: "country",
    id: "mexico",
    label: "Mexico",
    aliases: ["Mexico", "Mexican", "墨西哥"],
  },
  {
    kind: "country",
    id: "brazil",
    label: "Brazil",
    aliases: ["Brazil", "Brazilian", "巴西"],
  },
  {
    kind: "country",
    id: "australia",
    label: "Australia",
    aliases: ["Australia", "Australian", "澳大利亚"],
  },
  {
    kind: "country",
    id: "singapore",
    label: "Singapore",
    aliases: ["Singapore", "新加坡"],
  },
  {
    kind: "city",
    id: "beijing",
    label: "Beijing",
    aliases: ["Beijing", "北京"],
  },
  {
    kind: "city",
    id: "shanghai",
    label: "Shanghai",
    aliases: ["Shanghai", "上海"],
  },
  {
    kind: "city",
    id: "shenzhen",
    label: "Shenzhen",
    aliases: ["Shenzhen", "深圳"],
  },
  {
    kind: "city",
    id: "hong-kong",
    label: "Hong Kong",
    aliases: ["Hong Kong", "香港"],
  },
  {
    kind: "city",
    id: "washington-dc",
    label: "Washington",
    aliases: ["Washington DC", "Washington, D.C.", "华盛顿"],
  },
  {
    kind: "city",
    id: "new-york",
    label: "New York",
    aliases: ["New York", "纽约"],
  },
  {
    kind: "city",
    id: "moscow",
    label: "Moscow",
    aliases: ["Moscow", "莫斯科"],
  },
  {
    kind: "city",
    id: "kyiv",
    label: "Kyiv",
    aliases: ["Kyiv", "Kiev", "基辅"],
  },
  { kind: "city", id: "tokyo", label: "Tokyo", aliases: ["Tokyo", "东京"] },
  { kind: "city", id: "seoul", label: "Seoul", aliases: ["Seoul", "首尔"] },
  { kind: "city", id: "london", label: "London", aliases: ["London", "伦敦"] },
  { kind: "city", id: "paris", label: "Paris", aliases: ["Paris", "巴黎"] },
  {
    kind: "city",
    id: "gaza",
    label: "Gaza",
    aliases: ["Gaza", "Gaza City", "加沙"],
  },
  {
    kind: "facility",
    id: "taiwan-strait",
    label: "Taiwan Strait",
    aliases: ["Taiwan Strait", "台湾海峡"],
  },
  {
    kind: "facility",
    id: "south-china-sea",
    label: "South China Sea",
    aliases: ["South China Sea", "南海"],
  },
  {
    kind: "facility",
    id: "red-sea",
    label: "Red Sea",
    aliases: ["Red Sea", "红海"],
  },
  {
    kind: "facility",
    id: "suez-canal",
    label: "Suez Canal",
    aliases: ["Suez Canal", "苏伊士运河"],
  },
  {
    kind: "organization",
    id: "federal-reserve",
    label: "Federal Reserve",
    aliases: ["Federal Reserve", "Fed", "美联储"],
  },
  {
    kind: "organization",
    id: "ecb",
    label: "European Central Bank",
    aliases: ["European Central Bank", "ECB", "欧洲央行"],
  },
  {
    kind: "organization",
    id: "imf",
    label: "IMF",
    aliases: ["International Monetary Fund", "IMF", "国际货币基金组织"],
  },
  {
    kind: "organization",
    id: "wto",
    label: "WTO",
    aliases: ["World Trade Organization", "WTO", "世界贸易组织", "世贸组织"],
  },
  {
    kind: "organization",
    id: "sec",
    label: "SEC",
    aliases: ["Securities and Exchange Commission", "SEC", "美国证监会"],
  },
  {
    kind: "organization",
    id: "nato",
    label: "NATO",
    aliases: ["North Atlantic Treaty Organization", "NATO", "北约"],
  },
  {
    kind: "organization",
    id: "united-nations",
    label: "United Nations",
    aliases: ["United Nations", "UN", "联合国"],
  },
  {
    kind: "organization",
    id: "who",
    label: "WHO",
    aliases: ["World Health Organization", "WHO", "世界卫生组织", "世卫组织"],
  },
  {
    kind: "organization",
    id: "opec",
    label: "OPEC",
    aliases: ["OPEC", "欧佩克", "石油输出国组织"],
  },
  {
    kind: "company",
    id: "nvidia",
    label: "NVIDIA",
    aliases: ["NVIDIA", "英伟达"],
  },
  {
    kind: "company",
    id: "apple",
    label: "Apple",
    aliases: ["Apple Inc", "Apple company", "苹果公司"],
  },
  {
    kind: "company",
    id: "microsoft",
    label: "Microsoft",
    aliases: ["Microsoft", "微软"],
  },
  {
    kind: "company",
    id: "amazon",
    label: "Amazon",
    aliases: ["Amazon.com", "Amazon Inc", "亚马逊"],
  },
  {
    kind: "company",
    id: "meta",
    label: "Meta",
    aliases: ["Meta Platforms", "Meta company"],
  },
  {
    kind: "company",
    id: "tesla",
    label: "Tesla",
    aliases: ["Tesla", "特斯拉"],
  },
  {
    kind: "company",
    id: "alphabet",
    label: "Alphabet",
    aliases: ["Alphabet Inc", "Google", "谷歌"],
  },
  {
    kind: "company",
    id: "oracle",
    label: "Oracle",
    aliases: ["Oracle Corporation", "甲骨文"],
  },
  {
    kind: "company",
    id: "huawei",
    label: "Huawei",
    aliases: ["Huawei", "华为"],
  },
  {
    kind: "company",
    id: "tsmc",
    label: "TSMC",
    aliases: ["TSMC", "台积电"],
  },
  { kind: "company", id: "openai", label: "OpenAI", aliases: ["OpenAI"] },
] as const;

const ACTIONS: readonly DictionaryEntry<"action">[] = [
  {
    kind: "action",
    id: "announce",
    label: "announce",
    aliases: ["announce", "announces", "announced", "宣布", "发布"],
  },
  {
    kind: "action",
    id: "approve",
    label: "approve",
    aliases: ["approve", "approves", "approved", "批准", "通过"],
  },
  {
    kind: "action",
    id: "launch",
    label: "launch",
    aliases: [
      "launch",
      "launches",
      "launched",
      "unveil",
      "unveils",
      "推出",
      "发射",
    ],
  },
  {
    kind: "action",
    id: "attack",
    label: "attack",
    aliases: [
      "attack",
      "attacks",
      "attacked",
      "strike",
      "strikes",
      "袭击",
      "攻击",
      "空袭",
    ],
  },
  {
    kind: "action",
    id: "restrict",
    label: "restrict",
    aliases: [
      "restrict",
      "restricts",
      "restricted",
      "curb",
      "curbs",
      "限制",
      "禁止",
    ],
  },
  {
    kind: "action",
    id: "sanction",
    label: "sanction",
    aliases: ["sanction", "sanctions", "sanctioned", "制裁"],
  },
  {
    kind: "action",
    id: "cut",
    label: "cut",
    aliases: ["cuts", "cut rate", "lower rate", "降息", "下调"],
  },
  {
    kind: "action",
    id: "raise",
    label: "raise",
    aliases: [
      "raises rate",
      "raised rate",
      "hikes rate",
      "rate hike",
      "加息",
      "上调",
    ],
  },
  {
    kind: "action",
    id: "acquire",
    label: "acquire",
    aliases: ["acquire", "acquires", "acquisition", "buyout", "收购", "并购"],
  },
  {
    kind: "action",
    id: "invest",
    label: "invest",
    aliases: ["invest", "invests", "investment", "投资"],
  },
  {
    kind: "action",
    id: "file",
    label: "file",
    aliases: ["files", "filed", "filing", "申报", "提交文件"],
  },
  {
    kind: "action",
    id: "recall",
    label: "recall",
    aliases: ["recall", "recalls", "recalled", "召回"],
  },
  {
    kind: "action",
    id: "elect",
    label: "elect",
    aliases: ["election", "elected", "votes", "voting", "选举", "投票", "当选"],
  },
  {
    kind: "action",
    id: "earthquake",
    label: "earthquake",
    aliases: ["earthquake", "quake", "地震"],
  },
  {
    kind: "action",
    id: "flood",
    label: "flood",
    aliases: ["flood", "floods", "flooding", "洪水", "洪涝"],
  },
  {
    kind: "action",
    id: "wildfire",
    label: "wildfire",
    aliases: ["wildfire", "wildfires", "山火", "森林火灾"],
  },
  {
    kind: "action",
    id: "resign",
    label: "resign",
    aliases: ["resign", "resigns", "resigned", "辞职", "下台"],
  },
  {
    kind: "action",
    id: "sue",
    label: "sue",
    aliases: ["sues", "sued", "lawsuit", "起诉", "诉讼"],
  },
] as const;

const THEMES: readonly DictionaryEntry<"theme">[] = [
  {
    kind: "theme",
    id: "interest-rates",
    label: "interest rates",
    aliases: [
      "interest rate",
      "interest rates",
      "monetary policy",
      "利率",
      "货币政策",
      "降息",
      "加息",
    ],
  },
  {
    kind: "theme",
    id: "export-controls",
    label: "export controls",
    aliases: [
      "export control",
      "export controls",
      "export ban",
      "export restriction",
      "出口管制",
      "出口限制",
      "禁止出口",
    ],
  },
  {
    kind: "theme",
    id: "chips",
    label: "chips",
    aliases: [
      "semiconductor",
      "semiconductors",
      "chip",
      "chips",
      "半导体",
      "芯片",
    ],
  },
  {
    kind: "theme",
    id: "artificial-intelligence",
    label: "artificial intelligence",
    aliases: ["artificial intelligence", "AI", "人工智能", "大模型"],
  },
  {
    kind: "theme",
    id: "trade",
    label: "trade",
    aliases: ["trade", "imports", "exports", "贸易", "进口", "出口"],
  },
  {
    kind: "theme",
    id: "tariffs",
    label: "tariffs",
    aliases: ["tariff", "tariffs", "关税"],
  },
  {
    kind: "theme",
    id: "armed-conflict",
    label: "armed conflict",
    aliases: [
      "war",
      "conflict",
      "military",
      "missile",
      "战争",
      "冲突",
      "军事",
      "导弹",
    ],
  },
  {
    kind: "theme",
    id: "election",
    label: "election",
    aliases: ["election", "ballot", "选举", "投票"],
  },
  {
    kind: "theme",
    id: "earnings",
    label: "earnings",
    aliases: [
      "earnings",
      "quarterly results",
      "guidance",
      "财报",
      "业绩",
      "指引",
    ],
  },
  {
    kind: "theme",
    id: "regulation",
    label: "regulation",
    aliases: ["regulation", "regulator", "antitrust", "监管", "反垄断"],
  },
  {
    kind: "theme",
    id: "earthquake",
    label: "earthquake",
    aliases: ["earthquake", "quake", "地震"],
  },
  {
    kind: "theme",
    id: "flood",
    label: "flood",
    aliases: ["flood", "flooding", "洪水", "洪涝"],
  },
  {
    kind: "theme",
    id: "climate",
    label: "climate",
    aliases: ["climate", "global warming", "气候", "全球变暖"],
  },
  {
    kind: "theme",
    id: "energy",
    label: "energy",
    aliases: [
      "energy",
      "oil",
      "natural gas",
      "nuclear power",
      "能源",
      "石油",
      "天然气",
      "核电",
    ],
  },
  {
    kind: "theme",
    id: "space",
    label: "space",
    aliases: ["space", "satellite", "rocket", "航天", "卫星", "火箭"],
  },
  {
    kind: "theme",
    id: "cybersecurity",
    label: "cybersecurity",
    aliases: [
      "cybersecurity",
      "cyberattack",
      "ransomware",
      "网络安全",
      "网络攻击",
      "勒索软件",
    ],
  },
] as const;

const DIRECTIONS: readonly DictionaryEntry<"direction">[] = [
  {
    kind: "direction",
    id: "tighten",
    label: "tighten",
    aliases: [
      "tighten",
      "tightens",
      "ban",
      "bans",
      "restrict",
      "restricts",
      "sanction",
      "sanctions",
      "收紧",
      "禁止",
      "限制",
      "制裁",
    ],
  },
  {
    kind: "direction",
    id: "ease",
    label: "ease",
    aliases: [
      "ease",
      "eases",
      "lift ban",
      "lifts ban",
      "remove restriction",
      "宽松",
      "解除禁令",
      "取消限制",
    ],
  },
  {
    kind: "direction",
    id: "rate-up",
    label: "rate up",
    aliases: [
      "rate hike",
      "raises interest rates",
      "hikes interest rates",
      "加息",
      "上调利率",
    ],
  },
  {
    kind: "direction",
    id: "rate-down",
    label: "rate down",
    aliases: [
      "rate cut",
      "cuts interest rates",
      "lowers interest rates",
      "降息",
      "下调利率",
    ],
  },
  {
    kind: "direction",
    id: "approve",
    label: "approve",
    aliases: ["approve", "approves", "approved", "批准", "通过"],
  },
  {
    kind: "direction",
    id: "reject",
    label: "reject",
    aliases: [
      "reject",
      "rejects",
      "rejected",
      "block",
      "blocks",
      "拒绝",
      "否决",
      "阻止",
    ],
  },
] as const;

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "in",
  "is",
  "it",
  "new",
  "of",
  "on",
  "says",
  "the",
  "to",
  "with",
  "after",
  "amid",
  "over",
  "its",
  "their",
]);

interface TitleAnalysis {
  entities: PulseClusterEntity[];
  entityIds: Set<string>;
  countries: Set<string>;
  companies: Set<string>;
  locations: Set<string>;
  actions: Set<string>;
  themes: Set<string>;
  directions: Set<string>;
  numbers: Set<string>;
  tokens: Set<string>;
}

function normalizedText(value: string): string {
  return value.normalize("NFKC").replace(/[’‘]/g, "'").toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasAlias(text: string, alias: string, rawText: string): boolean {
  if (/^[A-Z]{2,5}$/.test(alias)) {
    const pattern = escapeRegExp(alias);
    return new RegExp(`(^|[^A-Za-z0-9])${pattern}(?=$|[^A-Za-z0-9])`).test(
      rawText,
    );
  }
  const normalized = normalizedText(alias);
  if (/[^\x00-\x7f]/.test(normalized)) return text.includes(normalized);
  const pattern = escapeRegExp(normalized).replace(/\s+/g, "\\s+");
  return new RegExp(`(^|[^a-z0-9])${pattern}(?=$|[^a-z0-9])`, "i").test(text);
}

function matched<K extends EntityKind | SignalKind>(
  text: string,
  rawText: string,
  dictionary: readonly DictionaryEntry<K>[],
): DictionaryEntry<K>[] {
  return dictionary.filter((entry) =>
    entry.aliases.some((alias) => hasAlias(text, alias, rawText)),
  );
}

function intersection<T>(left: Set<T>, right: Set<T>): T[] {
  return [...left].filter((value) => right.has(value)).sort();
}

function conflictingSets(left: Set<string>, right: Set<string>): boolean {
  return (
    left.size > 0 && right.size > 0 && intersection(left, right).length === 0
  );
}

function conflictingDirections(left: Set<string>, right: Set<string>): boolean {
  const opposites = [
    ["tighten", "ease"],
    ["rate-up", "rate-down"],
    ["approve", "reject"],
  ] as const;
  return opposites.some(
    ([a, b]) => (left.has(a) && right.has(b)) || (left.has(b) && right.has(a)),
  );
}

function extractNumbers(text: string): Set<string> {
  const numbers = new Set<string>();
  for (const match of text.matchAll(
    /\b\d+(?:[.,]\d+)*(?:\s?(?:%|bn|billion|million|trillion))?\b/giu,
  ))
    numbers.add(match[0].replace(/\s+/g, "").replace(/,/g, "").toLowerCase());
  for (const match of text.matchAll(
    /[零〇一二两三四五六七八九十百千万亿]+(?:人|名|例|级|%|％)/gu,
  ))
    numbers.add(match[0].replace("％", "%"));
  return numbers;
}

function lexicalTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const token of text.match(/[a-z0-9]+(?:['-][a-z0-9]+)*/g) ?? [])
    if (token.length >= 2 && !STOPWORDS.has(token)) tokens.add(token);
  const chineseRuns = text.match(/[\u3400-\u9fff]{2,}/g) ?? [];
  for (const run of chineseRuns)
    for (let index = 0; index < run.length - 1; index++)
      tokens.add(run.slice(index, index + 2));
  return tokens;
}

export function analyzePulseTitle(title: string): TitleAnalysis {
  const rawText = title.normalize("NFKC").replace(/[’‘]/g, "'");
  const text = normalizedText(rawText);
  const entityEntries = matched(text, rawText, ENTITIES);
  const actions = new Set(
    matched(text, rawText, ACTIONS).map((entry) => entry.id),
  );
  const themes = new Set(
    matched(text, rawText, THEMES).map((entry) => entry.id),
  );
  const directions = new Set(
    matched(text, rawText, DIRECTIONS).map((entry) => entry.id),
  );
  const entities = entityEntries.map(({ kind, id, label }) => ({
    kind,
    id,
    label,
  }));
  const tokens = lexicalTokens(text);
  for (const entity of entities)
    tokens.add(`entity:${entity.kind}:${entity.id}`);
  for (const action of actions) tokens.add(`action:${action}`);
  for (const theme of themes) tokens.add(`theme:${theme}`);
  return {
    entities,
    entityIds: new Set(entities.map((entity) => `${entity.kind}:${entity.id}`)),
    countries: new Set(
      entities
        .filter((entity) => entity.kind === "country")
        .map((entity) => entity.id),
    ),
    companies: new Set(
      entities
        .filter((entity) => entity.kind === "company")
        .map((entity) => entity.id),
    ),
    locations: new Set(
      entities
        .filter((entity) =>
          ["country", "city", "facility"].includes(entity.kind),
        )
        .map((entity) => `${entity.kind}:${entity.id}`),
    ),
    actions,
    themes,
    directions,
    numbers: extractNumbers(text),
    tokens,
  };
}

function jaccard(left: Set<string>, right: Set<string>): number {
  const union = new Set([...left, ...right]);
  if (!union.size) return 0;
  return intersection(left, right).length / union.size;
}

function eventTime(event: PulseEvent): number | undefined {
  const candidates = [
    event.publishedAt,
    ...(event.reports ?? []).flatMap((report) => [
      report.publishedAt,
      report.firstSeenAt,
    ]),
    event.fetchedAt,
  ];
  for (const candidate of candidates) {
    const time = candidate ? Date.parse(candidate) : NaN;
    if (Number.isFinite(time)) return time;
  }
  return undefined;
}

function isUsgs(event: PulseEvent): boolean {
  return event.sources.some((source) => {
    if (source.id === "usgs" || source.feedId === "usgs") return true;
    try {
      return new URL(source.url).hostname === "earthquake.usgs.gov";
    } catch {
      return false;
    }
  });
}

function sourceEntities(
  sharedIds: string[],
  left: TitleAnalysis,
  right: TitleAnalysis,
): PulseClusterEntity[] {
  const byId = new Map(
    [...left.entities, ...right.entities].map((entity) => [
      `${entity.kind}:${entity.id}`,
      entity,
    ]),
  );
  return sharedIds.flatMap((id) => {
    const entity = byId.get(id);
    return entity ? [entity] : [];
  });
}

export function clusteringDecision(
  left: PulseEvent,
  right: PulseEvent,
): PulseClusteringDecision {
  return clusteringDecisionWithAnalysis(
    left,
    right,
    analyzePulseTitle(left.title),
    analyzePulseTitle(right.title),
  );
}

function clusteringDecisionWithAnalysis(
  left: PulseEvent,
  right: PulseEvent,
  leftAnalysis: TitleAnalysis,
  rightAnalysis: TitleAnalysis,
): PulseClusteringDecision {
  if (left.category !== right.category)
    return { eligible: false, reason: "different-category" };
  const leftTime = eventTime(left);
  const rightTime = eventTime(right);
  if (leftTime === undefined || rightTime === undefined)
    return { eligible: false, reason: "missing-reliable-time" };
  if (Math.abs(leftTime - rightTime) > WINDOW_MS)
    return { eligible: false, reason: "outside-24h-window" };
  if (isUsgs(left) && isUsgs(right) && left.id !== right.id)
    return { eligible: false, reason: "distinct-usgs-events" };
  if (Boolean(left.filing) !== Boolean(right.filing))
    return { eligible: false, reason: "filing-versus-news" };
  if (
    left.filing &&
    right.filing &&
    (left.filing.cik !== right.filing.cik ||
      left.filing.accession !== right.filing.accession ||
      left.publishedAt?.slice(0, 10) !== right.publishedAt?.slice(0, 10))
  )
    return { eligible: false, reason: "incompatible-sec-filings" };

  if (conflictingSets(leftAnalysis.countries, rightAnalysis.countries))
    return { eligible: false, reason: "conflicting-countries" };
  if (conflictingSets(leftAnalysis.companies, rightAnalysis.companies))
    return { eligible: false, reason: "conflicting-companies" };
  if (conflictingSets(leftAnalysis.numbers, rightAnalysis.numbers))
    return { eligible: false, reason: "conflicting-numbers" };
  if (conflictingDirections(leftAnalysis.directions, rightAnalysis.directions))
    return { eligible: false, reason: "conflicting-policy-direction" };

  const sharedEntityIds = intersection(
    leftAnalysis.entityIds,
    rightAnalysis.entityIds,
  );
  if (!sharedEntityIds.length)
    return { eligible: false, reason: "no-strong-shared-entity" };
  const sharedActions = intersection(
    leftAnalysis.actions,
    rightAnalysis.actions,
  );
  const sharedThemes = intersection(leftAnalysis.themes, rightAnalysis.themes);
  const sharedLocations = intersection(
    leftAnalysis.locations,
    rightAnalysis.locations,
  );
  const similarity = jaccard(leftAnalysis.tokens, rightAnalysis.tokens);
  const matchedBy =
    similarity >= SIMILARITY_THRESHOLD
      ? "title-similarity"
      : sharedActions.length && sharedThemes.length && sharedLocations.length
        ? "action-theme-location"
        : undefined;
  if (!matchedBy)
    return { eligible: false, reason: "insufficient-title-or-context-match" };
  return {
    eligible: true,
    evidence: {
      leftEventId: left.id,
      rightEventId: right.id,
      matchedBy,
      titleSimilarity: Number(similarity.toFixed(3)),
      sharedEntities: sourceEntities(
        sharedEntityIds,
        leftAnalysis,
        rightAnalysis,
      ),
      sharedActions,
      sharedThemes,
      sharedLocations,
    },
  };
}

function sourceKey(source: PulseSource): string {
  return `${source.id}|${source.url}|${source.feedId ?? ""}`;
}

function reportsFor(event: PulseEvent): PulseReport[] {
  if (event.reports?.length) return event.reports;
  return event.sources.map((source, index) => ({
    id: `${event.id}:report:${index}`,
    title: event.title,
    summary: event.summary,
    source,
    publishedAt: event.publishedAt,
    firstSeenAt: event.firstSeenAt ?? event.fetchedAt,
    lastFetchedAt: event.lastFetchedAt ?? event.fetchedAt,
    timeBasis: event.timeBasis ?? (event.publishedAt ? "source-published" : "first-seen"),
  }));
}

function mergeMembers(members: PulseEvent[]): PulseEvent {
  const representative = members[0]!;
  const sources = new Map<string, PulseSource>();
  const reports = new Map<string, PulseReport>();
  const companies = new Map<
    string,
    NonNullable<PulseEvent["companies"]>[number]
  >();
  for (const event of members) {
    for (const source of event.sources) sources.set(sourceKey(source), source);
    for (const report of reportsFor(event)) {
      const key = `${report.id}|${report.source.url}`;
      if (!reports.has(key)) reports.set(key, report);
    }
    for (const company of event.companies ?? [])
      companies.set(company.id, company);
  }
  const publicationTimes = members
    .flatMap((event) => [
      event.publishedAt,
      ...(event.reports ?? []).map((report) => report.publishedAt),
    ])
    .flatMap((value) => {
      const time = value ? Date.parse(value) : NaN;
      return Number.isFinite(time) ? [time] : [];
    });
  const fetchedTimes = members
    .map((event) => Date.parse(event.lastFetchedAt ?? event.fetchedAt))
    .filter(Number.isFinite);
  const firstSeenTimes = members
    .map((event) => Date.parse(event.firstSeenAt ?? event.fetchedAt))
    .filter(Number.isFinite);
  return {
    ...representative,
    summary:
      representative.summary ||
      members.find((event) => event.summary)?.summary ||
      "",
    sources: [...sources.values()],
    reports: [...reports.values()],
    publishedAt: publicationTimes.length
      ? new Date(Math.min(...publicationTimes)).toISOString()
      : representative.publishedAt,
    fetchedAt: fetchedTimes.length
      ? new Date(Math.max(...fetchedTimes)).toISOString()
      : representative.fetchedAt,
    firstSeenAt: firstSeenTimes.length
      ? new Date(Math.min(...firstSeenTimes)).toISOString()
      : representative.firstSeenAt,
    lastFetchedAt: fetchedTimes.length
      ? new Date(Math.max(...fetchedTimes)).toISOString()
      : representative.lastFetchedAt,
    companies: companies.size
      ? [...companies.values()]
      : representative.companies,
    heat: undefined,
  };
}

function compareEvents(left: PulseEvent, right: PulseEvent): number {
  return (
    (eventTime(left) ?? Number.MAX_SAFE_INTEGER) -
      (eventTime(right) ?? Number.MAX_SAFE_INTEGER) ||
    left.id.localeCompare(right.id) ||
    left.title.localeCompare(right.title)
  );
}

/**
 * Display title and summary without aggregator decoration. Report titles stay
 * untouched: they are the cache keys for headline filtering and evidence.
 */
export function presentableEvent(event: PulseEvent): PulseEvent {
  const lead = event.reports?.[0]?.source ?? event.sources[0];
  const title = cleanHeadline(event.title, lead);
  return {
    ...event,
    title,
    summary: cleanSummary(event.summary ?? "", event.title, title),
  };
}

function isDirectFeed(event: PulseEvent): boolean {
  return !event.sources.some((source) => {
    try {
      return new URL(source.url).hostname === "news.google.com";
    } catch {
      return false;
    }
  });
}
function leadRank(event: PulseEvent): number {
  const quality = assessReport({
    title: event.title,
    source: event.reports?.[0]?.source ?? event.sources[0]!,
  }).quality;
  return (
    (isDirectFeed(event) ? 0 : 4) +
    (quality === "A" ? 0 : quality === "B" ? 1 : 2)
  );
}

/**
 * Layer 1: the same article reached us through several feeds (a direct RSS
 * item and its Google News copy, or one outlet listed twice). Identical
 * normalised headlines within 72 hours merge regardless of feed category.
 */
export function mergeSameArticles(events: readonly PulseEvent[]): {
  events: PulseEvent[];
  members: Map<string, string[]>;
} {
  const sorted = [...events].sort(compareEvents);
  const buckets = new Map<string, PulseEvent[][]>();
  const singles: PulseEvent[][] = [];
  for (const event of sorted) {
    const key =
      isUsgs(event) || event.filing ? undefined : articleKey(event.title);
    if (!key) {
      singles.push([event]);
      continue;
    }
    const groups = buckets.get(key) ?? [];
    const time = eventTime(event);
    const destination = groups.find((group) => {
      const first = eventTime(group[0]!);
      return (
        time !== undefined &&
        first !== undefined &&
        Math.abs(time - first) <= SAME_ARTICLE_WINDOW_MS
      );
    });
    if (destination) destination.push(event);
    else groups.push([event]);
    buckets.set(key, groups);
  }
  const members = new Map<string, string[]>();
  const merged: PulseEvent[] = [];
  for (const group of [...singles, ...[...buckets.values()].flat()]) {
    if (group.length === 1) {
      merged.push(group[0]!);
      continue;
    }
    const ordered = [...group].sort(
      (left, right) => leadRank(left) - leadRank(right) || compareEvents(left, right),
    );
    const event = mergeMembers(ordered);
    members.set(event.id, ordered.map((member) => member.id));
    merged.push(event);
  }
  return { events: merged, members };
}

/**
 * Two-layer clustering. Layer 1 merges copies of one article; layer 2 is the
 * conservative complete-link event grouping: a candidate must satisfy the
 * pairwise rules against every existing member, preventing bridge merges.
 */
export function clusterPulseEvents(
  input: readonly PulseEvent[],
): PulseEventCluster[] {
  const layerOne = mergeSameArticles(input.map(presentableEvent));
  const events = layerOne.events;
  const sorted = [...events].sort(compareEvents);
  const analyses = new Map(
    sorted.map((event) => [event.id, analyzePulseTitle(event.title)]),
  );
  const groups: { members: PulseEvent[]; pairs: PulseClusterPairEvidence[] }[] = [];
  const groupsByEntity = new Map<string, Set<number>>();
  const indexGroup = (groupIndex: number, event: PulseEvent) => {
    const analysis = analyses.get(event.id)!;
    for (const entityId of analysis.entityIds) {
      const key = `${event.category}|${entityId}`;
      const indexed = groupsByEntity.get(key) ?? new Set<number>();
      indexed.add(groupIndex);
      groupsByEntity.set(key, indexed);
    }
  };
  for (const candidate of sorted) {
    const candidateAnalysis = analyses.get(candidate.id)!;
    const possibleGroups = new Set<number>();
    for (const entityId of candidateAnalysis.entityIds)
      for (const groupIndex of groupsByEntity.get(`${candidate.category}|${entityId}`) ?? [])
        possibleGroups.add(groupIndex);
    let destinationIndex: number | undefined;
    let acceptedPairs: PulseClusterPairEvidence[] = [];
    for (const groupIndex of [...possibleGroups].sort((a, b) => a - b)) {
      const group = groups[groupIndex]!;
      const decisions = group.members.map((member) =>
        clusteringDecisionWithAnalysis(
          member,
          candidate,
          analyses.get(member.id)!,
          candidateAnalysis,
        ),
      );
      if (decisions.every((decision) => decision.eligible)) {
        destinationIndex = groupIndex;
        acceptedPairs = decisions.flatMap((decision) =>
          decision.eligible ? [decision.evidence] : [],
        );
        break;
      }
    }
    if (destinationIndex === undefined) {
      const groupIndex = groups.push({ members: [candidate], pairs: [] }) - 1;
      indexGroup(groupIndex, candidate);
    } else {
      const destination = groups[destinationIndex]!;
      destination.members.push(candidate);
      destination.pairs.push(...acceptedPairs);
      indexGroup(destinationIndex, candidate);
    }
  }
  return groups
    .map(({ members: grouped, pairs }) => {
      // The best-sourced member leads: direct feeds and reviewed outlets first.
      const members = [...grouped].sort(
        (left, right) => leadRank(left) - leadRank(right) || compareEvents(left, right),
      );
      const event = mergeMembers(members);
      const sameArticle = members.some((member) => layerOne.members.has(member.id));
      const basis = [
        ...(sameArticle ? ["same-article"] : []),
        ...new Set(pairs.map((pair) => pair.matchedBy)),
      ].sort();
      return {
        event,
        evidence: {
          version: VERSION,
          clustered: members.length > 1 || sameArticle,
          representativeEventId: members[0]!.id,
          memberEventIds: members.flatMap(
            (member) => layerOne.members.get(member.id) ?? [member.id],
          ),
          pairEvidence: pairs,
          basis: basis.length ? basis : ["No conservative cross-source match."],
        },
      } satisfies PulseEventCluster;
    })
    .sort((left, right) => compareEvents(right.event, left.event));
}
