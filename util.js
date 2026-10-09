// Utility condivise: date locali "YYYY-MM-DD", importi in centesimi, formattazione italiana.

export const uid = () =>
  (globalThis.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

export const pad = (n) => String(n).padStart(2, '0');

export const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const fromISO = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d, 12); // mezzogiorno: evita salti dovuti all'ora legale
};

export const todayISO = () => toISO(new Date());

export const addDays = (s, n) => {
  const d = fromISO(s);
  d.setDate(d.getDate() + n);
  return toISO(d);
};

// giorni da a → b (b - a)
export const diffDays = (a, b) => Math.round((fromISO(b) - fromISO(a)) / 864e5);

export const daysInMonth = (y, m0) => new Date(y, m0 + 1, 0).getDate();

export const clampDay = (y, m0, day) => {
  // normalizza mesi fuori range (es. m0 = 12 → gennaio anno dopo)
  const yy = y + Math.floor(m0 / 12);
  const mm = ((m0 % 12) + 12) % 12;
  return toISO(new Date(yy, mm, Math.min(day, daysInMonth(yy, mm)), 12));
};

export const addMonths = (s, n) => {
  const d = fromISO(s);
  return clampDay(d.getFullYear(), d.getMonth() + n, d.getDate());
};

const MESI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
const MESI_BREVI = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
const GIORNI = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
const GIORNI_BREVI = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];

export const MONTHS = MESI;
export const WEEKDAYS_SHORT = GIORNI_BREVI;

export const fmtDate = (s, opts = {}) => {
  const d = fromISO(s);
  if (opts.long) return `${GIORNI[d.getDay()]} ${d.getDate()} ${MESI[d.getMonth()]}`;
  if (opts.year) return `${d.getDate()} ${MESI_BREVI[d.getMonth()]} ${d.getFullYear()}`;
  return `${d.getDate()} ${MESI_BREVI[d.getMonth()]}`;
};

export const fmtDayHeader = (s) => {
  const t = todayISO();
  if (s === t) return 'Oggi';
  if (s === addDays(t, -1)) return 'Ieri';
  const d = fromISO(s);
  const sameYear = d.getFullYear() === fromISO(t).getFullYear();
  const base = `${GIORNI[d.getDay()]} ${d.getDate()} ${MESI[d.getMonth()]}`;
  return sameYear ? base : `${base} ${d.getFullYear()}`;
};

export const monthLabel = (s) => {
  const d = fromISO(s);
  return `${MESI[d.getMonth()]} ${d.getFullYear()}`;
};

const eur = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' });
const eur0 = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });

export const money = (c) => eur.format((c || 0) / 100);
export const money0 = (c) => eur0.format(Math.round((c || 0) / 100));
export const moneyPlain = (c) => ((c || 0) / 100).toFixed(2).replace('.', ',');

// "1.234,56" | "1234.56" | "12,5" | "-45" → centesimi interi (null se non valido)
export const parseAmount = (input) => {
  if (input === null || input === undefined) return null;
  let s = String(input).trim().replace(/[€\s ]/g, '').replace(/EUR/i, '');
  if (!s) return null;
  let neg = false;
  if (s.startsWith('(') && s.endsWith(')')) { neg = true; s = s.slice(1, -1); }
  if (s.startsWith('-')) { neg = true; s = s.slice(1); }
  else if (s.startsWith('+')) s = s.slice(1);
  if (s.endsWith('-')) { neg = true; s = s.slice(0, -1); }
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma > -1) {
    s = /^\d{1,3}(,\d{3})+$/.test(s) && !/,\d{1,2}$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (lastDot > -1) {
    if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  }
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return null;
  const v = Math.round(parseFloat(s) * 100);
  if (!Number.isFinite(v)) return null;
  return neg ? -v : v;
};

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

export const debounce = (fn, ms) => {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};

export const sum = (arr, f = (x) => x) => arr.reduce((a, x) => a + f(x), 0);

export const sha256Hex = async (text) => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
};
