// store.js — データ層。Firebase設定があればクラウド（リアルタイム同期）、なければローカル保存で動く。

const PREFS_KEY = 'tabitomo.prefs.v1';

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); } catch { return {}; }
}
function savePrefs(p) {
  localStorage.setItem(PREFS_KEY, JSON.stringify(p));
}

export function newId() {
  return (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2));
}

export async function initStore(onIdentityChange) {
  if (window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.projectId) {
    try {
      return await initCloud(onIdentityChange);
    } catch (e) {
      console.error('Firebase初期化に失敗。ローカルモードで起動します', e);
      return initLocal(onIdentityChange);
    }
  }
  return initLocal(onIdentityChange);
}

/* ============================================================
   ローカルモード（localStorage）
   ============================================================ */
function initLocal(onIdentityChange) {
  const KEY = 'tabitomo.data.v1';
  let db;
  try { db = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { db = null; }
  if (!db) db = { trips: {}, events: {}, places: {} };
  const prefs = loadPrefs();
  const listeners = new Set();

  function save() { localStorage.setItem(KEY, JSON.stringify(db)); }
  function emit() { for (const l of [...listeners]) l(); }
  function sub(fn) {
    listeners.add(fn); fn();
    return () => listeners.delete(fn);
  }

  const store = {
    mode: 'local',
    canShare: false,
    get uid() { return 'local'; },
    get identity() { return { uid: 'local', name: prefs.name || 'じぶん', isGoogle: false, email: null }; },
    setName(n) { prefs.name = n; savePrefs(prefs); onIdentityChange && onIdentityChange(); },

    subMyTrips(cb) {
      return sub(() => cb(Object.values(db.trips).sort((a, b) => (a.startDate || '').localeCompare(b.startDate || ''))));
    },
    subTrip(id, cb) { return sub(() => cb(db.trips[id] || null)); },
    subEvents(id, cb) { return sub(() => cb([...(db.events[id] || [])])); },
    subPlaces(id, cb) { return sub(() => cb([...(db.places[id] || [])])); },
    subMembers(id, cb) { return sub(() => cb({ local: { name: prefs.name || 'じぶん', color: '#FF6B6B' } })); },

    async createTrip(t) {
      const id = newId();
      db.trips[id] = { ...t, id, ownerUid: 'local', createdAt: Date.now(), updatedAt: Date.now() };
      db.events[id] = []; db.places[id] = [];
      save(); emit(); return id;
    },
    async updateTrip(id, patch) {
      if (!db.trips[id]) return;
      Object.assign(db.trips[id], patch, { updatedAt: Date.now() });
      save(); emit();
    },
    async deleteTrip(id) {
      delete db.trips[id]; delete db.events[id]; delete db.places[id];
      save(); emit();
    },
    async removeRef(id) { return this.deleteTrip(id); },
    async leaveTrip(id) { return this.deleteTrip(id); },
    async joinTrip() { throw new Error('共有機能はFirebase設定後に使えます'); },

    async addEvent(tripId, e) {
      const id = newId();
      (db.events[tripId] = db.events[tripId] || []).push({ ...e, id, createdAt: Date.now() });
      save(); emit(); return id;
    },
    async updateEvent(tripId, id, patch) {
      const ev = (db.events[tripId] || []).find((x) => x.id === id);
      if (ev) { Object.assign(ev, patch); save(); emit(); }
    },
    async deleteEvent(tripId, id) {
      db.events[tripId] = (db.events[tripId] || []).filter((x) => x.id !== id);
      save(); emit();
    },
    async addPlace(tripId, p) {
      const id = newId();
      (db.places[tripId] = db.places[tripId] || []).push({ ...p, id, createdAt: Date.now() });
      save(); emit(); return id;
    },
    async updatePlace(tripId, id, patch) {
      const pl = (db.places[tripId] || []).find((x) => x.id === id);
      if (pl) { Object.assign(pl, patch); save(); emit(); }
    },
    async deletePlace(tripId, id) {
      db.places[tripId] = (db.places[tripId] || []).filter((x) => x.id !== id);
      save(); emit();
    },
    async signInGoogle() { throw new Error('Firebase設定後に使えます'); },
    async signOutUser() {},
  };
  return store;
}

/* ============================================================
   クラウドモード（Firebase / Firestore リアルタイム同期）
   ============================================================ */
async function initCloud(onIdentityChange) {
  const V = '10.12.5';
  const [appMod, authMod, fsMod] = await Promise.all([
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`),
  ]);
  const { initializeApp } = appMod;
  const {
    getAuth, onAuthStateChanged, signInAnonymously, GoogleAuthProvider,
    signInWithPopup, signInWithRedirect, getRedirectResult, linkWithPopup,
    signInWithCredential, signOut,
  } = authMod;
  const {
    initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
    doc, collection, setDoc, updateDoc, deleteDoc, getDoc, getDocs,
    onSnapshot, writeBatch,
  } = fsMod;

  const app = initializeApp(window.FIREBASE_CONFIG);
  const auth = getAuth(app);
  let fdb;
  try {
    fdb = initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
  } catch {
    fdb = initializeFirestore(app, {});
  }

  const prefs = loadPrefs();

  // 認証：まず匿名で入り、必要に応じてGoogleログインへ引き上げ
  try { await getRedirectResult(auth); } catch (e) { console.warn('redirect result', e); }
  await new Promise((resolve) => {
    const off = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        try { await signInAnonymously(auth); } catch (e) { console.error(e); resolve(); }
        return;
      }
      off(); resolve();
    });
  });
  // 認証が使えない（Firebase側の設定が未完了など）場合はローカルモードへフォールバック
  if (!auth.currentUser) throw new Error('Firebase Authが未設定のためローカルモードで起動します');
  onAuthStateChanged(auth, () => onIdentityChange && onIdentityChange());

  const store = {
    mode: 'cloud',
    canShare: true,
    get uid() { return auth.currentUser ? auth.currentUser.uid : null; },
    get identity() {
      const u = auth.currentUser;
      return {
        uid: u ? u.uid : null,
        name: prefs.name || (u && u.displayName) || 'ゲスト',
        isGoogle: !!(u && !u.isAnonymous),
        email: u ? u.email : null,
      };
    },
    setName(n) { prefs.name = n; savePrefs(prefs); onIdentityChange && onIdentityChange(); },

    // ホーム：自分の旅行一覧（tripRefs → 各tripをリアルタイム購読）
    subMyTrips(cb) {
      const uid = this.uid;
      const tripSubs = new Map(); // tripId -> unsub
      const tripData = new Map(); // tripId -> trip | {_error}
      let refIds = [];
      const push = () => {
        const arr = refIds.map((id) => tripData.get(id)).filter(Boolean);
        cb(arr.sort((a, b) => (a.startDate || '').localeCompare(b.startDate || '')));
      };
      const unsubRefs = onSnapshot(collection(fdb, 'users', uid, 'tripRefs'), (snap) => {
        refIds = snap.docs.map((d) => d.id);
        // 消えたrefの購読解除
        for (const [id, un] of tripSubs) {
          if (!refIds.includes(id)) { un(); tripSubs.delete(id); tripData.delete(id); }
        }
        for (const id of refIds) {
          if (tripSubs.has(id)) continue;
          const un = onSnapshot(doc(fdb, 'trips', id),
            (ds) => {
              if (ds.exists()) tripData.set(id, { ...ds.data(), id });
              else tripData.set(id, { id, _error: true });
              push();
            },
            () => { tripData.set(id, { id, _error: true }); push(); });
          tripSubs.set(id, un);
        }
        push();
      }, (e) => console.error('tripRefs', e));
      return () => { unsubRefs(); for (const un of tripSubs.values()) un(); };
    },

    subTrip(id, cb) {
      return onSnapshot(doc(fdb, 'trips', id),
        (ds) => cb(ds.exists() ? { ...ds.data(), id } : null),
        () => cb(null));
    },
    subEvents(id, cb) {
      return onSnapshot(collection(fdb, 'trips', id, 'events'),
        (snap) => cb(snap.docs.map((d) => ({ ...d.data(), id: d.id }))),
        () => cb([]));
    },
    subPlaces(id, cb) {
      return onSnapshot(collection(fdb, 'trips', id, 'places'),
        (snap) => cb(snap.docs.map((d) => ({ ...d.data(), id: d.id }))),
        () => cb([]));
    },
    subMembers(id, cb) {
      return onSnapshot(collection(fdb, 'trips', id, 'members'),
        (snap) => {
          const o = {};
          snap.docs.forEach((d) => { o[d.id] = d.data(); });
          cb(o);
        },
        () => cb({}));
    },

    async createTrip(t) {
      const id = newId();
      const uid = this.uid;
      const batch = writeBatch(fdb);
      batch.set(doc(fdb, 'trips', id), { ...t, ownerUid: uid, createdAt: Date.now(), updatedAt: Date.now() });
      batch.set(doc(fdb, 'users', uid, 'tripRefs', id), { addedAt: Date.now() });
      batch.set(doc(fdb, 'trips', id, 'members', uid), { name: this.identity.name, joinedAt: Date.now() });
      await batch.commit();
      return id;
    },
    async updateTrip(id, patch) {
      await updateDoc(doc(fdb, 'trips', id), { ...patch, updatedAt: Date.now() });
    },
    async deleteTrip(id) {
      for (const sub of ['events', 'places', 'members']) {
        const snap = await getDocs(collection(fdb, 'trips', id, sub));
        if (snap.empty) continue;
        const batch = writeBatch(fdb);
        snap.docs.forEach((d) => batch.delete(d.ref));
        await batch.commit();
      }
      await deleteDoc(doc(fdb, 'trips', id));
      await deleteDoc(doc(fdb, 'users', this.uid, 'tripRefs', id));
    },
    async removeRef(id) {
      await deleteDoc(doc(fdb, 'users', this.uid, 'tripRefs', id));
    },
    async leaveTrip(id) {
      try { await deleteDoc(doc(fdb, 'trips', id, 'members', this.uid)); } catch { /* 権限が無くても続行 */ }
      await deleteDoc(doc(fdb, 'users', this.uid, 'tripRefs', id));
    },
    // 共有リンクから参加
    async joinTrip(id) {
      const ds = await getDoc(doc(fdb, 'trips', id));
      if (!ds.exists()) throw new Error('旅行が見つかりませんでした。リンクを確認してください。');
      const t = ds.data();
      if (!t.isShared && t.ownerUid !== this.uid) {
        throw new Error('この旅行は共有されていません。');
      }
      await setDoc(doc(fdb, 'trips', id, 'members', this.uid), {
        name: this.identity.name, joinedAt: Date.now(),
      }, { merge: true });
      await setDoc(doc(fdb, 'users', this.uid, 'tripRefs', id), { addedAt: Date.now() }, { merge: true });
      return { ...t, id };
    },

    async addEvent(tripId, e) {
      const id = newId();
      await setDoc(doc(fdb, 'trips', tripId, 'events', id), { ...e, createdAt: Date.now() });
      return id;
    },
    async updateEvent(tripId, id, patch) {
      await updateDoc(doc(fdb, 'trips', tripId, 'events', id), patch);
    },
    async deleteEvent(tripId, id) {
      await deleteDoc(doc(fdb, 'trips', tripId, 'events', id));
    },
    async addPlace(tripId, p) {
      const id = newId();
      await setDoc(doc(fdb, 'trips', tripId, 'places', id), { ...p, createdAt: Date.now() });
      return id;
    },
    async updatePlace(tripId, id, patch) {
      await updateDoc(doc(fdb, 'trips', tripId, 'places', id), patch);
    },
    async deletePlace(tripId, id) {
      await deleteDoc(doc(fdb, 'trips', tripId, 'places', id));
    },

    async signInGoogle() {
      const provider = new GoogleAuthProvider();
      const u = auth.currentUser;
      try {
        if (u && u.isAnonymous) {
          await linkWithPopup(u, provider); // 匿名データを引き継いでGoogleに昇格
        } else {
          await signInWithPopup(auth, provider);
        }
      } catch (e) {
        if (e.code === 'auth/credential-already-in-use') {
          const cred = GoogleAuthProvider.credentialFromError(e);
          if (cred) { await signInWithCredential(auth, cred); return; }
        }
        if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment'
          || e.code === 'auth/cancelled-popup-request') {
          await signInWithRedirect(auth, provider);
          return;
        }
        if (e.code === 'auth/popup-closed-by-user') return;
        throw e;
      }
    },
    async signOutUser() {
      await signOut(auth); // onAuthStateChangedで匿名に入り直す
      await signInAnonymously(auth);
    },
  };
  return store;
}
