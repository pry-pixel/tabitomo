// gmaps.js — Googleマップ連携（URL解析・短縮リンク解決・Takeout CSV・ジオコーディング）

// GoogleマップのURLから 名前・緯度経度 を抽出する
export function parseGmapsUrl(raw) {
  const url = (raw || '').trim();
  const out = { name: null, lat: null, lng: null, url };
  if (!url) return out;

  // 場所名: /maps/place/<名前>/
  const placeM = url.match(/\/maps\/place\/([^/@?]+)/);
  if (placeM) {
    try {
      out.name = decodeURIComponent(placeM[1].replace(/\+/g, ' ')).trim();
    } catch { out.name = placeM[1].replace(/\+/g, ' '); }
  }

  // 座標の優先順位: !3d!4d（ピンの正確な位置） > q=/query= > @lat,lng（地図の中心）
  const pinM = url.match(/!3d(-?\d+\.?\d*)!4d(-?\d+\.?\d*)/);
  if (pinM) {
    out.lat = +pinM[1]; out.lng = +pinM[2];
    return out;
  }
  try {
    const u = new URL(url);
    const q = u.searchParams.get('q') || u.searchParams.get('query');
    if (q) {
      const coordM = q.match(/^\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*$/);
      if (coordM) { out.lat = +coordM[1]; out.lng = +coordM[2]; return out; }
      if (!out.name) out.name = q;
    }
  } catch { /* URLでない文字列はそのまま */ }
  const atM = url.match(/@(-?\d+\.?\d*),(-?\d+\.?\d*)/);
  if (atM) { out.lat = +atM[1]; out.lng = +atM[2]; }
  return out;
}

export function isShortLink(url) {
  return /(maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs)/.test(url || '');
}

// 短縮リンク（maps.app.goo.gl）の解決を試みる（CORSプロキシ経由・ベストエフォート）
export async function resolveShortLink(url) {
  const targets = [
    `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  ];
  for (const proxied of targets) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 9000);
      const res = await fetch(proxied, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      const html = await res.text();
      const out = { name: null, lat: null, lng: null, url };
      const pinM = html.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
      const atM = html.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
      if (pinM) { out.lat = +pinM[1]; out.lng = +pinM[2]; }
      else if (atM) { out.lat = +atM[1]; out.lng = +atM[2]; }
      const titleM = html.match(/<meta\s+(?:property="og:title"|itemprop="name")\s+content="([^"]+)"/)
        || html.match(/<meta\s+content="([^"]+)"\s+(?:property="og:title"|itemprop="name")/);
      if (titleM) {
        out.name = titleM[1].split(' · ')[0].replace(/ - Google\s*(マップ|Maps)$/i, '').trim();
      }
      // 埋め込みURLからの抽出（canonical）
      if (out.lat == null) {
        const canonM = html.match(/https:\/\/www\.google\.[^"']*\/maps\/place\/[^"']+/);
        if (canonM) {
          const p = parseGmapsUrl(canonM[0].replace(/\\u0026/g, '&').replace(/\\\//g, '/'));
          if (p.lat != null) { out.lat = p.lat; out.lng = p.lng; }
          if (!out.name && p.name) out.name = p.name;
        }
      }
      if (out.lat != null || out.name) return out;
    } catch { /* 次のプロキシへ */ }
  }
  return null;
}

// Nominatim（OpenStreetMap）で場所名検索
export async function geocode(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&accept-language=ja&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error('検索サービスに接続できませんでした');
  const list = await res.json();
  return list.map((x) => ({
    name: x.name || (x.display_name || '').split(',')[0],
    full: x.display_name,
    lat: +x.lat,
    lng: +x.lon,
  }));
}

// ---- CSV（Google Takeout 保存リスト） ----

export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') {
      inQ = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Takeoutの保存リストCSV → 場所候補の配列
export function parseTakeoutCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = (names) => header.findIndex((h) => names.includes(h));
  const iTitle = idx(['title', 'タイトル', '名前', 'name']);
  const iNote = idx(['note', 'メモ', 'ノート', 'comment', 'コメント']);
  const iUrl = idx(['url', 'リンク']);
  const out = [];
  for (const r of rows.slice(1)) {
    const name = iTitle >= 0 ? (r[iTitle] || '').trim() : '';
    if (!name) continue;
    const url = iUrl >= 0 ? (r[iUrl] || '').trim() : '';
    const memo = iNote >= 0 ? (r[iNote] || '').trim() : '';
    const parsed = url ? parseGmapsUrl(url) : { lat: null, lng: null };
    out.push({ name, memo, url, lat: parsed.lat, lng: parsed.lng });
  }
  return out;
}

// 場所をGoogleマップで開くURL
export function gmapsSearchUrl(place) {
  if (place.url && /google|goo\.gl/.test(place.url)) return place.url;
  if (place.lat != null && place.lng != null) {
    return `https://www.google.com/maps/search/?api=1&query=${place.lat},${place.lng}`;
  }
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place.name || '')}`;
}
