/** Geographic observation areas, not claims of active war or navigational charts. */
export interface StrategicArea {
  id: string;
  name: string;
  short: string;
  bounds: [number, number, number, number];
  countries: string[];
  aliases: string[];
  waterway?: boolean;
  continuous?: boolean;
}
export const STRATEGIC_AREAS: readonly StrategicArea[] = [
  {
    id: 'global',
    name: 'Global overview',
    short: 'GLOBAL',
    bounds: [-178, -55, 178, 76],
    countries: [],
    aliases: [],
  },
  {
    id: 'gulf',
    name: 'Persian Gulf & Gulf of Oman',
    short: 'GULF',
    bounds: [46, 21, 62, 32],
    countries: ['IR', 'IQ', 'KW', 'QA', 'BH', 'AE', 'OM', 'SA'],
    aliases: ['persian gulf', 'gulf of oman', '波斯湾', '阿曼湾'],
  },
  {
    id: 'red_sea',
    name: 'Red Sea corridor',
    short: 'RED SEA',
    bounds: [31, 10, 47, 31.5],
    countries: ['YE', 'ER', 'DJ', 'EG', 'SD'],
    aliases: ['red sea', '红海', 'houthi', '胡塞'],
  },
  {
    id: 'eastern_europe',
    name: 'Eastern Europe',
    short: 'E. EUROPE',
    bounds: [21, 42, 43, 56],
    countries: ['UA', 'RU', 'BY', 'MD'],
    aliases: ['ukraine', '乌克兰', '乌军', '俄军'],
  },
  {
    id: 'east_asia',
    name: 'East Asia',
    short: 'E. ASIA',
    bounds: [106, 15, 143, 43],
    countries: ['CN', 'TW', 'JP', 'KR', 'KP'],
    aliases: ['south china sea', '南海', 'taiwan strait', '台湾海峡'],
  },
  {
    id: 'hormuz_strait',
    name: 'Strait of Hormuz',
    short: 'HORMUZ',
    bounds: [55, 24.5, 58.5, 27.8],
    countries: [],
    aliases: ['hormuz', '霍尔木兹'],
    waterway: true,
    continuous: true,
  },
  {
    id: 'bab_el_mandeb',
    name: 'Bab el-Mandeb',
    short: 'BAB EL-MANDEB',
    bounds: [41.5, 11, 45, 14],
    countries: [],
    aliases: ['bab el-mandeb', 'bab al-mandab', 'bab-el-mandeb', '曼德海峡'],
    waterway: true,
    continuous: true,
  },
  {
    id: 'suez',
    name: 'Suez Canal',
    short: 'SUEZ',
    bounds: [31.8, 29.5, 33.2, 31.7],
    countries: [],
    aliases: ['suez', '苏伊士'],
    waterway: true,
    continuous: true,
  },
  {
    id: 'malacca_strait',
    name: 'Strait of Malacca',
    short: 'MALACCA',
    bounds: [98, 0.5, 104.5, 6.5],
    countries: [],
    aliases: ['malacca', '马六甲'],
    waterway: true,
    continuous: true,
  },
  {
    id: 'panama',
    name: 'Panama Canal',
    short: 'PANAMA',
    bounds: [-80.2, 8.4, -79.1, 9.7],
    countries: [],
    aliases: ['panama canal', '巴拿马运河'],
    waterway: true,
  },
  {
    id: 'taiwan_strait',
    name: 'Taiwan Strait',
    short: 'TAIWAN',
    bounds: [117, 22, 121.5, 26.5],
    countries: [],
    aliases: ['taiwan strait', '台湾海峡', '台海'],
    waterway: true,
  },
  {
    id: 'cape_of_good_hope',
    name: 'Cape of Good Hope',
    short: 'CAPE',
    bounds: [16, -36, 21, -32],
    countries: [],
    aliases: ['cape of good hope', '好望角'],
    waterway: true,
  },
  {
    id: 'gibraltar',
    name: 'Strait of Gibraltar',
    short: 'GIBRALTAR',
    bounds: [-6.5, 35, -4.5, 36.5],
    countries: [],
    aliases: ['gibraltar', '直布罗陀'],
    waterway: true,
  },
  {
    id: 'bosphorus',
    name: 'Bosporus Strait',
    short: 'BOSPORUS',
    bounds: [28.5, 40.6, 29.6, 41.6],
    countries: [],
    aliases: ['bosporus', 'bosphorus', '博斯普鲁斯'],
    waterway: true,
  },
  {
    id: 'korea_strait',
    name: 'Korea Strait',
    short: 'KOREA',
    bounds: [127, 32, 131, 35.5],
    countries: [],
    aliases: ['korea strait', 'tsushima strait', '对马海峡'],
    waterway: true,
  },
  {
    id: 'dover_strait',
    name: 'Dover Strait',
    short: 'DOVER',
    bounds: [0, 50, 2.5, 52],
    countries: [],
    aliases: ['dover strait', '多佛海峡'],
    waterway: true,
  },
  {
    id: 'kerch_strait',
    name: 'Kerch Strait',
    short: 'KERCH',
    bounds: [35.5, 44.7, 37.2, 46],
    countries: [],
    aliases: ['kerch', '刻赤'],
    waterway: true,
  },
  {
    id: 'lombok_strait',
    name: 'Lombok Strait',
    short: 'LOMBOK',
    bounds: [115, -9, 116.5, -7.5],
    countries: [],
    aliases: ['lombok', '龙目海峡'],
    waterway: true,
  },
];
export const strategicArea = (id: string) => STRATEGIC_AREAS.find((a) => a.id === id);
export function inArea(lon: number, lat: number, area: StrategicArea): boolean {
  const [w, s, e, n] = area.bounds;
  return lon >= w && lon <= e && lat >= s && lat <= n;
}
