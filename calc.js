// Motore di calcolo: ciclo dello stipendio, generazione ricorrenti/accantonamenti, budget giornaliero.
import { addDays, diffDays, clampDay, fromISO, todayISO, sum } from './util.js';
import { alive, upsert } from './store.js';

export const FREQ = {
  monthly: { label: 'Ogni mese', short: 'mese', months: 1 },
  bimonthly: { label: 'Ogni 2 mesi', short: '2 mesi', months: 2 },
  quarterly: { label: 'Ogni 3 mesi', short: '3 mesi', months: 3 },
  semiannual: { label: 'Ogni 6 mesi', short: '6 mesi', months: 6 },
  yearly: { label: 'Ogni anno', short: 'anno', months: 12 },
};

// ---------- Ciclo ----------
export function cycleFor(date, payday = 1) {
  const d = fromISO(date);
  const y = d.getFullYear();
  const m = d.getMonth();
  const thisPay = clampDay(y, m, payday);
  const start = date >= thisPay ? thisPay : clampDay(y, m - 1, payday);
  const s = fromISO(start);
  const next = clampDay(s.getFullYear(), s.getMonth() + 1, payday);
  const end = addDays(next, -1);
  return { start, end, next, days: diffDays(start, end) + 1 };
}

export const prevCycle = (cyc, payday) => cycleFor(addDays(cyc.start, -1), payday);

// ---------- Ricorrenti ----------
export function dueDates(r, from, to) {
  const out = [];
  if (!r.startDate || to < from) return out;
  const interval = (FREQ[r.freq] || FREQ.monthly).months;
  const sd = fromISO(r.startDate);
  const anchor = r.anchorMonth != null
    ? sd.getFullYear() * 12 + Number(r.anchorMonth)
    : sd.getFullYear() * 12 + sd.getMonth();
  const f = fromISO(from);
  const t = fromISO(to);
  for (let mi = f.getFullYear() * 12 + f.getMonth() - 1; mi <= t.getFullYear() * 12 + t.getMonth() + 1; mi++) {
    const diff = mi - anchor;
    if (((diff % interval) + interval) % interval !== 0) continue;
    const date = clampDay(Math.floor(mi / 12), mi % 12, Number(r.day) || 1);
    if (date < from || date > to) continue;
    if (date < r.startDate) continue;
    if (r.endDate && date > r.endDate) continue;
    out.push(date);
  }
  return out;
}

export function nextDue(r, from = todayISO()) {
  const list = dueDates(r, from, addDays(from, 400));
  return list[0] || null;
}

// ---------- Saldi di accantonamenti e obiettivi ----------
export function potBalance(state, kind, id, excludeTxId = null) {
  const key = kind === 'fund' ? 'fundId' : 'goalId';
  const pot = state[kind === 'fund' ? 'funds' : 'goals'].find((x) => x.id === id);
  let bal = pot?.initial || 0;
  for (const t of state.transactions) {
    if (t.deleted || t[key] !== id || t.id === excludeTxId) continue;
    if (t.type === 'save') bal += t.amount;
    else if (t.type === 'expense') bal -= t.amount;
    else if (t.type === 'withdraw') bal -= t.amount;
  }
  return bal;
}

export function cyclesUntil(cyc, dueDate, payday) {
  let n = 0;
  let c = cyc;
  while (c.start <= dueDate && n < 240) { n++; c = cycleFor(c.next, payday); }
  return n;
}

export function fundQuota(state, fund, cyc, excludeTxId = null) {
  const bal = potBalance(state, 'fund', fund.id, excludeTxId);
  const need = (fund.target || 0) - bal;
  if (need <= 0 || !fund.dueDate) return 0;
  const n = cyclesUntil(cyc, fund.dueDate, state.settings.payday);
  if (n <= 0) return 0;
  return Math.ceil(need / n / 100) * 100; // arrotondato all'euro per eccesso
}

export function goalQuota(state, goal, excludeTxId = null) {
  const saved = potBalance(state, 'goal', goal.id, excludeTxId);
  const left = (goal.target || 0) - saved;
  if (goal.paused) return 0;
  if (!goal.target) return goal.monthly || 0; // obiettivo "aperto" (es. risparmio libero)
  return Math.max(0, Math.min(goal.monthly || 0, left));
}

export function goalSuggestion(state, goal, cyc) {
  const left = (goal.target || 0) - potBalance(state, 'goal', goal.id);
  if (left <= 0 || !goal.deadline) return 0;
  const n = cyclesUntil(cyc, goal.deadline, state.settings.payday);
  return n > 0 ? Math.ceil(left / n / 100) * 100 : left;
}

// ---------- Generazione automatica ----------
// Crea i movimenti ricorrenti scaduti e le quote di accantonamento/risparmio del ciclo corrente.
export function generate(state, today = todayISO()) {
  let changed = 0;
  const cyc = cycleFor(today, state.settings.payday);
  const have = new Set(state.transactions.filter((t) => t.recurringId).map((t) => t.recurringId + '|' + t.date));
  const floor = addDays(today, -62);
  for (const r of alive(state.recurring)) {
    if (r.paused) continue;
    const from = r.startDate > floor ? r.startDate : floor;
    for (const date of dueDates(r, from, today)) {
      if (have.has(r.id + '|' + date)) continue;
      upsert(state, 'transactions', {
        type: r.type, amount: r.amount, date, categoryId: r.categoryId, note: r.name,
        recurringId: r.id, personId: r.personId || 'p-me', auto: true,
      });
      have.add(r.id + '|' + date);
      changed++;
    }
  }
  // scadenze annuali superate → si sposta la scadenza all'anno dopo
  for (const f of alive(state.funds)) {
    if (f.repeat === 'yearly' && f.dueDate && f.dueDate < cyc.start) {
      let d = f.dueDate;
      while (d < cyc.start) { const x = fromISO(d); d = clampDay(x.getFullYear() + 1, x.getMonth(), x.getDate()); }
      upsert(state, 'funds', { ...f, dueDate: d });
      changed++;
    }
  }
  const saveKey = new Set(state.transactions.filter((t) => t.type === 'save' && t.cycleStart).map((t) => (t.fundId || t.goalId) + '|' + t.cycleStart));
  for (const f of alive(state.funds)) {
    if (f.paused || (f.createdOn && f.createdOn > cyc.end)) continue;
    if (saveKey.has(f.id + '|' + cyc.start)) continue;
    const amount = fundQuota(state, f, cyc);
    upsert(state, 'transactions', { type: 'save', amount, date: cyc.start, fundId: f.id, cycleStart: cyc.start, auto: true, note: f.name });
    changed++;
  }
  for (const g of alive(state.goals)) {
    if (g.createdOn && g.createdOn > cyc.end) continue;
    if (saveKey.has(g.id + '|' + cyc.start)) continue;
    const amount = goalQuota(state, g);
    upsert(state, 'transactions', { type: 'save', amount, date: cyc.start, goalId: g.id, cycleStart: cyc.start, auto: true, note: g.name });
    changed++;
  }
  return changed;
}

// Ricalcola la quota del ciclo corrente di un accantonamento/obiettivo (dopo una modifica)
export function refreshPotQuota(state, kind, id, today = todayISO()) {
  const cyc = cycleFor(today, state.settings.payday);
  const key = kind === 'fund' ? 'fundId' : 'goalId';
  const tx = state.transactions.find((t) => !t.deleted && t.type === 'save' && t[key] === id && t.cycleStart === cyc.start && t.auto);
  const pot = state[kind === 'fund' ? 'funds' : 'goals'].find((x) => x.id === id);
  if (!pot) return;
  if (pot.deleted) { if (tx) { tx.deleted = true; tx.updatedAt = Date.now(); } return; }
  const amount = kind === 'fund' ? fundQuota(state, pot, cyc, tx?.id) : goalQuota(state, pot, tx?.id);
  if (tx) upsert(state, 'transactions', { ...tx, amount, note: pot.name });
  else generate(state, today);
}

// ---------- Calcolo del ciclo ----------
const isVariable = (t) => t.type === 'expense' && !t.recurringId && !t.fundId && !t.goalId;

export function computeCycle(state, asOf = todayISO(), opts = {}) {
  const payday = state.settings.payday;
  const cyc = opts.cycle || cycleFor(asOf, payday);
  const txs = state.transactions.filter((t) => !t.deleted && t.date >= cyc.start && t.date <= cyc.end);
  const existing = new Set(state.transactions.filter((t) => t.recurringId).map((t) => t.recurringId + '|' + t.date));

  const planned = [];
  for (const r of alive(state.recurring)) {
    if (r.paused) continue;
    for (const date of dueDates(r, cyc.start, cyc.end)) {
      if (!existing.has(r.id + '|' + date)) planned.push({ ...r, date });
    }
  }

  const incomeTx = sum(txs.filter((t) => t.type === 'income'), (t) => t.amount);
  const incomePlanned = sum(planned.filter((p) => p.type === 'income'), (p) => p.amount);
  const fixedTx = sum(txs.filter((t) => t.type === 'expense' && t.recurringId), (t) => t.amount);
  const fixedPlanned = sum(planned.filter((p) => p.type === 'expense'), (p) => p.amount);
  const saves = txs.filter((t) => t.type === 'save');
  const reservedFunds = sum(saves.filter((t) => t.fundId), (t) => t.amount);
  const reservedGoals = sum(saves.filter((t) => t.goalId), (t) => t.amount);
  const fromSavings = sum(txs.filter((t) => t.type === 'expense' && (t.fundId || t.goalId)), (t) => t.amount);

  let carryIn = 0;
  if (state.settings.carryOver === 'carry' && opts.carry !== false) {
    const pc = prevCycle(cyc, payday);
    const prev = computeCycle(state, pc.end, { carry: false, cycle: pc });
    if (prev.incomes > 0) carryIn = prev.remaining;
  }

  const incomes = incomeTx + incomePlanned;
  const fixed = fixedTx + fixedPlanned;
  const reserved = reservedFunds + reservedGoals;
  const base = incomes + carryIn - fixed - reserved;

  const variable = txs.filter(isVariable);
  const day = asOf < cyc.start ? cyc.start : asOf > cyc.end ? cyc.end : asOf;
  const spentBefore = sum(variable.filter((t) => t.date < day), (t) => t.amount);
  const spentToday = sum(variable.filter((t) => t.date === day), (t) => t.amount);
  const spentAfter = sum(variable.filter((t) => t.date > day), (t) => t.amount);
  const variableTotal = spentBefore + spentToday + spentAfter;

  const daysLeft = diffDays(day, cyc.end) + 1;
  const elapsed = diffDays(cyc.start, day) + 1;
  const available = base - spentBefore - spentAfter;
  const budgetToday = Math.floor(available / daysLeft);
  const leftToday = budgetToday - spentToday;
  const stable = Math.floor(base / cyc.days);
  const remaining = base - variableTotal;
  const tomorrow = daysLeft > 1 ? Math.floor((available - spentToday) / (daysLeft - 1)) : null;
  const paceExpected = stable * elapsed;
  const paceActual = spentBefore + spentToday;

  const byCat = new Map();
  for (const t of txs) {
    if (t.type !== 'expense') continue;
    const k = t.categoryId || 'none';
    const e = byCat.get(k) || { total: 0, variable: 0, fixed: 0, fromSavings: 0, count: 0 };
    e.total += t.amount; e.count++;
    if (isVariable(t)) e.variable += t.amount; else if (t.recurringId) e.fixed += t.amount; else e.fromSavings += t.amount;
    byCat.set(k, e);
  }
  for (const p of planned.filter((x) => x.type === 'expense')) {
    const k = p.categoryId || 'none';
    const e = byCat.get(k) || { total: 0, variable: 0, fixed: 0, fromSavings: 0, count: 0 };
    e.plannedFixed = (e.plannedFixed || 0) + p.amount;
    byCat.set(k, e);
  }

  const envelopes = alive(state.categories)
    .filter((c) => c.kind === 'expense' && c.limit > 0)
    .map((c) => {
      const e = byCat.get(c.id);
      const spent = e ? e.total - e.fromSavings : 0;
      return { category: c, limit: c.limit, spent, left: c.limit - spent, ratio: spent / c.limit, expectedRatio: elapsed / cyc.days };
    });

  return {
    cycle: cyc, asOf: day, planned, txs,
    incomes, incomeTx, incomePlanned, fixed, fixedTx, fixedPlanned,
    reserved, reservedFunds, reservedGoals, fromSavings, carryIn,
    base, available, spentBefore, spentToday, spentAfter, variableTotal,
    daysLeft, elapsed, budgetToday, leftToday, stable, remaining, tomorrow,
    paceExpected, paceActual, byCat, envelopes,
  };
}

// Budget e spesa giorno per giorno nel ciclo, fino a "asOf"
export function dailySeries(state, asOf = todayISO(), calc = null) {
  const c = calc || computeCycle(state, asOf);
  const variable = c.txs.filter(isVariable);
  const out = [];
  let before = 0;
  for (let d = c.cycle.start; d <= c.cycle.end; d = addDays(d, 1)) {
    const spent = sum(variable.filter((t) => t.date === d), (t) => t.amount);
    const daysLeft = diffDays(d, c.cycle.end) + 1;
    const future = sum(variable.filter((t) => t.date > d), (t) => t.amount);
    const budget = Math.floor((c.base - before - (d > asOf ? 0 : future)) / daysLeft);
    out.push({ date: d, spent, budget: d > asOf ? c.budgetToday : budget, future: d > asOf });
    if (d <= asOf) before += spent;
  }
  return out;
}

// Giorni consecutivi chiusi entro il budget
export function streak(state, today = todayISO()) {
  const variable = state.transactions.filter((t) => !t.deleted && isVariable(t));
  const firstDate = state.transactions.filter((t) => !t.deleted).reduce((m, t) => (t.date < m ? t.date : m), today);
  const cache = new Map();
  let n = 0;
  let d = addDays(today, -1);
  for (let i = 0; i < 180 && d >= firstDate; i++, d = addDays(d, -1)) {
    const cyc = cycleFor(d, state.settings.payday);
    let c = cache.get(cyc.start);
    if (!c) { c = computeCycle(state, cyc.end, { cycle: cyc }); cache.set(cyc.start, c); }
    if (c.incomes <= 0) break;
    const before = sum(variable.filter((t) => t.date >= cyc.start && t.date < d), (t) => t.amount);
    const budget = (c.base - before) / (diffDays(d, cyc.end) + 1);
    const spent = sum(variable.filter((t) => t.date === d), (t) => t.amount);
    if (spent <= budget) n++; else break;
  }
  return n;
}

// Riepilogo degli ultimi n cicli (il primo è quello corrente)
export function cycleHistory(state, n = 6, today = todayISO()) {
  const out = [];
  let cyc = cycleFor(today, state.settings.payday);
  for (let i = 0; i < n; i++) {
    const asOf = cyc.end < today ? cyc.end : today;
    const c = computeCycle(state, asOf, { cycle: cyc });
    out.push({
      cycle: cyc, current: i === 0, incomes: c.incomes, fixed: c.fixed, variable: c.variableTotal,
      reserved: c.reserved, fromSavings: c.fromSavings, remaining: c.remaining, base: c.base,
    });
    cyc = prevCycle(cyc, state.settings.payday);
  }
  return out;
}

export function weekdayAverages(state, days = 84, today = todayISO()) {
  const from = addDays(today, -days + 1);
  const totals = new Array(7).fill(0);
  const counts = new Array(7).fill(0);
  for (let d = from; d <= today; d = addDays(d, 1)) counts[fromISO(d).getDay()]++;
  for (const t of state.transactions) {
    if (t.deleted || !isVariable(t) || t.date < from || t.date > today) continue;
    totals[fromISO(t.date).getDay()] += t.amount;
  }
  return totals.map((v, i) => (counts[i] ? Math.round(v / counts[i]) : 0));
}

export { isVariable };
