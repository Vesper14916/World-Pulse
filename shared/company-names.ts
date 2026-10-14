/**
 * Reporting names for US-listed companies.
 *
 * Headlines rarely use a registrant's legal name ("TAIWAN SEMICONDUCTOR
 * MANUFACTURING CO LTD"). These helpers derive the short names reporters use
 * and add reviewed Chinese names, while keeping ambiguous everyday words
 * behind a context requirement. Matching remains a direct-mention rule.
 */

/** Reviewed reporting names (mostly Chinese, plus brand acronyms) for widely covered US-listed companies, by ticker. */
export const CHINESE_NAMES: Record<string, string[]> = {
  AAPL: ['苹果公司', '蘋果公司'],
  MSFT: ['微软', '微軟'],
  NVDA: ['英伟达', '輝達', '英偉達'],
  AMZN: ['亚马逊', '亞馬遜'],
  GOOGL: ['谷歌', 'Google'],
  GOOG: ['谷歌', 'Google'],
  META: ['Meta公司', '脸书母公司'],
  TSLA: ['特斯拉'],
  TSM: ['TSMC', '台积电', '台積電'],
  AVGO: ['博通'],
  AMD: ['AMD', '超威半导体', '超微半导体', 'AMD公司'],
  INTC: ['英特尔', '英特爾'],
  QCOM: ['高通'],
  MU: ['美光'],
  ASML: ['阿斯麦', '艾司摩尔', 'ASML'],
  ORCL: ['甲骨文'],
  NFLX: ['奈飞', '网飞', '網飛'],
  ADBE: ['Adobe公司', '奥多比'],
  CRM: ['Salesforce', '赛富时'],
  IBM: ['IBM', 'IBM公司'],
  CSCO: ['思科'],
  PLTR: ['Palantir', '帕兰提尔'],
  'BRK.B': ['伯克希尔', '伯克希爾'],
  JPM: ['摩根大通'],
  GS: ['高盛'],
  MS: ['摩根士丹利', '大摩'],
  BAC: ['美国银行', '美國銀行'],
  C: ['花旗'],
  WFC: ['富国银行'],
  BLK: ['贝莱德', '貝萊德'],
  V: ['Visa公司'],
  MA: ['万事达', '萬事達'],
  WMT: ['沃尔玛', '沃爾瑪'],
  COST: ['好市多', '开市客', '開市客'],
  KO: ['可口可乐', '可口可樂'],
  PEP: ['百事公司'],
  MCD: ['麦当劳', '麥當勞'],
  SBUX: ['星巴克'],
  NKE: ['耐克'],
  DIS: ['迪士尼'],
  BA: ['波音'],
  LMT: ['洛克希德·马丁', '洛克希德马丁'],
  XOM: ['埃克森美孚'],
  CVX: ['雪佛龙', '雪佛龍'],
  PFE: ['辉瑞', '輝瑞'],
  MRNA: ['莫德纳'],
  JNJ: ['强生', '強生'],
  LLY: ['礼来', '禮來'],
  NVO: ['诺和诺德', '諾和諾德'],
  MRK: ['默沙东', '默克'],
  ABBV: ['艾伯维'],
  UNH: ['联合健康', '聯合健康'],
  BABA: ['阿里巴巴'],
  JD: ['京东', '京東'],
  PDD: ['拼多多'],
  BIDU: ['百度'],
  NIO: ['蔚来', '蔚來'],
  XPEV: ['小鹏汽车', '小鵬汽車'],
  LI: ['理想汽车', '理想汽車'],
  TME: ['腾讯音乐', '騰訊音樂'],
  NTES: ['网易', '網易'],
  BILI: ['哔哩哔哩', 'B站'],
  TCOM: ['携程', '攜程'],
  ARM: ['Arm公司', '安谋'],
  SMCI: ['超微电脑', '超微電腦'],
  DELL: ['戴尔', '戴爾'],
  HPQ: ['惠普'],
  UBER: ['优步', '優步'],
  ABNB: ['爱彼迎'],
  COIN: ['Coinbase'],
  MSTR: ['微策略', 'Strategy公司'],
  AMAT: ['应用材料', '應用材料'],
  LRCX: ['泛林集团', '泛林'],
  KLAC: ['科磊'],
  TXN: ['德州仪器', '德州儀器'],
  MRVL: ['迈威尔', '美满电子'],
  COHR: ['高意'],
  GE: ['通用电气', '通用電氣'],
  GM: ['通用汽车', '通用汽車'],
  F: ['福特汽车', '福特汽車'],
  CAT: ['卡特彼勒'],
  HON: ['霍尼韦尔'],
  T: ['AT&T'],
  VZ: ['威瑞森'],
  CMCSA: ['康卡斯特'],
  RIVN: ['Rivian'],
  LCID: ['Lucid'],
  SNOW: ['Snowflake'],
  CRWD: ['CrowdStrike'],
  SHOP: ['Shopify'],
  SPOT: ['Spotify'],
  IONQ: ['IonQ'],
  ASTS: ['AST SpaceMobile'],
};

/**
 * Names that are also everyday words. They only count as a company mention
 * when the same text also carries a company-specific context term.
 */
export const CONTEXT_REQUIRED: Record<string, { name: RegExp; context: RegExp }> = {
  AAPL: { name: /\bApple\b|苹果|蘋果/i, context: /\b(?:iPhone|iPad|MacBook|iOS|AAPL|Tim Cook|App Store|Vision Pro)\b|库克|股价/i },
  AMZN: { name: /\bAmazon\b|亚马逊|亞馬遜/i, context: /\b(?:AWS|Amazon Web Services|AMZN|Prime Video|Jassy|Bezos)\b/i },
  ORCL: { name: /\bOracle\b|甲骨文/i, context: /\b(?:ORCL|Oracle Cloud|database|earnings|Ellison|OCI)\b|财报|云计算|数据库/i },
  META: { name: /\bMeta\b/, context: /\b(?:Facebook|Instagram|WhatsApp|Zuckerberg|Llama|META|Threads|Quest)\b|扎克伯格/i },
  V: { name: /\bVisa\b/, context: /\b(?:payments?|card|NYSE:\s*V|Mastercard|transaction)\b/i },
  T: { name: /\bAT&T\b/, context: /./ },
  GOOGL: { name: /\bGoogle\b/, context: /./ },
  C: { name: /\bCiti(?:group|bank)?\b/, context: /./ },
  F: { name: /\bFord\b/, context: /\b(?:Motor|vehicles?|cars?|EV|F-150|Mustang|Farley|recall)\b/i },
  GE: { name: /\bGE\b/, context: /\b(?:Aerospace|Vernova|HealthCare|jet engines?)\b/i },
  BA: { name: /\bBoeing\b/, context: /./ },
};

const LEGAL_SUFFIX =
  /[\s,]+(?:inc|incorporated|corp|corporation|co|company|ltd|limited|plc|llc|lp|l\.p|holdings?|group|sa|s\.a|nv|n\.v|ag|se|asa|ab|oyj|spa|s\.p\.a|kk|bhd|tbk|class [a-c]|cl [a-c]|common stock|ordinary shares|american depositary shares|ads|adr|sponsored adr|new|\/de|\/md|\/nv|\/ca|\/new|the)\.?$/i;
const WEAK_WORDS = new Set([
  'the', 'and', 'of', 'international', 'global', 'technologies', 'technology', 'systems',
  'industries', 'enterprises', 'solutions', 'services', 'partners', 'capital', 'financial',
  'resources', 'brands', 'labs', 'bancorp', 'trust', 'fund', 'etf', 'semiconductor', 'energy',
  'therapeutics', 'pharmaceuticals', 'bio', 'networks', 'communications', 'entertainment',
]);
/** Everyday words that must never match on their own. */
const COMMON_WORDS = new Set([
  'apple', 'amazon', 'oracle', 'meta', 'visa', 'target', 'block', 'snap', 'square', 'gap', 'shell',
  'ball', 'match', 'zoom', 'unity', 'progressive', 'general', 'american', 'united', 'first',
  'national', 'southern', 'eastern', 'western', 'northern', 'pioneer', 'discovery', 'fox',
  'news', 'coherent', 'vertex', 'twist', 'chewy', 'root', 'lumen', 'ally', 'fortune',
  'monday', 'corning', 'caterpillar', 'mosaic', 'crown', 'eagle', 'booking', 'expedia', 'ford',
  'jack', 'dollar', 'energy', 'global', 'digital', 'alphabet', 'strategy', 'arm',
]);

function titleCase(value: string): string {
  if (value !== value.toUpperCase()) return value;
  return value
    .toLowerCase()
    .replace(/\b([a-z])/g, (letter) => letter.toUpperCase())
    .replace(/\b(Ai|Amd|Ibm|Asml|Usa|Us|Nv|Ag|Sa|Plc|Llc|Adr|Ads)\b/g, (word) => word.toUpperCase());
}
function stripSuffixes(value: string): string {
  let current = value.replace(/\s+/g, ' ').trim();
  for (let pass = 0; pass < 4; pass++) {
    const next = current.replace(LEGAL_SUFFIX, '').replace(/[\s,&-]+$/, '').trim();
    if (next === current || next.length < 2) break;
    current = next;
  }
  return current;
}

export interface DerivedNames {
  /** Safe to match on their own (word-bounded, case-insensitive). */
  names: string[];
  /** Everyday words that need a company context term in the same text. */
  contextual: string[];
}
/**
 * Short reporting names derived from a registrant or profile name:
 * "TAIWAN SEMICONDUCTOR MANUFACTURING CO LTD" → "Taiwan Semiconductor
 * Manufacturing", "Taiwan Semiconductor".
 */
export function deriveReportingNames(legalName: string, extra: string[] = []): DerivedNames {
  const names = new Set<string>();
  const contextual = new Set<string>();
  for (const raw of [legalName, ...extra]) {
    if (!raw?.trim()) continue;
    const pretty = titleCase(raw.trim());
    const core = stripSuffixes(pretty.replace(/\s*\([^)]*\)\s*/g, ' '));
    if (!core) continue;
    const words = core.split(/\s+/);
    const add = (value: string) => {
      const trimmed = value.trim();
      if (trimmed.length < 3) return;
      const lower = trimmed.toLowerCase();
      if (words.length === 1 || !trimmed.includes(' ')) {
        if (COMMON_WORDS.has(lower) || WEAK_WORDS.has(lower)) contextual.add(trimmed);
        else names.add(trimmed);
      } else names.add(trimmed);
    };
    add(core);
    if (words.length >= 3) {
      const firstTwo = words.slice(0, 2).join(' ');
      if (!words.slice(0, 2).every((word) => WEAK_WORDS.has(word.toLowerCase()))) add(firstTwo);
    }
    // "Nvidia Corp" style: the first distinctive word alone, e.g. "Nvidia".
    if (words.length === 2 && WEAK_WORDS.has(words[1]!.toLowerCase())) add(words[0]!);
  }
  return { names: [...names], contextual: [...contextual] };
}

const COMPANY_CONTEXT =
  /\b(?:shares?|stock|stocks|earnings|revenue|CEO|chief executive|investors?|analysts?|quarter|guidance|Inc\.?|Corp\.?|NASDAQ|NYSE|IPO|valuation|market cap|acquisition|deal)\b|股价|股份|财报|营收|公司/i;
export function hasCompanyContext(text: string): boolean {
  return COMPANY_CONTEXT.test(text);
}

/** Everyday brand names that differ from the listed company's name. */
const BRANDS: Record<string, string[]> = {
  GOOGL: ['google', 'alphabet', 'youtube', 'waymo'],
  META: ['facebook', 'instagram', 'whatsapp', 'meta'],
  TSM: ['tsmc'],
  BRK_B: [],
  AMZN: ['aws', 'amazon'],
  AAPL: ['apple', 'iphone'],
  MSFT: ['microsoft', 'azure', 'openai partner'],
  NVDA: ['nvidia'],
  BABA: ['alibaba', 'taobao', 'aliyun'],
  PDD: ['temu', 'pinduoduo'],
  JD: ['jd.com', 'jingdong'],
  BIDU: ['baidu'],
  TCOM: ['trip.com', 'ctrip'],
  NTES: ['netease'],
  BILI: ['bilibili'],
  UBER: ['uber'],
  ABNB: ['airbnb'],
  SBUX: ['starbucks'],
  MCD: ["mcdonald's", 'mcdonalds'],
  KO: ['coca-cola', 'coke'],
  DIS: ['disney'],
  NKE: ['nike'],
  NFLX: ['netflix'],
  ASML: ['asml'],
  AVGO: ['broadcom'],
  AMD: ['amd'],
  INTC: ['intel'],
  QCOM: ['qualcomm'],
  MU: ['micron'],
  SMCI: ['supermicro', 'super micro'],
  PLTR: ['palantir'],
  TSLA: ['tesla'],
};

/** Tickers whose reviewed or brand names match a search query ("tsmc", "台积电", "google"). */
export function symbolsForName(query: string): string[] {
  const q = query.normalize('NFKC').trim().toLowerCase();
  if (q.length < 2) return [];
  const found = new Set<string>();
  const consider = (symbol: string, names: string[]) => {
    for (const name of names) {
      const lower = name.normalize('NFKC').toLowerCase();
      if (lower === q || (q.length >= 3 && lower.startsWith(q))) found.add(symbol.replace('_', '.'));
    }
  };
  for (const [symbol, names] of Object.entries(CHINESE_NAMES)) consider(symbol, names);
  for (const [symbol, names] of Object.entries(BRANDS)) consider(symbol, names);
  return [...found].slice(0, 8);
}
