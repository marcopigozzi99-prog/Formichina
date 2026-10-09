// Stato dell'app, salvataggio in IndexedDB (fallback localStorage) e unione per la sincronizzazione.
import { uid, todayISO, addDays, addMonths } from './util.js';

const DB_NAME = 'formichina';
const STORE = 'kv';
const KEY = 'state';
const LOCAL_KEY = 'formichina-local';

export const COLLECTIONS = ['categories', 'transactions', 'recurring', 'funds', 'goals', 'rules', 'people'];

export const DEFAULT_CATEGORIES = [
  ['Spesa', '🛒', 'expense', '#3f7d5a'],
  ['Bar e ristoranti', '☕', 'expense', '#c26a3d'],
  ['Trasporti', '⛽', 'expense', '#4a6fa5'],
  ['Casa', '🏠', 'expense', '#8a6d3b'],
  ['Bollette', '💡', 'expense', '#c9a227'],
  ['Salute', '💊', 'expense', '#b54b5d'],
  ['Abbigliamento', '👕', 'expense', '#7b5ea7'],
  ['Svago', '🎬', 'expense', '#2f8f8f'],
  ['Figli', '🎒', 'expense', '#d07c9a'],
  ['Regali', '🎁', 'expense', '#a8553f'],
  ['Animali', '🐾', 'expense', '#6c8a3a'],
  ['Abbonamenti', '📺', 'expense', '#5a5f8f'],
  ['Altro', '•', 'expense', '#7d7d7d'],
  ['Stipendio', '💶', 'income', '#2e7d4f'],
  ['Entrate extra', '✨', 'income', '#4f9d69'],
  ['Rimborsi', '↩︎', 'income', '#6aa58a'],
];

const now = () => Date.now();

export function emptyState() {
  const t = now();
  return {
    version: 1,
    settings: {
      name: '',
      payday: 27,
      carryOver: 'save', // 'save' = l'avanzo va nei risparmi, 'carry' = si somma al ciclo dopo
      onboarded: false,
      updatedAt: t,
    },
    categories: DEFAULT_CATEGORIES.map(([name, icon, kind, color], i) => ({
      id: uid(), name, icon, kind, color, limit: 0, order: i, updatedAt: t,
    })),
    people: [{ id: 'p-me', name: 'Io', updatedAt: t }],
    transactions: [],
    recurring: [],
    funds: [],
    goals: [],
    rules: [],
  };
}

// Impostazioni del solo dispositivo (non sincronizzate)
export function defaultLocal() {
  return {
    theme: 'auto',
    pinHash: null,
    reminderHour: 21,
    deviceId: uid(),
    personId: 'p-me',
    sync: { enabled: false, config: null, docId: null, lastSync: null },
    lastBackup: null,
  };
}

// ---------- IndexedDB ----------
let dbPromise = null;
function openDB() {
  if (!('indexedDB' in globalThis)) return Promise.resolve(null);
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  }
  return dbPromise;
}

async function idbGet(key) {
  const db = await openDB();
  if (!db) return JSON.parse(localStorage.getItem(DB_NAME + ':' + key) || 'null');
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readonly');
    const r = tx.objectStore(STORE).get(key);
    r.onsuccess = () => resolve(r.result ?? null);
    r.onerror = () => resolve(null);
  });
}

async function idbSet(key, value) {
  const db = await openDB();
  if (!db) { localStorage.setItem(DB_NAME + ':' + key, JSON.stringify(value)); return; }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadState() {
  const s = await idbGet(KEY);
  return s ? migrate(s) : emptyState();
}

export async function saveState(state) {
  await idbSet(KEY, state);
}

export function loadLocal() {
  try {
    const l = JSON.parse(localStorage.getItem(LOCAL_KEY) || 'null');
    return l ? { ...defaultLocal(), ...l, sync: { ...defaultLocal().sync, ...(l.sync || {}) } } : defaultLocal();
  } catch { return defaultLocal(); }
}

export function saveLocal(local) {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(local)); } catch { /* spazio pieno o modalità privata */ }
}

export function migrate(s) {
  const base = emptyState();
  const out = { ...base, ...s, settings: { ...base.settings, ...(s.settings || {}) } };
  for (const c of COLLECTIONS) if (!Array.isArray(out[c])) out[c] = base[c];
  return out;
}

// ---------- Accesso ai dati ----------
export const alive = (arr) => arr.filter((x) => !x.deleted);

export function upsert(state, coll, item) {
  const list = state[coll];
  const i = list.findIndex((x) => x.id === item.id);
  const rec = { ...item, id: item.id || uid(), updatedAt: now() };
  if (i >= 0) list[i] = { ...list[i], ...rec };
  else list.push(rec);
  return rec;
}

export function remove(state, coll, id) {
  const it = state[coll].find((x) => x.id === id);
  if (it) { it.deleted = true; it.updatedAt = now(); }
}

export function updateSettings(state, patch) {
  state.settings = { ...state.settings, ...patch, updatedAt: now() };
}

// Tombstone più vecchie di 400 giorni: si possono eliminare davvero
export function compact(state) {
  const limit = now() - 400 * 864e5;
  for (const c of COLLECTIONS) state[c] = state[c].filter((x) => !(x.deleted && x.updatedAt < limit));
}

// ---------- Unione (sync tra dispositivi) ----------
// Per ogni elemento vince la versione modificata più di recente; le eliminazioni sono tombstone.
export function mergeStates(a, b) {
  const out = migrate(a);
  const bb = migrate(b);
  out.settings = (bb.settings.updatedAt || 0) > (out.settings.updatedAt || 0) ? bb.settings : out.settings;
  for (const c of COLLECTIONS) {
    const map = new Map(out[c].map((x) => [x.id, x]));
    for (const it of bb[c]) {
      const cur = map.get(it.id);
      if (!cur || (it.updatedAt || 0) > (cur.updatedAt || 0)) map.set(it.id, it);
    }
    out[c] = [...map.values()];
  }
  return out;
}

export function stateFingerprint(s) {
  let h = 0;
  const str = JSON.stringify([s.settings.updatedAt, ...COLLECTIONS.map((c) => s[c].map((x) => x.id + x.updatedAt).sort().join())]);
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return h;
}

// ---------- Dati di esempio ----------
export function demoState() {
  const s = emptyState();
  const t = todayISO();
  const cat = (n) => s.categories.find((c) => c.name === n).id;
  s.settings = { ...s.settings, name: 'Mario Rossi', payday: 27, onboarded: true };
  s.people.push({ id: 'p-2', name: 'Anna Rossi', updatedAt: now() });
  const start = addMonths(t, -3);
  const rec = (name, type, amount, category, day, freq = 'monthly', startDate = start) =>
    upsert(s, 'recurring', { name, type, amount, categoryId: cat(category), day, freq, startDate, personId: 'p-me' });
  rec('Stipendio Mario Rossi', 'income', 185000, 'Stipendio', 27);
  rec('Stipendio Anna Rossi', 'income', 142000, 'Stipendio', 10);
  rec('Mutuo', 'expense', 68000, 'Casa', 1);
  rec('Luce e gas', 'expense', 13000, 'Bollette', 15, 'bimonthly');
  rec('Internet', 'expense', 2990, 'Bollette', 5);
  rec('Streaming', 'expense', 1799, 'Abbonamenti', 12);
  rec('Palestra', 'expense', 4500, 'Svago', 3);
  s.categories.find((c) => c.name === 'Spesa').limit = 55000;
  s.categories.find((c) => c.name === 'Bar e ristoranti').limit = 15000;
  s.categories.find((c) => c.name === 'Trasporti').limit = 18000;
  upsert(s, 'funds', { name: 'Assicurazione auto', icon: '🚗', target: 62000, dueDate: addMonths(t, 5), repeat: 'yearly', initial: 20000 });
  upsert(s, 'funds', { name: 'Regali di Natale', icon: '🎄', target: 40000, dueDate: `${t.slice(0, 4)}-12-15`, repeat: 'yearly', initial: 10000 });
  upsert(s, 'funds', { name: 'Bollo auto', icon: '🧾', target: 21000, dueDate: addMonths(t, 8), repeat: 'yearly', initial: 0 });
  upsert(s, 'goals', { name: 'Fondo emergenze', icon: '🛟', target: 600000, deadline: addMonths(t, 18), monthly: 20000, initial: 180000 });
  upsert(s, 'goals', { name: 'Vacanza estate', icon: '🏖️', target: 250000, deadline: addMonths(t, 9), monthly: 15000, initial: 30000 });
  upsert(s, 'rules', { keyword: 'esselunga', categoryId: cat('Spesa') });
  upsert(s, 'rules', { keyword: 'coop', categoryId: cat('Spesa') });
  upsert(s, 'rules', { keyword: 'eni', categoryId: cat('Trasporti') });
  // spese variabili degli ultimi 75 giorni (pseudo-casuali ma ripetibili)
  let seed = 7;
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  const pool = [
    ['Spesa', 'Esselunga', 2500, 9000], ['Spesa', 'Mercato', 800, 2500], ['Bar e ristoranti', 'Caffè', 150, 450],
    ['Bar e ristoranti', 'Pizzeria', 2500, 5500], ['Trasporti', 'Benzina', 3000, 6500], ['Svago', 'Cinema', 1200, 2400],
    ['Abbigliamento', 'Scarpe', 3000, 9000], ['Salute', 'Farmacia', 600, 2500], ['Figli', 'Materiale scuola', 800, 3500],
    ['Animali', 'Crocchette', 1500, 3500], ['Casa', 'Ferramenta', 500, 3000],
  ];
  for (let d = -75; d <= 0; d++) {
    const date = addDays(t, d);
    const n = rnd() < 0.2 ? 0 : 1 + Math.floor(rnd() * 2.4);
    for (let k = 0; k < n; k++) {
      const [c, note, lo, hi] = pool[Math.floor(rnd() * (k === 0 ? 3 : pool.length))];
      upsert(s, 'transactions', {
        type: 'expense', amount: Math.round((lo + rnd() * (hi - lo)) / 10) * 10, date, categoryId: cat(c), note,
        personId: rnd() < 0.6 ? 'p-me' : 'p-2',
      });
    }
  }
  return s;
}
