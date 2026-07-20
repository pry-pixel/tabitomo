// gmap-view.js — Google Maps JavaScript API の読み込みと場所検索（Places）
// APIキー未設定・読み込み失敗時は、app.js 側が従来の Leaflet + OpenStreetMap にフォールバックする

// Googleマップを使う設定になっているか（maps-config.js にキーがあるか）
export function gmapReady() {
  const c = window.TABITOMO_MAPS;
  return !!(c && c.apiKey);
}

let loadPromise = null;

// Maps JavaScript API を一度だけ動的読み込みする
export function loadGmap() {
  if (loadPromise) return loadPromise;
  loadPromise = new Promise((resolve, reject) => {
    window.__tabitomoGmapReady = () => resolve(window.google.maps);
    const s = document.createElement('script');
    s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(window.TABITOMO_MAPS.apiKey)
      + '&v=quarterly&language=ja&region=JP&loading=async&callback=__tabitomoGmapReady';
    s.onerror = () => { loadPromise = null; reject(new Error('Googleマップを読み込めませんでした')); };
    document.head.appendChild(s);
  });
  return loadPromise;
}

// Googleの場所検索（Places Text Search）。gmaps.js の geocode() と同じ形の配列を返す
export async function gplacesSearch(query, bias) {
  await loadGmap();
  const { Place } = await google.maps.importLibrary('places');
  const req = { textQuery: query, fields: ['displayName', 'formattedAddress', 'location'], maxResultCount: 8 };
  if (bias && bias.lat != null) req.locationBias = { lat: bias.lat, lng: bias.lng };
  const { places } = await Place.searchByText(req);
  return (places || []).map((p) => ({
    name: p.displayName || '',
    full: p.formattedAddress || '',
    lat: p.location ? p.location.lat() : null,
    lng: p.location ? p.location.lng() : null,
  })).filter((r) => r.lat != null);
}
