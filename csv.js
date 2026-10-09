// Lettura degli estratti conto CSV dell'home banking, tutto in locale nel browser.
import { parseAmount, pad, sha256Hex } from './util.js';

export function decodeFile(buffer) {
  const utf8 = new TextDecoder('utf-8').decode(buffer);
  if (!utf8.includes('�')) return utf8.replace(/^﻿/, '');
  try { return new TextDecoder('windows-1252').decode(buffer); } catch { return utf8; }
}

export function detectDelimiter(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 20);
  const cands = [';', ',', '\t', '|'];
  let best = ';';
  let bestScore = -1;
  for (const d of cands) {
    const counts = lines.map((l) => splitLine(l, d).length);
    const max = Math.max(...counts);
    const score = counts.filter((c) => c === max).length * (max > 1 ? max : 0);
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

function splitLine(line, d) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === d) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

export function parseCSV(text, delimiter) {
  const d = delimiter || detectDelimiter(text);
  // gestisce i ritorni a capo dentro le virgolette
  const rows = [];
  let buf = '';
  let quotes = 0;
  for (const line of text.split(/\r?\n/)) {
    buf = buf ? buf + '\n' + line : line;
    quotes += (line.match(/"/g) || []).length;
    if (quotes % 2 === 0) { if (buf.trim()) rows.push(splitLine(buf, d)); buf = ''; quotes = 0; }
  }
  if (buf.trim()) rows.push(splitLine(buf, d));
  return { rows, delimiter: d };
}

export function parseDate(s) {
  if (!s) return null;
  const t = String(s).trim().split(/[ T]/)[0];
  let m = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) {
    let y = +m[3];
    if (y < 100) y += 2000;
    return valid(y, +m[2], +m[1]);
  }
  return null;
}

function valid(y, mo, d) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
  return `${y}-${pad(mo)}-${pad(d)}`;
}

const H = {
  date: [/data\s*(operazione|contabile|registrazione|movimento)/i, /^data$/i, /date/i, /data/i],
  valueDate: [/valuta/i],
  desc: [/descrizione/i, /causale/i, /dettagli/i, /operazione/i, /description/i, /beneficiario/i, /memo/i],
  amount: [/^importo/i, /ammontare/i, /amount/i, /importo/i],
  debit: [/addebit/i, /uscit/i, /^dare$/i, /debit/i, /pagament/i],
  credit: [/accredit/i, /entrat/i, /^avere$/i, /credit/i],
};

function findCol(header, patterns, used) {
  for (const p of patterns) {
    const i = header.findIndex((h, idx) => !used.has(idx) && p.test(h));
    if (i >= 0) return i;
  }
  return -1;
}

// Riga di intestazione: la prima riga seguita da righe con una data valida
export function guessHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length - 1, 40); i++) {
    const r = rows[i];
    if (r.filter((c) => c).length < 2) continue;
    if (r.some((c) => parseDate(c))) continue;
    const next = rows.slice(i + 1, i + 4);
    if (next.length && next.every((n) => n.some((c) => parseDate(c)))) return i;
  }
  return 0;
}

export function guessMapping(rows, headerRow) {
  const header = (rows[headerRow] || []).map((h) => h.toLowerCase());
  const used = new Set();
  const take = (k) => { const i = findCol(header, H[k], used); if (i >= 0) used.add(i); return i; };
  const map = { date: take('date') };
  take('valueDate');
  map.desc = take('desc');
  map.amount = take('amount');
  map.debit = map.amount >= 0 ? -1 : take('debit');
  map.credit = map.amount >= 0 ? -1 : take('credit');
  if (map.amount < 0 && map.debit < 0 && map.credit < 0) {
    // nessuna intestazione riconosciuta: cerca la colonna che sembra un importo
    const sample = rows[headerRow + 1] || [];
    map.amount = sample.findIndex((c, i) => i !== map.date && /\d/.test(c) && parseAmount(c) !== null && !parseDate(c));
  }
  if (map.date < 0) map.date = (rows[headerRow + 1] || []).findIndex((c) => parseDate(c));
  if (map.desc < 0) {
    const sample = rows[headerRow + 1] || [];
    let best = -1;
    let len = 0;
    sample.forEach((c, i) => { if (![map.date, map.amount, map.debit, map.credit].includes(i) && c.length > len) { best = i; len = c.length; } });
    map.desc = best;
  }
  return map;
}

// Restituisce i movimenti normalizzati: { date, amount (centesimi, positivo), type, desc, key }
export async function extract(rows, headerRow, map) {
  const out = [];
  for (let i = headerRow + 1; i < rows.length; i++) {
    const r = rows[i];
    const date = parseDate(r[map.date]);
    if (!date) continue;
    let amt = null;
    if (map.amount >= 0) amt = parseAmount(r[map.amount]);
    else {
      const deb = map.debit >= 0 ? parseAmount(r[map.debit]) : null;
      const cre = map.credit >= 0 ? parseAmount(r[map.credit]) : null;
      if (deb) amt = -Math.abs(deb);
      else if (cre) amt = Math.abs(cre);
    }
    if (amt === null || amt === 0) continue;
    const desc = (map.desc >= 0 ? r[map.desc] : '').replace(/\s+/g, ' ').trim();
    const key = (await sha256Hex(`${date}|${amt}|${desc.toLowerCase()}`)).slice(0, 24);
    out.push({ date, amount: Math.abs(amt), type: amt < 0 ? 'expense' : 'income', desc, key });
  }
  return out;
}

export function applyRules(desc, rules, fallback) {
  const d = (desc || '').toLowerCase();
  for (const r of rules) {
    if (r.deleted || !r.keyword) continue;
    if (d.includes(r.keyword.toLowerCase())) return r.categoryId;
  }
  return fallback;
}

// Esportazione movimenti in CSV leggibile da Excel italiano
export function toCSV(rows) {
  const q = (v) => {
    const s = String(v ?? '');
    return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return '﻿' + rows.map((r) => r.map(q).join(';')).join('\r\n');
}
