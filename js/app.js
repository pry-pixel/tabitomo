// app.js — たびとも：旅の日程管理アプリ UI本体
import { initStore, newId } from './store.js';
import {
  JST, TZ_PRESETS, allTimeZones, convertWall, wallToEpoch, fmtDateShort,
  fmtDateLong, tripDays, todayStr, diffDays,
} from './tz.js';
import {
  parseGmapsUrl, resolveGmapsPage, geocode, parseTakeoutCsv, gmapsSearchUrl,
} from './gmaps.js';

/* ---------------- 定数 ---------------- */
const CATS = [
  { k: 'flight', e: '✈️', l: '飛行機' },
  { k: 'train', e: '🚄', l: '電車' },
  { k: 'bus', e: '🚌', l: 'バス・車' },
  { k: 'walk', e: '🚶', l: '移動' },
  { k: 'food', e: '🍜', l: 'ごはん' },
  { k: 'cafe', e: '🍰', l: 'カフェ' },
  { k: 'spot', e: '🏯', l: '観光' },
  { k: 'fun', e: '🎡', l: 'あそび' },
  { k: 'hotel', e: '🏨', l: 'ホテル' },
  { k: 'onsen', e: '♨️', l: '温泉' },
  { k: 'shop', e: '🛍️', l: '買い物' },
  { k: 'photo', e: '📷', l: '写真' },
  { k: 'star', e: '⭐', l: 'その他' },
];
const catOf = (k) => CATS.find((c) => c.k === k) || CATS[CATS.length - 1];

const COVER_EMOJIS = ['✈️', '🗼', '🗻', '🏝️', '🏰', '⛩️', '🎡', '🍜', '🍣', '🥐', '🍕', '🌸', '🍁', '🚄', '🛳️', '🎒', '🌊', '⛺️', '🐠', '🎿', '🌺', '🦒', '🕌', '🗽'];

const THEMES = {
  coral: ['#FF7B7B', '#FFB199'],
  sunset: ['#FF9A62', '#FFD27A'],
  lemon: ['#FFC94D', '#FFE9A0'],
  leaf: ['#7BC96F', '#B8E39A'],
  sea: ['#3EC9BE', '#8FE7D2'],
  sky: ['#5AA9FF', '#9CD2FF'],
  grape: ['#9B7EDE', '#C9B6F2'],
  sakura: ['#FF8FB1', '#FFC9DB'],
};
const MEMBER_COLORS = ['#FF6B6B', '#4ECDC4', '#5AA9FF', '#FFA94D', '#9B7EDE', '#63C132', '#FF8FB1', '#20A39E'];

/* ---------------- 状態 ---------------- */
let store = null;
const S = {
  route: { view: 'home' },
  trips: [],
  trip: null, events: [], places: [], members: {},
  day: null, timeView: 'local', placeView: 'list',
  geoResults: [], csv: null,
  mapState: null,
  loading: true,
  joinError: null,
};
let subs = [];
let map = null, mapMarkers = [];

/* ---------------- ユーティリティ ---------------- */
const $ = (sel) => document.querySelector(sel);
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function toast(msg, ms = 2400) {
  const t = $('#toast');
  t.innerHTML = `<div class="toast-pill">${esc(msg)}</div>`;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}
function memberColor(uid) {
  let h = 0;
  for (const ch of String(uid)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return MEMBER_COLORS[h % MEMBER_COLORS.length];
}
function themeGrad(key) {
  const [a, b] = THEMES[key] || THEMES.coral;
  return `linear-gradient(135deg, ${a}, ${b})`;
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ---------------- ルーティング ---------------- */
function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const parts = h.split('/').filter(Boolean);
  if (parts[0] === 'join' && parts[1]) return { view: 'join', tripId: parts[1] };
  if (parts[0] === 'trip' && parts[1]) {
    return { view: 'trip', tripId: parts[1], tab: parts[2] || 'plan' };
  }
  return { view: 'home' };
}
function nav(hash) { location.hash = hash; }

function unsubAll() {
  subs.forEach((u) => { try { u(); } catch { } });
  subs = [];
}

function onRoute() {
  const r = parseHash();
  const prevTripId = S.route.tripId;
  S.route = r;
  destroyMap();
  if (r.view === 'home') {
    unsubAll();
    S.trip = null;
    subs.push(store.subMyTrips((trips) => { S.trips = trips; render(); }));
  } else if (r.view === 'trip') {
    if (r.tripId !== prevTripId) {
      unsubAll();
      S.trip = null; S.events = []; S.places = []; S.members = {}; S.day = null;
      S.timeView = 'local'; S.placeView = 'list'; S.mapState = null;
      subs.push(store.subTrip(r.tripId, (t) => {
        S.trip = t;
        if (t && !S.day) {
          const days = tripDays(t.startDate, t.endDate);
          const today = todayStr();
          S.day = days.includes(today) ? today : days[0] || null;
        }
        render();
      }));
      subs.push(store.subEvents(r.tripId, (e) => { S.events = e; render(); }));
      subs.push(store.subPlaces(r.tripId, (p) => { S.places = p; render(); }));
      subs.push(store.subMembers(r.tripId, (m) => { S.members = m; render(); }));
    }
    render();
  } else if (r.view === 'join') {
    unsubAll();
    handleJoin(r.tripId);
  }
  render();
}

async function handleJoin(tripId) {
  S.joinError = null;
  render();
  if (store.mode !== 'cloud') {
    S.joinError = 'この端末はまだ共有機能が有効になっていません（Firebase未設定）。';
    render(); return;
  }
  if (!store.identity.name || store.identity.name === 'ゲスト') {
    openNameSheet(() => handleJoin(tripId));
    return;
  }
  try {
    const t = await store.joinTrip(tripId);
    toast(`「${t.title}」に参加しました！🎉`);
    nav(`/trip/${tripId}`);
  } catch (e) {
    S.joinError = e.message || '参加できませんでした。';
    render();
  }
}

/* ---------------- 時刻表示ヘルパー ---------------- */
function zoneOf(mode, trip) { return mode === 'jst' ? JST : (trip.tz || JST); }

function eventEpoch(ev, trip) {
  if (!ev.time) return Infinity;
  try { return wallToEpoch(ev.date, ev.time, zoneOf(ev.timeMode, trip)); } catch { return Infinity; }
}

function dayNote(diff) {
  if (!diff) return '';
  return diff > 0 ? `翌${diff > 1 ? diff + '' : ''}日` : '前日';
}

// 表示用: {primary, primaryNote, secondary} を返す
function eventTimeView(ev, trip) {
  if (!ev.time) return null;
  const overseas = (trip.tz || JST) !== JST;
  const entered = zoneOf(ev.timeMode, trip);
  const viewTz = S.timeView === 'jst' ? JST : (trip.tz || JST);
  const otherTz = viewTz === JST ? (trip.tz || JST) : JST;

  const conv = (tz) => {
    if (tz === entered) return { time: ev.time, dayDiff: 0, end: ev.endTime || null };
    const c = convertWall(ev.date, ev.time, entered, tz);
    let end = null;
    if (ev.endTime) end = convertWall(ev.date, ev.endTime, entered, tz).time;
    return { time: c.time, dayDiff: c.dayDiff, end };
  };
  const v = conv(viewTz);
  let primary = v.time;
  if (v.end) primary += `〜${v.end}`;
  const result = { primary, primaryNote: dayNote(v.dayDiff), secondary: null };
  if (overseas) {
    const o = conv(otherTz);
    const label = otherTz === JST ? '日本' : '現地';
    result.secondary = `${label} ${o.time}${o.end ? '〜' + o.end : ''}${o.dayDiff ? ' ' + dayNote(o.dayDiff) : ''}`;
  }
  return result;
}

/* ---------------- レンダリング ---------------- */
function render() {
  const app = $('#app');
  if (S.loading) { app.innerHTML = `<div class="boot">🧳<br>じゅんびちゅう…</div>`; return; }
  if (S.route.view === 'home') app.innerHTML = renderHome();
  else if (S.route.view === 'trip') app.innerHTML = renderTrip();
  else if (S.route.view === 'join') app.innerHTML = renderJoin();
  afterRender();
}

function afterRender() {
  if (S.route.view === 'trip' && S.route.tab === 'places' && S.placeView === 'map') {
    initMap();
  }
}

/* ----- ホーム ----- */
function renderHome() {
  const id = store.identity;
  const today = todayStr();
  const upcoming = S.trips.filter((t) => !t._error && (t.endDate || t.startDate || '9999') >= today);
  const past = S.trips.filter((t) => !t._error && (t.endDate || t.startDate || '9999') < today).reverse();
  const broken = S.trips.filter((t) => t._error);

  const accountChip = store.mode === 'cloud'
    ? (id.isGoogle
      ? `<button class="chip chip-ghost" data-action="account-menu">👤 ${esc(id.name)}</button>`
      : `<button class="chip chip-accent" data-action="google-login">Googleでログイン</button>`)
    : `<span class="chip chip-ghost">📱 この端末に保存中</span>`;

  const card = (t) => `
    <button class="trip-card" data-action="open-trip" data-id="${esc(t.id)}" style="background:${themeGrad(t.theme)}">
      <span class="trip-card-emoji">${esc(t.emoji || '✈️')}</span>
      <span class="trip-card-body">
        <span class="trip-card-title">${esc(t.title)}</span>
        <span class="trip-card-meta">${esc(t.dest || '')}${t.startDate ? ' ・ ' + fmtDateShort(t.startDate) + (t.endDate && t.endDate !== t.startDate ? '〜' + fmtDateShort(t.endDate) : '') : ''}</span>
      </span>
      <span class="trip-card-badges">${t.isShared ? '<span class="badge badge-share">👥 共有中</span>' : '<span class="badge">🔒 じぶん用</span>'}</span>
    </button>`;

  const empty = !S.trips.length ? `
    <div class="empty">
      <div class="empty-emoji">🗺️</div>
      <p>まだ旅がありません。<br>「＋」から最初の旅をつくりましょう！</p>
    </div>` : '';

  return `
  <div class="page home">
    <header class="home-head">
      <div class="logo">🧳 たびとも</div>
      <p class="tagline">旅の計画を、じぶんでも、みんなでも。</p>
      <div class="home-account">${accountChip}</div>
    </header>
    ${store.mode === 'cloud' && !id.isGoogle && S.trips.length ? `
      <div class="banner">💡 Googleでログインすると、PCとiPhoneで同じ旅を見られます
        <button class="chip chip-accent" data-action="google-login">ログイン</button></div>` : ''}
    ${empty}
    ${upcoming.length ? `<h2 class="sec-title">これからの旅 🛫</h2><div class="trip-list">${upcoming.map(card).join('')}</div>` : ''}
    ${past.length ? `<h2 class="sec-title">おもいでの旅 📔</h2><div class="trip-list past">${past.map(card).join('')}</div>` : ''}
    ${broken.length ? `<div class="trip-list">${broken.map((t) => `
      <div class="trip-card broken">
        <span class="trip-card-body"><span class="trip-card-title">アクセスできない旅行</span>
        <span class="trip-card-meta">共有が解除されたか、削除されました</span></span>
        <button class="chip" data-action="remove-ref" data-id="${esc(t.id)}">一覧から外す</button>
      </div>`).join('')}</div>` : ''}
    <button class="fab" data-action="new-trip" aria-label="新しい旅行">＋</button>
  </div>`;
}

/* ----- 参加画面 ----- */
function renderJoin() {
  return `
  <div class="page join">
    <div class="join-box">
      <div class="empty-emoji">💌</div>
      ${S.joinError
      ? `<p class="join-err">${esc(S.joinError)}</p><button class="btn btn-primary" data-action="nav-home">ホームへ</button>`
      : `<p>旅のしおりに参加しています…</p>`}
    </div>
  </div>`;
}

/* ----- 旅行画面 ----- */
function renderTrip() {
  const t = S.trip;
  if (!t) {
    return `<div class="page"><div class="empty"><div class="empty-emoji">🔍</div>
      <p>旅行を読み込んでいます…<br>表示されない場合はアクセス権がないか、削除されています。</p>
      <button class="btn" data-action="nav-home">ホームへ</button></div></div>`;
  }
  const tab = S.route.tab || 'plan';
  const overseas = (t.tz || JST) !== JST;
  const tzLabel = overseas ? (TZ_PRESETS.find((p) => p.tz === t.tz)?.label || t.tz) : '';
  const memberAvatars = Object.entries(S.members).map(([uid, m]) =>
    `<span class="avatar" style="background:${memberColor(uid)}" title="${esc(m.name)}">${esc((m.name || '?').slice(0, 1))}</span>`).join('');

  let body = '';
  if (tab === 'plan') body = renderPlanTab(t, overseas);
  else if (tab === 'places') body = renderPlacesTab(t);
  else body = renderSettingsTab(t, overseas);

  const fab = tab === 'plan'
    ? `<button class="fab" data-action="add-event">＋</button>`
    : tab === 'places' ? `<button class="fab" data-action="add-place-menu">＋</button>` : '';

  return `
  <div class="page trip">
    <header class="trip-head" style="background:${themeGrad(t.theme)}">
      <div class="trip-head-top">
        <button class="backbtn" data-action="nav-home" aria-label="もどる">‹</button>
        <div class="avatars">${memberAvatars}</div>
      </div>
      <div class="trip-head-main">
        <span class="trip-emoji">${esc(t.emoji || '✈️')}</span>
        <div>
          <h1>${esc(t.title)}</h1>
          <div class="trip-meta">
            ${esc(t.dest || '')}${t.startDate ? ' ・ ' + fmtDateShort(t.startDate) + (t.endDate && t.endDate !== t.startDate ? '〜' + fmtDateShort(t.endDate) : '') : ''}
            ${overseas ? `<span class="tz-badge">🕒 ${esc(tzLabel)}</span>` : ''}
            ${t.isShared ? '<span class="tz-badge">👥 共有中</span>' : ''}
          </div>
        </div>
      </div>
    </header>
    <main class="trip-body">${body}</main>
    ${fab}
    <nav class="tabbar">
      <button class="tabbtn ${tab === 'plan' ? 'on' : ''}" data-action="tab" data-tab="plan"><span>📖</span>しおり</button>
      <button class="tabbtn ${tab === 'places' ? 'on' : ''}" data-action="tab" data-tab="places"><span>📍</span>ばしょ</button>
      <button class="tabbtn ${tab === 'settings' ? 'on' : ''}" data-action="tab" data-tab="settings"><span>⚙️</span>せってい</button>
    </nav>
  </div>`;
}

/* ----- しおりタブ ----- */
function renderPlanTab(t, overseas) {
  const days = tripDays(t.startDate, t.endDate);
  const extraDates = [...new Set(S.events.map((e) => e.date))].filter((d) => d && !days.includes(d)).sort();
  if (S.day && !days.includes(S.day) && !extraDates.includes(S.day)) S.day = days[0] || null;
  const allDays = [...days, ...extraDates];
  if (!S.day) S.day = allDays[0] || null;

  const chips = allDays.map((d) => {
    const n = days.indexOf(d);
    const label = n >= 0 ? `${n + 1}日目` : '⚠ 日程外';
    return `<button class="daychip ${S.day === d ? 'on' : ''}" data-action="day" data-date="${d}">
      <span class="daychip-num">${label}</span><span class="daychip-date">${fmtDateShort(d)}</span></button>`;
  }).join('');

  const dayEvents = S.events
    .filter((e) => e.date === S.day)
    .sort((a, b) => {
      const ea = eventEpoch(a, t), eb = eventEpoch(b, t);
      if (ea !== eb) return ea - eb;
      return (a.createdAt || 0) - (b.createdAt || 0);
    });

  const timeline = dayEvents.length ? dayEvents.map((ev) => {
    const c = catOf(ev.cat);
    const tv = eventTimeView(ev, t);
    const place = ev.placeId ? S.places.find((p) => p.id === ev.placeId) : null;
    return `
    <div class="ev" data-action="edit-event" data-id="${esc(ev.id)}">
      <div class="ev-time">
        ${tv ? `<span class="ev-time-main">${tv.primaryNote ? `<em>${tv.primaryNote}</em>` : ''}${esc(tv.primary)}</span>
        ${tv.secondary ? `<span class="ev-time-sub">${esc(tv.secondary)}</span>` : ''}` : '<span class="ev-time-main dim">--:--</span>'}
      </div>
      <div class="ev-line"><span class="ev-dot cat-${esc(ev.cat || 'star')}">${c.e}</span></div>
      <div class="ev-card">
        <div class="ev-title">${esc(ev.title)}</div>
        ${place ? `<a class="ev-place" href="${esc(gmapsSearchUrl(place))}" target="_blank" rel="noopener" onclick="event.stopPropagation()">📍 ${esc(place.name)}</a>` : ''}
        ${ev.memo ? `<div class="ev-memo">${esc(ev.memo)}</div>` : ''}
        ${ev.url ? `<a class="ev-url" href="${esc(ev.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">🔗 リンクを開く</a>` : ''}
      </div>
    </div>`;
  }).join('') : `
    <div class="empty small"><div class="empty-emoji">🐾</div>
      <p>この日の予定はまだありません。<br>右下の「＋」から追加できます。</p></div>`;

  return `
  <div class="plan">
    <div class="daychips">${chips}</div>
    ${overseas ? `
    <div class="seg">
      <button class="seg-btn ${S.timeView === 'local' ? 'on' : ''}" data-action="timeview" data-v="local">現地時間</button>
      <button class="seg-btn ${S.timeView === 'jst' ? 'on' : ''}" data-action="timeview" data-v="jst">日本時間</button>
    </div>` : ''}
    ${S.day ? `<div class="day-title">${fmtDateLong(S.day)}</div>` : ''}
    <div class="timeline">${timeline}</div>
  </div>`;
}

/* ----- ばしょタブ ----- */
function renderPlacesTab(t) {
  const list = [...S.places].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const withPos = list.filter((p) => p.lat != null && p.lng != null);

  const cards = list.length ? list.map((p) => {
    const c = catOf(p.cat);
    const used = S.events.some((e) => e.placeId === p.id);
    return `
    <div class="place ${used ? 'used' : ''}">
      <button class="place-main" data-action="edit-place" data-id="${esc(p.id)}">
        <span class="place-emoji cat-${esc(p.cat || 'star')}">${c.e}</span>
        <span class="place-body">
          <span class="place-name">${esc(p.name)} ${used ? '<span class="badge badge-mini">予定に入り済み✓</span>' : ''}</span>
          ${p.memo ? `<span class="place-memo">${esc(p.memo)}</span>` : ''}
          ${p.lat == null ? '<span class="place-warn">📡 位置情報なし（タップして検索）</span>' : ''}
        </span>
      </button>
      <div class="place-actions">
        <button class="chip" data-action="place-to-plan" data-id="${esc(p.id)}">📖 予定に入れる</button>
        <button class="chip" data-action="open-gmap" data-id="${esc(p.id)}">🗺️ Googleマップ</button>
      </div>
    </div>`;
  }).join('') : `
    <div class="empty small"><div class="empty-emoji">📍</div>
    <p>気になる場所をどんどん集めましょう！<br>Googleマップのリンク貼り付けや<br>Takeout CSVの取り込みもできます。</p></div>`;

  return `
  <div class="places">
    <div class="seg">
      <button class="seg-btn ${S.placeView === 'list' ? 'on' : ''}" data-action="placeview" data-v="list">リスト（${list.length}）</button>
      <button class="seg-btn ${S.placeView === 'map' ? 'on' : ''}" data-action="placeview" data-v="map">地図（${withPos.length}）</button>
    </div>
    ${S.placeView === 'list' && list.length > withPos.length ? (S.bulkFix && S.bulkFix.tripId === t.id
      ? `<div class="card bulkfix"><p class="note">📡 位置情報を補完中… ${S.bulkFix.done}/${S.bulkFix.total}（このまま少しお待ちください）</p></div>`
      : `<button class="btn btn-block" data-action="bulk-fix-pos">📡 位置情報なし ${list.length - withPos.length}件をまとめて補完</button>`) : ''}
    ${S.placeView === 'list' ? `<div class="place-list">${cards}</div>`
      : `<div id="map" class="mapbox"></div>
         <p class="map-hint">地図を長押し（ダブルタップ）すると、その地点を場所として追加できます</p>`}
  </div>`;
}

/* ----- せっていタブ ----- */
function renderSettingsTab(t, overseas) {
  const id = store.identity;
  const isOwner = t.ownerUid === store.uid;
  const shareUrl = `${location.origin}${location.pathname}#/join/${t.id}`;

  const shareSec = store.canShare ? `
    <section class="card">
      <h3>👥 共有</h3>
      <label class="switch-row">
        <span>この旅を共有する<br><small>リンクを知っている人が閲覧・編集できます</small></span>
        <input type="checkbox" data-action-change="share-toggle" ${t.isShared ? 'checked' : ''}>
      </label>
      ${t.isShared ? `
        <div class="share-link">${esc(shareUrl)}</div>
        <div class="row gap">
          <button class="btn btn-primary" data-action="share-native">📤 共有リンクを送る</button>
          <button class="btn" data-action="copy-link">コピー</button>
        </div>` : ''}
    </section>` : `
    <section class="card">
      <h3>👥 共有</h3>
      <p class="note">共有・リアルタイム共同編集はFirebase設定後に使えます。<br>フォルダ内の <b>SETUP.md</b> の手順でセットアップしてください（無料・約10分）。</p>
    </section>`;

  const memberSec = Object.keys(S.members).length ? `
    <section class="card">
      <h3>🧑‍🤝‍🧑 メンバー</h3>
      ${Object.entries(S.members).map(([uid, m]) => `
        <div class="member-row"><span class="avatar" style="background:${memberColor(uid)}">${esc((m.name || '?').slice(0, 1))}</span>
        ${esc(m.name)}${uid === t.ownerUid ? ' <span class="badge badge-mini">作成者</span>' : ''}${uid === store.uid ? ' （あなた）' : ''}</div>`).join('')}
    </section>` : '';

  const accountSec = store.mode === 'cloud' ? `
    <section class="card">
      <h3>👤 アカウント</h3>
      <div class="member-row">表示名：<b>${esc(id.name)}</b>
        <button class="chip" data-action="edit-name">変更</button></div>
      ${id.isGoogle
      ? `<p class="note">Googleログイン中（${esc(id.email || '')}）</p><button class="btn" data-action="google-logout">ログアウト</button>`
      : `<p class="note">ゲスト利用中。Googleでログインすると、PC・iPhoneどちらからも同じ旅を開けます。</p>
         <button class="btn btn-primary" data-action="google-login">Googleでログイン</button>`}
    </section>` : '';

  return `
  <div class="settings">
    <section class="card">
      <h3>📖 旅の情報</h3>
      <div class="info-row"><span>タイトル</span><b>${esc(t.title)}</b></div>
      <div class="info-row"><span>行き先</span><b>${esc(t.dest || '未設定')}</b></div>
      <div class="info-row"><span>日程</span><b>${t.startDate ? fmtDateShort(t.startDate) + ' 〜 ' + fmtDateShort(t.endDate || t.startDate) : '未設定'}</b></div>
      <div class="info-row"><span>タイムゾーン</span><b>${esc(TZ_PRESETS.find((p) => p.tz === t.tz)?.label || t.tz || '日本')}</b></div>
      <button class="btn" data-action="edit-trip">✏️ 編集する</button>
    </section>
    ${shareSec}
    ${memberSec}
    ${accountSec}
    <section class="card danger">
      ${isOwner
      ? `<button class="btn btn-danger" data-action="delete-trip">🗑️ この旅を削除する</button>`
      : `<button class="btn btn-danger" data-action="leave-trip">👋 この旅から抜ける</button>`}
    </section>
    <p class="version">たびとも v1.0</p>
  </div>`;
}

/* ---------------- 地図 ---------------- */
function destroyMap() {
  if (map) { try { map.remove(); } catch { } map = null; mapMarkers = []; }
}
function initMap() {
  const el = $('#map');
  if (!el || typeof L === 'undefined') return;
  destroyMap();
  map = L.map(el, { zoomControl: true, doubleClickZoom: false });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);

  const pts = S.places.filter((p) => p.lat != null && p.lng != null);
  pts.forEach((p) => {
    const c = catOf(p.cat);
    const icon = L.divIcon({
      className: 'pin',
      html: `<div class="pin-in cat-${esc(p.cat || 'star')}">${c.e}</div>`,
      iconSize: [34, 34], iconAnchor: [17, 30],
    });
    const m = L.marker([p.lat, p.lng], { icon }).addTo(map);
    m.bindPopup(`
      <div class="pop">
        <b>${esc(p.name)}</b>
        <div class="row gap">
          <button class="chip" data-action="place-to-plan" data-id="${esc(p.id)}">📖 予定に入れる</button>
          <button class="chip" data-action="open-gmap" data-id="${esc(p.id)}">🗺️ Gマップ</button>
        </div>
      </div>`);
    mapMarkers.push(m);
  });

  if (S.mapState) {
    map.setView(S.mapState.center, S.mapState.zoom);
  } else if (pts.length) {
    map.fitBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lng])).pad(0.2));
  } else {
    map.setView([35.681, 139.767], 5);
  }
  map.on('moveend', () => { S.mapState = { center: map.getCenter(), zoom: map.getZoom() }; });
  map.on('dblclick', (ev) => {
    openPlaceSheet(null, { lat: +ev.latlng.lat.toFixed(6), lng: +ev.latlng.lng.toFixed(6) });
  });
  setTimeout(() => map && map.invalidateSize(), 60);
}

/* ---------------- シート（モーダル） ---------------- */
function openSheet(html, opts = {}) {
  const wrap = $('#sheets');
  // 入力フォームは誤タップで消えないよう、背景タップでは閉じない（dismissible指定時のみ閉じる）
  wrap.innerHTML = `
    <div class="backdrop"${opts.dismissible ? ' data-action="close-sheet"' : ''}></div>
    <div class="sheet">${html}</div>`;
  document.body.classList.add('sheet-open');
}
function closeSheet() {
  $('#sheets').innerHTML = '';
  document.body.classList.remove('sheet-open');
  S.geoResults = []; S.csv = null;
}

/* ----- 旅行作成・編集シート ----- */
function openTripSheet(edit) {
  const t = edit ? S.trip : {
    title: '', dest: '', emoji: '✈️', theme: 'coral',
    startDate: todayStr(), endDate: todayStr(), tz: JST, isShared: false,
  };
  const tzOptions = TZ_PRESETS.map((p) =>
    `<option value="${p.tz}" ${t.tz === p.tz ? 'selected' : ''}>${p.label}</option>`).join('')
    + `<optgroup label="その他の地域">${allTimeZones().filter((z) => !TZ_PRESETS.some((p) => p.tz === z)).map((z) =>
      `<option value="${z}" ${t.tz === z ? 'selected' : ''}>${z}</option>`).join('')}</optgroup>`;

  openSheet(`
  <form id="form-trip" data-edit="${edit ? '1' : ''}">
    <div class="sheet-head"><h2>${edit ? '旅の情報を編集' : 'あたらしい旅 ✈️'}</h2>
      <button type="button" class="xbtn" data-action="close-sheet">✕</button></div>
    <label class="field"><span>タイトル<em>必須</em></span>
      <input name="title" required maxlength="40" placeholder="例：パリごほうび旅行" value="${esc(t.title)}"></label>
    <label class="field"><span>行き先</span>
      <input name="dest" maxlength="40" placeholder="例：フランス・パリ" value="${esc(t.dest)}"></label>
    <div class="field"><span>カバー絵文字</span>
      <div class="emoji-grid">${COVER_EMOJIS.map((e) =>
        `<button type="button" class="emoji-opt ${t.emoji === e ? 'on' : ''}" data-action="emoji-pick" data-e="${e}">${e}</button>`).join('')}</div>
      <input type="hidden" name="emoji" value="${esc(t.emoji)}"></div>
    <div class="field"><span>テーマカラー</span>
      <div class="color-row">${Object.keys(THEMES).map((k) =>
        `<button type="button" class="color-opt ${t.theme === k ? 'on' : ''}" data-action="color-pick" data-c="${k}" style="background:${themeGrad(k)}"></button>`).join('')}</div>
      <input type="hidden" name="theme" value="${esc(t.theme)}"></div>
    <div class="row gap">
      <label class="field grow"><span>開始日</span><input type="date" name="startDate" required value="${esc(t.startDate)}"></label>
      <label class="field grow"><span>終了日</span><input type="date" name="endDate" required value="${esc(t.endDate)}"></label>
    </div>
    <label class="field"><span>行き先の時間（タイムゾーン）</span>
      <select name="tz">${tzOptions}</select>
      <small class="note">海外旅行のときに選んでください。予定を現地時間⇄日本時間で表示できます。</small></label>
    <button class="btn btn-primary btn-block" type="submit">${edit ? '保存する' : '旅をつくる 🎉'}</button>
  </form>`);
}

/* ----- 予定シート ----- */
function openEventSheet(ev, prefill = {}) {
  const t = S.trip;
  const overseas = (t.tz || JST) !== JST;
  const days = tripDays(t.startDate, t.endDate);
  const e = ev || {
    date: prefill.date || S.day || days[0] || todayStr(),
    time: '', endTime: '', timeMode: 'local', title: prefill.title || '',
    cat: prefill.cat || 'spot', memo: '', url: prefill.url || '', placeId: prefill.placeId || '',
  };
  const allDays = [...days];
  if (e.date && !allDays.includes(e.date)) allDays.push(e.date);

  openSheet(`
  <form id="form-event" data-id="${ev ? esc(ev.id) : ''}">
    <div class="sheet-head"><h2>${ev ? '予定を編集' : '予定を追加 📝'}</h2>
      <button type="button" class="xbtn" data-action="close-sheet">✕</button></div>
    <label class="field"><span>なにをする？<em>必須</em></span>
      <input name="title" required maxlength="60" placeholder="例：ルーヴル美術館" value="${esc(e.title)}"></label>
    <div class="field"><span>アイコン</span>
      <div class="cat-grid">${CATS.map((c) =>
        `<button type="button" class="cat-opt ${e.cat === c.k ? 'on' : ''}" data-action="cat-pick" data-k="${c.k}">
          <span>${c.e}</span><small>${c.l}</small></button>`).join('')}</div>
      <input type="hidden" name="cat" value="${esc(e.cat)}"></div>
    <label class="field"><span>日にち</span>
      <select name="date">${allDays.map((d) => {
        const n = days.indexOf(d);
        return `<option value="${d}" ${e.date === d ? 'selected' : ''}>${n >= 0 ? (n + 1) + '日目 ' : '⚠ '}${fmtDateShort(d)}</option>`;
      }).join('')}</select></label>
    <div class="row gap">
      <label class="field grow"><span>開始時刻</span><input type="time" name="time" value="${esc(e.time || '')}"></label>
      <label class="field grow"><span>終了時刻（任意）</span><input type="time" name="endTime" value="${esc(e.endTime || '')}"></label>
    </div>
    ${overseas ? `
    <div class="field"><span>時刻の基準</span>
      <div class="seg small">
        <label class="seg-btn ${(e.timeMode || 'local') === 'local' ? 'on' : ''}"><input type="radio" name="timeMode" value="local" ${(e.timeMode || 'local') === 'local' ? 'checked' : ''}>現地時間</label>
        <label class="seg-btn ${e.timeMode === 'jst' ? 'on' : ''}"><input type="radio" name="timeMode" value="jst" ${e.timeMode === 'jst' ? 'checked' : ''}>日本時間</label>
      </div>
      <small class="note">✈️ フライトは「出発」「到着」で予定を分けると、時差もきれいに表示できます。</small></div>` : ''}
    ${S.places.length ? `
    <label class="field"><span>ばしょリストから紐づけ</span>
      <select name="placeId"><option value="">（なし）</option>
      ${[...S.places].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ja')).map((p) =>
        `<option value="${esc(p.id)}" ${e.placeId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>` : ''}
    <label class="field"><span>メモ</span>
      <textarea name="memo" rows="2" maxlength="500" placeholder="予約番号、集合場所など">${esc(e.memo || '')}</textarea></label>
    <label class="field"><span>URL（予約サイトなど）</span>
      <input name="url" type="url" placeholder="https://" value="${esc(e.url || '')}"></label>
    <div class="row gap">
      <button class="btn btn-primary grow" type="submit">${ev ? '保存する' : '追加する'}</button>
      ${ev ? `<button class="btn btn-danger" type="button" data-action="del-event" data-id="${esc(ev.id)}">削除</button>` : ''}
    </div>
  </form>`);
}

/* ----- 場所シート ----- */
function openPlaceSheet(place, prefill = {}) {
  const p = place || {
    name: prefill.name || '', memo: prefill.memo || '', cat: prefill.cat || 'spot',
    url: prefill.url || '', lat: prefill.lat ?? null, lng: prefill.lng ?? null,
  };
  openSheet(`
  <form id="form-place" data-id="${place ? esc(place.id) : ''}" data-lat="${p.lat ?? ''}" data-lng="${p.lng ?? ''}">
    <div class="sheet-head"><h2>${place ? 'ばしょを編集' : 'ばしょを追加 📍'}</h2>
      <button type="button" class="xbtn" data-action="close-sheet">✕</button></div>
    <label class="field"><span>名前<em>必須</em></span>
      <div class="row gap">
        <input name="name" required maxlength="60" class="grow" placeholder="例：ルーヴル美術館" value="${esc(p.name)}">
        <button type="button" class="btn" data-action="geo-search">🔍 検索</button>
      </div>
      <small class="note">「検索」で名前から地図上の位置を取得できます</small></label>
    <div id="geo-results"></div>
    <div class="field"><span>位置情報</span>
      <div class="pos-badge" id="pos-badge">${p.lat != null ? `✅ 取得済み（${p.lat}, ${p.lng}）` : '─ 未取得（検索やリンク取り込みで設定）'}</div></div>
    <label class="field"><span>カテゴリ</span>
      <select name="cat">${CATS.map((c) => `<option value="${c.k}" ${p.cat === c.k ? 'selected' : ''}>${c.e} ${c.l}</option>`).join('')}</select></label>
    <label class="field"><span>メモ</span>
      <textarea name="memo" rows="2" maxlength="500" placeholder="行きたい理由、営業時間など">${esc(p.memo || '')}</textarea></label>
    <label class="field"><span>GoogleマップURL（任意）</span>
      <input name="url" placeholder="https://maps.app.goo.gl/…" value="${esc(p.url || '')}"></label>
    <div class="row gap">
      <button class="btn btn-primary grow" type="submit">${place ? '保存する' : '追加する'}</button>
      ${place ? `<button class="btn btn-danger" type="button" data-action="del-place" data-id="${esc(place.id)}">削除</button>` : ''}
    </div>
  </form>`);
}

/* ----- 場所追加メニュー ----- */
function openPlaceMenu() {
  openSheet(`
  <div class="sheet-head"><h2>ばしょを追加 📍</h2>
    <button type="button" class="xbtn" data-action="close-sheet">✕</button></div>
  <div class="menu-list">
    <button class="menu-item" data-action="add-place-manual"><span>🔍</span>
      <span><b>名前で検索して追加</b><small>地図の位置も自動で取得します</small></span></button>
    <button class="menu-item" data-action="add-place-link"><span>🔗</span>
      <span><b>Googleマップのリンクから</b><small>「共有」→「リンクをコピー」を貼り付け</small></span></button>
    <button class="menu-item" data-action="add-place-csv"><span>📄</span>
      <span><b>保存リストをまとめて取り込み</b><small>Google TakeoutのCSVファイル</small></span></button>
  </div>`, { dismissible: true });
}

/* ----- リンク取り込みシート ----- */
function openLinkSheet() {
  openSheet(`
  <form id="form-link">
    <div class="sheet-head"><h2>Googleマップのリンク 🔗</h2>
      <button type="button" class="xbtn" data-action="close-sheet">✕</button></div>
    <label class="field"><span>リンクを貼り付け</span>
      <textarea name="link" rows="3" placeholder="https://maps.app.goo.gl/… または https://www.google.com/maps/place/…" required></textarea>
      <small class="note">Googleマップで場所を開き「共有」→「リンクをコピー」した内容を貼り付けてください</small></label>
    <div id="link-status"></div>
    <button class="btn btn-primary btn-block" type="submit">取り込む</button>
  </form>`);
}

/* ----- CSV取り込みシート ----- */
function openCsvSheet() {
  openSheet(`
  <div class="sheet-head"><h2>保存リストの取り込み 📄</h2>
    <button type="button" class="xbtn" data-action="close-sheet">✕</button></div>
  <p class="note">Google Takeout（<b>takeout.google.com</b>）で「保存済み」を書き出すと、保存リストごとのCSVファイルがもらえます。それをここで選んでください。</p>
  <label class="btn btn-primary btn-block filebtn">CSVファイルを選ぶ
    <input type="file" id="csv-file" accept=".csv,text/csv" hidden></label>
  <div id="csv-preview"></div>`);
}

function renderCsvPreview() {
  const el = $('#csv-preview');
  if (!el || !S.csv) return;
  const noPos = S.csv.filter((r) => r.lat == null).length;
  el.innerHTML = `
    <div class="card">
      <p><b>${S.csv.length}件</b>の場所が見つかりました${noPos ? `（うち${noPos}件は位置情報なし）` : ''}</p>
      <ul class="csv-list">${S.csv.slice(0, 5).map((r) => `<li>${esc(r.name)}</li>`).join('')}${S.csv.length > 5 ? '<li>…ほか</li>' : ''}</ul>
      ${noPos ? `<label class="check-row"><input type="checkbox" id="csv-geocode" checked>位置情報のない場所を自動検索で補う（1件ずつ・少し時間がかかります）</label>` : ''}
      <button class="btn btn-primary btn-block" data-action="import-csv-confirm">この内容で取り込む</button>
      <div id="csv-progress"></div>
    </div>`;
}

/* ----- 名前入力シート ----- */
function openNameSheet(cb) {
  openSheet(`
  <form id="form-name">
    <div class="sheet-head"><h2>ニックネーム 🙋</h2></div>
    <p class="note">共有メンバーに表示される名前です</p>
    <label class="field"><span>名前</span>
      <input name="name" required maxlength="20" placeholder="例：りょうた" value="${esc(store.identity.name === 'ゲスト' ? '' : store.identity.name)}"></label>
    <button class="btn btn-primary btn-block" type="submit">OK</button>
  </form>`);
  openNameSheet._cb = cb || null;
}

/* ---------------- アクション ---------------- */
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const act = el.dataset.action;
  const id = el.dataset.id;
  const t = S.trip;

  try {
    switch (act) {
      case 'nav-home': nav('/'); break;
      case 'new-trip': openTripSheet(false); break;
      case 'open-trip': nav(`/trip/${id}`); break;
      case 'remove-ref': await store.removeRef(id); break;
      case 'tab': nav(`/trip/${t.id}/${el.dataset.tab}`); break;
      case 'day': S.day = el.dataset.date; render(); break;
      case 'timeview': S.timeView = el.dataset.v; render(); break;
      case 'placeview': S.placeView = el.dataset.v; render(); break;
      case 'close-sheet': closeSheet(); break;

      case 'google-login':
        try { await store.signInGoogle(); toast('ログインしました！'); }
        catch (err) { toast('ログインできませんでした：' + (err.message || err.code || '')); }
        break;
      case 'google-logout':
      case 'account-menu':
        if (act === 'google-logout' || confirm('ログアウトしますか？')) {
          await store.signOutUser(); toast('ログアウトしました');
        }
        break;
      case 'edit-name': openNameSheet(); break;

      case 'add-event': openEventSheet(null); break;
      case 'edit-event': {
        const ev = S.events.find((x) => x.id === id);
        if (ev) openEventSheet(ev);
        break;
      }
      case 'del-event':
        if (confirm('この予定を削除しますか？')) {
          await store.deleteEvent(t.id, id); closeSheet(); toast('削除しました');
        }
        break;

      case 'add-place-menu': openPlaceMenu(); break;
      case 'add-place-manual': openPlaceSheet(null); break;
      case 'add-place-link': openLinkSheet(); break;
      case 'add-place-csv': openCsvSheet(); break;
      case 'edit-place': {
        const p = S.places.find((x) => x.id === id);
        if (p) openPlaceSheet(p);
        break;
      }
      case 'del-place':
        if (confirm('このばしょを削除しますか？')) {
          await store.deletePlace(t.id, id); closeSheet(); toast('削除しました');
        }
        break;
      case 'place-to-plan': {
        const p = S.places.find((x) => x.id === id);
        if (p) openEventSheet(null, { title: p.name, placeId: p.id, cat: p.cat || 'spot', url: '' });
        break;
      }
      case 'open-gmap': {
        const p = S.places.find((x) => x.id === id);
        if (p) window.open(gmapsSearchUrl(p), '_blank', 'noopener');
        break;
      }
      case 'bulk-fix-pos': bulkFixPositions(); break;

      case 'geo-search': {
        const form = el.closest('form');
        const q = form.elements.name.value.trim();
        if (!q) { toast('先に名前を入力してください'); break; }
        el.disabled = true; el.textContent = '検索中…';
        try {
          const dest = t && t.dest ? ' ' + t.dest : '';
          let res = await geocode(q + dest);
          if (!res.length && dest) res = await geocode(q);
          S.geoResults = res;
          const box = $('#geo-results');
          box.innerHTML = res.length
            ? `<div class="geo-list">${res.map((r, i) =>
              `<button type="button" class="geo-item" data-action="pick-geo" data-i="${i}">📍 <b>${esc(r.name)}</b><small>${esc(r.full)}</small></button>`).join('')}</div>`
            : '<p class="note">見つかりませんでした。別の言葉で試すか、そのまま保存してください。</p>';
        } catch (err) { toast(err.message || '検索に失敗しました'); }
        el.disabled = false; el.textContent = '🔍 検索';
        break;
      }
      case 'pick-geo': {
        const r = S.geoResults[+el.dataset.i];
        const form = el.closest('form');
        if (r && form) {
          form.dataset.lat = r.lat; form.dataset.lng = r.lng;
          if (!form.elements.name.value.trim()) form.elements.name.value = r.name;
          $('#pos-badge').textContent = `✅ 取得済み（${r.lat}, ${r.lng}）`;
          $('#geo-results').innerHTML = `<p class="note">📍 「${esc(r.name)}」の位置を設定しました</p>`;
        }
        break;
      }

      case 'share-native': {
        const url = `${location.origin}${location.pathname}#/join/${t.id}`;
        const text = `旅のしおり「${t.title}」を一緒に編集しよう！`;
        if (navigator.share) {
          try { await navigator.share({ title: t.title, text, url }); } catch { }
        } else {
          await navigator.clipboard.writeText(`${text}\n${url}`);
          toast('リンクをコピーしました');
        }
        break;
      }
      case 'copy-link': {
        const url = `${location.origin}${location.pathname}#/join/${t.id}`;
        await navigator.clipboard.writeText(url);
        toast('リンクをコピーしました 📋');
        break;
      }
      case 'edit-trip': openTripSheet(true); break;
      case 'delete-trip':
        if (confirm(`「${t.title}」を削除しますか？\n予定・ばしょもすべて消えます。`)) {
          await store.deleteTrip(t.id); nav('/'); toast('削除しました');
        }
        break;
      case 'leave-trip':
        if (confirm('この旅から抜けますか？（データは残ります）')) {
          await store.leaveTrip(t.id); nav('/'); toast('旅から抜けました');
        }
        break;

      case 'emoji-pick': {
        const form = el.closest('form');
        form.elements.emoji.value = el.dataset.e;
        form.querySelectorAll('.emoji-opt').forEach((b) => b.classList.toggle('on', b === el));
        break;
      }
      case 'color-pick': {
        const form = el.closest('form');
        form.elements.theme.value = el.dataset.c;
        form.querySelectorAll('.color-opt').forEach((b) => b.classList.toggle('on', b === el));
        break;
      }
      case 'cat-pick': {
        const form = el.closest('form');
        form.elements.cat.value = el.dataset.k;
        form.querySelectorAll('.cat-opt').forEach((b) => b.classList.toggle('on', b === el));
        break;
      }

      case 'import-csv-confirm': await importCsv(el); break;
    }
  } catch (err) {
    console.error(err);
    toast('エラー：' + (err.message || err));
  }
});

// トグルスイッチ（change イベント）
document.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.dataset.actionChange === 'share-toggle' && S.trip) {
    const on = el.checked;
    await store.updateTrip(S.trip.id, { isShared: on });
    toast(on ? '共有をONにしました。リンクを送りましょう📤' : '共有をOFFにしました');
  }
  if (el.id === 'csv-file' && el.files && el.files[0]) {
    const text = await el.files[0].text();
    S.csv = parseTakeoutCsv(text);
    if (!S.csv.length) { toast('CSVから場所を読み取れませんでした'); S.csv = null; return; }
    renderCsvPreview();
  }
});

// フォーム送信
document.addEventListener('submit', async (e) => {
  const form = e.target;
  e.preventDefault();
  const fd = new FormData(form);
  const t = S.trip;

  try {
    if (form.id === 'form-trip') {
      const data = {
        title: fd.get('title').trim(),
        dest: (fd.get('dest') || '').trim(),
        emoji: fd.get('emoji') || '✈️',
        theme: fd.get('theme') || 'coral',
        startDate: fd.get('startDate'),
        endDate: fd.get('endDate'),
        tz: fd.get('tz') || JST,
      };
      if (data.endDate < data.startDate) data.endDate = data.startDate;
      if (form.dataset.edit) {
        await store.updateTrip(t.id, data);
        closeSheet(); toast('保存しました');
      } else {
        const id = await store.createTrip({ ...data, isShared: false });
        closeSheet(); nav(`/trip/${id}`);
        toast('旅のしおりができました！🎉');
      }
    }

    if (form.id === 'form-event') {
      const data = {
        title: fd.get('title').trim(),
        cat: fd.get('cat') || 'star',
        date: fd.get('date'),
        time: fd.get('time') || '',
        endTime: fd.get('endTime') || '',
        timeMode: fd.get('timeMode') || 'local',
        placeId: fd.get('placeId') || '',
        memo: (fd.get('memo') || '').trim(),
        url: (fd.get('url') || '').trim(),
      };
      const evId = form.dataset.id;
      S.day = data.date;
      if (evId) await store.updateEvent(t.id, evId, data);
      else await store.addEvent(t.id, data);
      closeSheet(); render();
      toast(evId ? '保存しました' : '予定を追加しました！');
    }

    if (form.id === 'form-place') {
      const data = {
        name: fd.get('name').trim(),
        cat: fd.get('cat') || 'spot',
        memo: (fd.get('memo') || '').trim(),
        url: (fd.get('url') || '').trim(),
        lat: form.dataset.lat !== '' ? +form.dataset.lat : null,
        lng: form.dataset.lng !== '' ? +form.dataset.lng : null,
      };
      const pid = form.dataset.id;
      if (pid) await store.updatePlace(t.id, pid, data);
      else await store.addPlace(t.id, data);
      closeSheet(); toast(pid ? '保存しました' : 'ばしょを追加しました📍');
    }

    if (form.id === 'form-link') {
      const raw = fd.get('link').trim();
      const status = $('#link-status');
      status.innerHTML = '<p class="note">読み取り中…</p>';
      let parsed = parseGmapsUrl(raw);
      if ((parsed.lat == null || !parsed.name) && /google|goo\.gl/.test(raw)) {
        const resolved = await resolveGmapsPage(raw);
        if (resolved) {
          parsed = {
            name: parsed.name || resolved.name,
            lat: parsed.lat ?? resolved.lat,
            lng: parsed.lng ?? resolved.lng,
            url: raw,
          };
        }
      }
      if (parsed.lat != null || parsed.name) {
        openPlaceSheet(null, { name: parsed.name || '', lat: parsed.lat, lng: parsed.lng, url: raw });
        if (parsed.lat == null) toast('位置は取得できませんでした。「検索」で補完できます');
      } else {
        status.innerHTML = '<p class="note">⚠ リンクから情報を取得できませんでした。「名前で検索して追加」をお試しください。</p>';
      }
    }

    if (form.id === 'form-name') {
      store.setName(fd.get('name').trim());
      closeSheet();
      const cb = openNameSheet._cb; openNameSheet._cb = null;
      if (cb) cb(); else render();
    }
  } catch (err) {
    console.error(err);
    toast('エラー：' + (err.message || err));
  }
});

/* ----- CSVインポート実行 ----- */
async function importCsv(btn) {
  if (!S.csv || !S.trip) return;
  const doGeo = $('#csv-geocode') ? $('#csv-geocode').checked : false;
  const prog = $('#csv-progress');
  btn.disabled = true;
  const rows = [...S.csv];
  let done = 0;
  const sess = doGeo ? { urlFails: 0, destCenter: await destCenterOf(S.trip.dest) } : {};
  for (const r of rows) {
    let { lat, lng } = r;
    if (lat == null && doGeo) {
      const c = await findCoords(r.name, r.url, S.trip.dest, sess);
      if (c) { lat = c.lat; lng = c.lng; }
    }
    await store.addPlace(S.trip.id, {
      name: r.name, memo: r.memo || '', cat: 'spot', url: r.url || '', lat, lng,
    });
    done++;
    if (prog) prog.innerHTML = `<p class="note">取り込み中… ${done}/${rows.length}</p>`;
  }
  closeSheet();
  toast(`${done}件のばしょを取り込みました！🎉`);
}

/* ----- 座標の補完（リンク先ページ → 名前検索の順で試す） ----- */

// 2点間のおおよその距離(km)
function distKm(a, b) {
  const d = Math.PI / 180;
  const x = (b.lng - a.lng) * d * Math.cos(((a.lat + b.lat) / 2) * d);
  const y = (b.lat - a.lat) * d;
  return Math.sqrt(x * x + y * y) * 6371;
}

// 検索ワードの候補を作る（そのまま → 括弧を除いた形 → 括弧の中身 → 最後の語）
function nameVariants(name, dest) {
  const base = (name || '').trim();
  const cores = [];
  const push = (s) => { s = s.replace(/\s+/g, ' ').trim(); if (s.length >= 2 && !cores.includes(s)) cores.push(s); };
  push(base);
  const noParen = base.replace(/[（(][^（）()]*[）)]/g, ' ');
  push(noParen);
  const parenIn = (base.match(/[（(]([^（）()]+)[）)]/) || [])[1];
  if (parenIn) push(parenIn);
  const toks = noParen.replace(/\s+/g, ' ').trim().split(' ');
  if (toks.length > 1) push(toks[toks.length - 1]);
  const out = [];
  for (const c of cores.slice(0, 3)) out.push({ q: dest ? `${c} ${dest}` : c, core: c, withDest: !!dest });
  if (dest) for (const c of cores.slice(0, 1)) out.push({ q: c, core: c, withDest: false });
  return out;
}

// 検索結果から「本当にその場所らしいもの」を選ぶ（名前の一致＋行き先からの距離で判定）
function pickHit(res, core, withDest, destCenter) {
  const norm = (s) => (s || '').replace(/[\s・]/g, '');
  const target = norm(core);
  const hits = res.filter((r) => {
    const rn = norm(r.name);
    return rn.includes(target) || norm(r.full).includes(target) || (rn.length >= 2 && target.includes(rn));
  });
  if (!hits.length) return null;
  if (destCenter) {
    hits.sort((a, b) => distKm(a, destCenter) - distKm(b, destCenter));
    const best = hits[0];
    if (withDest || hits.length === 1 || distKm(best, destCenter) < 150) return best;
    return null;
  }
  return hits[0];
}

// あいまい検索（Photon / OpenStreetMapデータ）。表記ゆれに強い最後のひと押し
async function photonFind(q, destCenter) {
  let u = `https://photon.komoot.io/api/?limit=3&q=${encodeURIComponent(q)}`;
  if (destCenter) u += `&lat=${destCenter.lat}&lon=${destCenter.lng}`;
  const res = await fetch(u);
  if (!res.ok) return null;
  const js = await res.json();
  const norm = (s) => (s || '').replace(/[\s・]/g, '');
  for (const f of (js.features || [])) {
    const c = { lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] };
    const nm = norm(f.properties && f.properties.name);
    const okName = nm && (nm.includes(norm(q)) || norm(q).includes(nm));
    if (destCenter ? distKm(c, destCenter) < 150 : okName) return c;
  }
  return null;
}

// 行き先の中心座標（誤ヒット除外の距離チェック用）を一度だけ取得
async function destCenterOf(dest) {
  if (!dest) return null;
  try {
    const r = await geocode(dest);
    await sleep(1100);
    return r.length ? { lat: r[0].lat, lng: r[0].lng } : null;
  } catch { return null; }
}

async function findCoords(name, url, dest, sess = {}) {
  // ① Googleマップリンクの先のページから座標を抜き出す（成功すれば最も正確。
  //    ただしGoogle側が取得をブロックすることが多いため、連続失敗後は省略する）
  if (url && /google|goo\.gl/.test(url) && (sess.urlFails || 0) < 2) {
    try {
      const r = await resolveGmapsPage(url);
      if (r && r.lat != null) { sess.urlFails = 0; await sleep(300); return { lat: r.lat, lng: r.lng }; }
    } catch { }
    sess.urlFails = (sess.urlFails || 0) + 1;
  }
  if (!name) return null;
  const dc = sess.destCenter || null;
  // ② 名前のバリエーションでOpenStreetMap検索
  for (const v of nameVariants(name, dest)) {
    try {
      const res = await geocode(v.q);
      const hit = pickHit(res, v.core, v.withDest, dc);
      if (hit) return { lat: hit.lat, lng: hit.lng };
    } catch { }
    await sleep(1100); // Nominatimの利用ポリシー（1リクエスト/秒）
  }
  // ③ あいまい検索
  try {
    const cores = nameVariants(name, '');
    return await photonFind((cores[0] && cores[0].core) || name, dc);
  } catch { return null; }
}

/* ----- 位置情報なしの一括補完 ----- */
async function bulkFixPositions() {
  if (S.bulkFix || !S.trip) return;
  const tripId = S.trip.id;
  const dest = S.trip.dest || '';
  const targets = S.places.filter((p) => p.lat == null);
  if (!targets.length) return;
  S.bulkFix = { tripId, done: 0, total: targets.length };
  render();
  const sess = { urlFails: 0, destCenter: await destCenterOf(dest) };
  let ok = 0;
  try {
    for (const p of targets) {
      const c = await findCoords(p.name, p.url, dest, sess);
      if (c) {
        try { await store.updatePlace(tripId, p.id, { lat: c.lat, lng: c.lng }); ok++; } catch { }
      }
      S.bulkFix.done++;
      render();
    }
  } finally {
    S.bulkFix = null;
    render();
  }
  const miss = targets.length - ok;
  toast(ok
    ? `${ok}件の位置がわかりました！🎉${miss ? `（残り${miss}件は見つからず）` : ''}`
    : '位置を見つけられませんでした。場所を開いて、言葉を変えて検索してみてください');
}

/* ---------------- 起動 ---------------- */
async function boot() {
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => { });
  }
  store = await initStore(() => {
    // uidが変わったら購読し直す
    if (S.route.view === 'home') { unsubAll(); subs.push(store.subMyTrips((tr) => { S.trips = tr; render(); })); }
    else render();
  });
  seedSample();
  S.loading = false;
  window.addEventListener('hashchange', onRoute);
  onRoute();
}

// 初回起動時のサンプル旅行（ローカルモードのみ）
function seedSample() {
  if (store.mode !== 'local') return;
  if (localStorage.getItem('tabitomo.sampled')) return;
  localStorage.setItem('tabitomo.sampled', '1');
  const start = todayStr();
  const d = (n) => {
    const base = new Date(Date.parse(start + 'T00:00:00Z') + n * 86400000);
    return base.toISOString().slice(0, 10);
  };
  store.createTrip({
    title: 'サンプル：パリ旅行', dest: 'フランス・パリ', emoji: '🗼', theme: 'grape',
    startDate: d(30), endDate: d(33), tz: 'Europe/Paris', isShared: false,
  }).then(async (id) => {
    const p1 = await store.addPlace(id, { name: 'ルーヴル美術館', memo: '木曜は夜まで開館', cat: 'spot', url: '', lat: 48.8606, lng: 2.3376 });
    await store.addPlace(id, { name: 'エッフェル塔', memo: '夜のライトアップも見たい', cat: 'photo', url: '', lat: 48.8584, lng: 2.2945 });
    await store.addPlace(id, { name: 'カフェ・ド・フロール', memo: '朝ごはんに', cat: 'cafe', url: '', lat: 48.8540, lng: 2.3326 });
    await store.addEvent(id, { date: d(30), time: '21:55', endTime: '', timeMode: 'jst', title: '羽田空港 出発 ✈️', cat: 'flight', memo: 'JAL45便', url: '', placeId: '' });
    await store.addEvent(id, { date: d(31), time: '04:30', endTime: '', timeMode: 'local', title: 'シャルル・ド・ゴール空港 到着', cat: 'flight', memo: '', url: '', placeId: '' });
    await store.addEvent(id, { date: d(31), time: '10:00', endTime: '12:30', timeMode: 'local', title: 'ルーヴル美術館', cat: 'spot', memo: '事前予約済み', url: '', placeId: p1 });
  });
}

boot();
