// tz.js — タイムゾーン変換ユーティリティ
export const JST = 'Asia/Tokyo';

export const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

// 主要な旅行先タイムゾーンのプリセット
export const TZ_PRESETS = [
  { label: '日本', tz: 'Asia/Tokyo' },
  { label: '韓国（ソウル）', tz: 'Asia/Seoul' },
  { label: '台湾（台北）', tz: 'Asia/Taipei' },
  { label: '中国（上海・北京）', tz: 'Asia/Shanghai' },
  { label: '香港・マカオ', tz: 'Asia/Hong_Kong' },
  { label: 'シンガポール・マレーシア', tz: 'Asia/Singapore' },
  { label: 'タイ（バンコク）', tz: 'Asia/Bangkok' },
  { label: 'ベトナム', tz: 'Asia/Ho_Chi_Minh' },
  { label: 'インドネシア（バリ島）', tz: 'Asia/Makassar' },
  { label: 'インド', tz: 'Asia/Kolkata' },
  { label: 'UAE（ドバイ）', tz: 'Asia/Dubai' },
  { label: 'トルコ（イスタンブール）', tz: 'Europe/Istanbul' },
  { label: 'イギリス（ロンドン）', tz: 'Europe/London' },
  { label: 'フランス（パリ）', tz: 'Europe/Paris' },
  { label: 'イタリア（ローマ）', tz: 'Europe/Rome' },
  { label: 'スペイン（マドリード）', tz: 'Europe/Madrid' },
  { label: 'ドイツ・スイス・オランダ', tz: 'Europe/Berlin' },
  { label: '北欧（ヘルシンキ）', tz: 'Europe/Helsinki' },
  { label: 'アメリカ西海岸（LA）', tz: 'America/Los_Angeles' },
  { label: 'アメリカ東海岸（NY）', tz: 'America/New_York' },
  { label: 'ハワイ（ホノルル）', tz: 'Pacific/Honolulu' },
  { label: 'グアム・サイパン', tz: 'Pacific/Guam' },
  { label: 'オーストラリア（シドニー）', tz: 'Australia/Sydney' },
  { label: 'ニュージーランド', tz: 'Pacific/Auckland' },
];

export function allTimeZones() {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return TZ_PRESETS.map((p) => p.tz);
  }
}

// あるタイムゾーンの、その時刻におけるUTCオフセット（分）
export function tzOffsetMin(tz, date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return (asUTC - date.getTime()) / 60000;
}

// 壁時計時刻（'YYYY-MM-DD','HH:MM'）＋タイムゾーン → エポックms
export function wallToEpoch(dateStr, timeStr, tz) {
  const base = Date.parse(`${dateStr}T${timeStr || '00:00'}:00Z`);
  let off = tzOffsetMin(tz, new Date(base));
  off = tzOffsetMin(tz, new Date(base - off * 60000)); // DST境界の補正
  return base - off * 60000;
}

// エポックms → あるタイムゾーンの壁時計時刻
export function epochToWall(epoch, tz) {
  const dtf = new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
  const s = dtf.format(new Date(epoch)); // 'YYYY-MM-DD HH:mm'
  return { date: s.slice(0, 10), time: s.slice(11, 16) };
}

// タイムゾーン間の壁時計変換。dayDiff は入力日付に対する日ずれ（-1/0/+1…）
export function convertWall(dateStr, timeStr, fromTz, toTz) {
  const epoch = wallToEpoch(dateStr, timeStr, fromTz);
  const w = epochToWall(epoch, toTz);
  return { ...w, dayDiff: diffDays(dateStr, w.date) };
}

export function diffDays(from, to) {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000);
}

export function addDays(dateStr, n) {
  const d = new Date(Date.parse(dateStr + 'T00:00:00Z') + n * 86400000);
  return d.toISOString().slice(0, 10);
}

// 'YYYY-MM-DD' → '7/30(木)' 表記
export function fmtDateShort(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const wd = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${m}/${d}(${wd})`;
}

export function fmtDateLong(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const wd = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${y}年${m}月${d}日(${wd})`;
}

// 旅行日程の日付一覧
export function tripDays(startDate, endDate) {
  const days = [];
  if (!startDate) return days;
  let d = startDate;
  const end = endDate || startDate;
  let guard = 0;
  while (d <= end && guard < 90) {
    days.push(d);
    d = addDays(d, 1);
    guard++;
  }
  return days;
}

export function todayStr() {
  return epochToWall(Date.now(), JST).date;
}
