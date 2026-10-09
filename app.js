// Formichina — interfaccia. Tutto gira nel browser; i dati restano sul dispositivo.
import {
  uid, todayISO, addDays, diffDays, fmtDate, fmtDayHeader, money, money0, moneyPlain, parseAmount, esc, debounce, sum,
  sha256Hex, fromISO, MONTHS,
} from './util.js';
import {
  loadState, saveState, loadLocal, saveLocal, alive, upsert, remove, updateSettings, mergeStates, stateFingerprint,
  demoState, emptyState, migrate, compact,
} from './store.js';
import {
  FREQ, cycleFor, prevCycle, computeCycle, generate, refreshPotQuota, dailySeries, streak, cycleHistory,
  weekdayAverages, potBalance, fundQuota, goalSuggestion, nextDue, isVariable,
} from './calc.js';
import { ring, dailyChart, historyChart, weekdayChart } from './charts.js';
import { decodeFile, parseCSV, guessHeaderRow, guessMapping, extract, applyRules, toCSV } from './csv.js';
import { Sync, deriveSecret, parseFirebaseConfig } from './sync.js';

let state;
let local;
let sync = null;
let syncStatus = '';
const ui = {
  tab: 'oggi', planTab: 'riepilogo', txOffset: 0, statsOffset: 0, search: '', filter: 'all', cat: '',
  ob: 0, obData: null, locked: false, hiddenAt: 0, csv: null,
};

const $ = (s, el = document) => el.querySelector(s);
const view = () => $('#view');

// ---------- Helpers dati ----------
const cats = () => alive(state.categories).sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
const catById = (id) => state.categories.find((c) => c.id === id);
const catsOf = (kind) => cats().filter((c) => c.kind === kind);
const people = () => alive(state.people);
const personName = (id) => people().find((p) => p.id === id)?.name || '';
const fundById = (id) => state.funds.find((f) => f.id === id);
const goalById = (id) => state.goals.find((g) => g.id === id);
const fallbackCat = (kind) => catsOf(kind).find((c) => c.name === 'Altro') || catsOf(kind)[catsOf(kind).length - 1];

const icon = (c, size = '') => c
  ? `<span class="ico ${size}" style="--c:${esc(c.color || '#888')}">${esc(c.icon || '•')}</span>`
  : '<span class="ico">•</span>';

const bigMoney = (c) => {
  const neg = c < 0;
  const s = money(Math.abs(c)).replace(/\s?€/, '');
  const [int, dec] = s.split(',');
  return `<span class="bm ${neg ? 'neg' : ''}">${neg ? '−' : ''}<span class="bm-int">${int}</span><span class="bm-dec">,${dec} €</span></span>`;
};

function txLabel(t) {
  if (t.type === 'save') return t.note || (t.fundId ? fundById(t.fundId)?.name : goalById(t.goalId)?.name) || 'Accantonamento';
  return t.note || catById(t.categoryId)?.name || 'Movimento';
}

function txSource(t) {
  if (t.recurringId) return 'fissa';
  if (t.fundId) return 'da ' + (fundById(t.fundId)?.name || 'accantonamento');
  if (t.goalId) return 'da ' + (goalById(t.goalId)?.name || 'obiettivo');
  if (t.importKey) return 'importata';
  return '';
}

// ---------- Salvataggio ----------
const pushLater = debounce(() => { if (sync) sync.push(state); }, 1500);

async function commit(message) {
  try { await saveState(state); } catch (e) { toast('Errore di salvataggio: ' + e.message, true); }
  render();
  if (message) toast(message);
  pushLater();
}

function saveLocalAnd(fn) { fn?.(); saveLocal(local); }

// ---------- Toast ----------
let toastTimer;
function toast(msg, error = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show' + (error ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2600);
}

// ---------- Tema ----------
function applyTheme() {
  const t = local.theme;
  document.documentElement.dataset.theme = t === 'auto' ? '' : t;
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  $('meta[name="theme-color"]').setAttribute('content', dark ? '#141815' : '#f5f1e8');
}

// ---------- Render principale ----------
function render() {
  const app = $('#app');
  if (!state.settings.onboarded) {
    app.classList.add('onboarding');
    view().innerHTML = renderOnboarding();
    $('#topTitle').innerHTML = '';
    return;
  }
  app.classList.remove('onboarding');
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === ui.tab));
  const titles = { oggi: 'Formichina', movimenti: 'Movimenti', piano: 'Piano', stats: 'Statistiche', altro: 'Altro' };
  $('#topTitle').textContent = titles[ui.tab];
  $('#syncDot').hidden = !local.sync.enabled;
  $('#syncDot').title = 'Sincronizzazione: ' + (syncStatus || 'in attesa');
  $('#syncDot').classList.toggle('err', syncStatus.startsWith('errore'));
  const r = { oggi: renderToday, movimenti: renderTx, piano: renderPlan, stats: renderStats, altro: renderMore }[ui.tab];
  view().innerHTML = r();
  $('#fab').hidden = ui.tab === 'altro';
}

// ================= OGGI =================
function renderToday() {
  const today = todayISO();
  const c = computeCycle(state, today);
  const st = streak(state, today);
  const h = new Date().getHours();
  const hello = h < 6 ? 'Buonanotte' : h < 13 ? 'Buongiorno' : h < 18 ? 'Buon pomeriggio' : 'Buonasera';
  const name = state.settings.name ? ', ' + esc(state.settings.name) : '';
  const ratio = c.budgetToday > 0 ? c.spentToday / c.budgetToday : (c.spentToday > 0 ? 2 : 1);
  const daysToPay = diffDays(today, c.cycle.next);

  let msg;
  if (c.available <= 0) msg = `<p class="hero-note warn">Il ciclo è già in rosso di ${money(-c.available)}. Rivedi le spese fisse o usa un accantonamento.</p>`;
  else if (c.leftToday < 0) msg = `<p class="hero-note warn">Oggi hai superato di ${money(-c.leftToday)}. Da domani: <b>${money(c.tomorrow ?? 0)}</b> al giorno.</p>`;
  else if (c.tomorrow != null) msg = `<p class="hero-note">Se ti fermi qui, domani avrai <b>${money(c.tomorrow)}</b>.</p>`;
  else msg = '<p class="hero-note">Ultimo giorno del ciclo: domani arriva lo stipendio.</p>';

  const paceDiff = c.paceExpected - c.paceActual;
  const paceMax = Math.max(c.paceExpected, c.paceActual, c.base, 1);
  const pace = `<div class="card pace">
      <div class="row-between"><span class="label">Ritmo del ciclo</span>
      <span class="${paceDiff >= 0 ? 'good' : 'bad'}">${paceDiff >= 0 ? 'In anticipo di ' + money0(paceDiff) : 'In ritardo di ' + money0(-paceDiff)}</span></div>
      <div class="track"><div class="fill ${paceDiff < 0 ? 'over' : ''}" style="width:${Math.min(100, (c.paceActual / paceMax) * 100).toFixed(1)}%"></div>
      <div class="marker" style="left:${Math.min(100, (c.paceExpected / paceMax) * 100).toFixed(1)}%"></div></div>
      <div class="row-between small muted"><span>Speso ${money0(c.paceActual)}</span><span>previsto ad oggi ${money0(c.paceExpected)}</span></div>
    </div>`;

  // categorie più usate per l'inserimento rapido
  const freq = new Map();
  for (const t of state.transactions) if (!t.deleted && isVariable(t) && t.date >= addDays(today, -60)) freq.set(t.categoryId, (freq.get(t.categoryId) || 0) + 1);
  let quick = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => catById(id)).filter((x) => x && !x.deleted).slice(0, 5);
  if (quick.length < 5) quick = [...quick, ...catsOf('expense').filter((x) => !quick.includes(x))].slice(0, 5);

  const todays = alive(state.transactions).filter((t) => t.date === today && t.type !== 'save').sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  const upcoming = c.planned.filter((p) => p.date >= today).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 4);
  const dueFunds = alive(state.funds).filter((f) => f.dueDate && f.dueDate >= today && diffDays(today, f.dueDate) <= 45);

  const env = c.envelopes.filter((e) => e.spent > 0).sort((a, b) => b.ratio - a.ratio).slice(0, 3);

  const banners = [];
  if (h >= local.reminderHour && !todays.some((t) => t.type === 'expense')) {
    banners.push(`<div class="banner"><span>Hai registrato le spese di oggi?</span><button class="btn small" data-action="add">Aggiungi</button></div>`);
  }
  const lastB = local.lastBackup ? diffDays(local.lastBackup.slice(0, 10), today) : 999;
  if (!local.sync.enabled && lastB > 30 && state.transactions.length > 20) {
    banners.push(`<div class="banner soft"><span>I dati sono solo su questo telefono. Fai un backup.</span><button class="btn small ghost" data-action="export-json">Backup</button></div>`);
  }

  return `
  <section class="today">
    <div class="greet"><h1>${hello}${name}</h1>
      <p class="muted">${fmtDate(today, { long: true })} · ${daysToPay === 1 ? 'domani' : `tra ${daysToPay} giorni`} lo stipendio</p></div>
    ${banners.join('')}
    <div class="card hero">
      <div class="ring-wrap">${ring(ratio)}
        <div class="ring-center">
          <span class="label">${c.leftToday >= 0 ? 'Puoi ancora spendere' : 'Oltre il budget'}</span>
          ${bigMoney(c.leftToday)}
          <span class="muted small">su ${money(c.budgetToday)} di oggi</span>
        </div>
      </div>
      ${msg}
    </div>
    <div class="stats3">
      <div class="stat"><span class="label">Restano nel ciclo</span><b>${money0(c.remaining)}</b><span class="muted small">${c.daysLeft} giorni</span></div>
      <div class="stat"><span class="label">Quota normale</span><b>${money0(c.stable)}</b><span class="muted small">al giorno</span></div>
      <div class="stat"><span class="label">Serie</span><b>${st} ${st === 1 ? 'giorno' : 'giorni'}</b><span class="muted small">entro budget</span></div>
    </div>
    <div class="quick">${quick.map((q) => `<button class="chip" data-action="add" data-cat="${q.id}">${icon(q, 'sm')}${esc(q.name)}</button>`).join('')}</div>
    ${pace}
    <div class="card">
      <div class="row-between"><h2>Oggi</h2><span class="muted">${money(c.spentToday)}</span></div>
      ${todays.length ? `<ul class="txlist">${todays.map(txRow).join('')}</ul>` : '<p class="empty">Nessun movimento oggi. Tocca + per aggiungere una spesa.</p>'}
    </div>
    ${env.length ? `<div class="card"><div class="row-between"><h2>Buste</h2><button class="link" data-action="goto-plan" data-sub="buste">Tutte</button></div>${env.map(envRow).join('')}</div>` : ''}
    ${(upcoming.length || dueFunds.length) ? `<div class="card"><h2>In arrivo</h2><ul class="plain">
      ${upcoming.map((p) => `<li class="row-between"><span>${icon(catById(p.categoryId), 'sm')} ${esc(p.name)} <span class="muted small">${fmtDate(p.date)}</span></span><b class="${p.type === 'income' ? 'good' : ''}">${p.type === 'income' ? '+' : '−'}${money(p.amount)}</b></li>`).join('')}
      ${dueFunds.map((f) => `<li class="row-between"><span><span class="ico sm">${esc(f.icon || '📦')}</span> ${esc(f.name)} <span class="muted small">scade ${fmtDate(f.dueDate)}</span></span><span class="muted">${money0(potBalance(state, 'fund', f.id))} / ${money0(f.target)}</span></li>`).join('')}
    </ul></div>` : ''}
  </section>`;
}

function envRow(e) {
  const pct = Math.min(100, e.ratio * 100);
  const cls = e.ratio > 1 ? 'over' : e.ratio > e.expectedRatio + 0.1 ? 'warn' : '';
  return `<div class="env" data-action="edit-cat" data-id="${e.category.id}">
    <div class="row-between"><span>${icon(e.category, 'sm')} ${esc(e.category.name)}</span>
    <span class="${e.left < 0 ? 'bad' : 'muted'} small">${e.left >= 0 ? 'restano ' + money0(e.left) : 'oltre di ' + money0(-e.left)}</span></div>
    <div class="track"><div class="fill ${cls}" style="width:${pct.toFixed(1)}%"></div><div class="marker" style="left:${Math.min(100, e.expectedRatio * 100).toFixed(1)}%"></div></div>
    <div class="small muted">${money0(e.spent)} di ${money0(e.limit)}</div>
  </div>`;
}

function txRow(t) {
  const c = catById(t.categoryId);
  const sign = t.type === 'income' ? '+' : t.type === 'save' ? '' : '−';
  const src = txSource(t);
  const who = people().length > 1 && t.personId ? personName(t.personId) : '';
  const meta = [t.type === 'save' ? 'accantonato' : c?.name, src, who].filter(Boolean).join(' · ');
  const ic = t.type === 'save' ? `<span class="ico" style="--c:#6b8f71">${esc((t.fundId ? fundById(t.fundId)?.icon : goalById(t.goalId)?.icon) || '🏦')}</span>` : icon(c);
  return `<li data-action="edit-tx" data-id="${t.id}">${ic}
    <div class="tx-main"><span class="tx-title">${esc(txLabel(t))}</span><span class="tx-meta">${esc(meta)}</span></div>
    <span class="tx-amt ${t.type}">${sign}${money(t.amount)}</span></li>`;
}

// ================= MOVIMENTI =================
function renderTx(resultsOnly = false) {
  const today = todayISO();
  let cyc = cycleFor(today, state.settings.payday);
  for (let i = 0; i < ui.txOffset; i++) cyc = prevCycle(cyc, state.settings.payday);
  const q = ui.search.trim().toLowerCase();
  let list = alive(state.transactions).filter((t) => t.date >= cyc.start && t.date <= cyc.end);
  const f = ui.filter;
  if (f === 'expense') list = list.filter((t) => t.type === 'expense');
  if (f === 'income') list = list.filter((t) => t.type === 'income');
  if (f === 'variable') list = list.filter(isVariable);
  if (f === 'fixed') list = list.filter((t) => t.recurringId);
  if (f === 'save') list = list.filter((t) => t.type === 'save' || t.fundId || t.goalId);
  if (ui.cat) list = list.filter((t) => t.categoryId === ui.cat);
  if (q) list = list.filter((t) => `${t.note || ''} ${catById(t.categoryId)?.name || ''} ${moneyPlain(t.amount)}`.toLowerCase().includes(q));
  list.sort((a, b) => b.date.localeCompare(a.date) || (b.updatedAt || 0) - (a.updatedAt || 0));
  const out = sum(list.filter((t) => t.type === 'expense'), (t) => t.amount);
  const inc = sum(list.filter((t) => t.type === 'income'), (t) => t.amount);
  const groups = new Map();
  for (const t of list) { if (!groups.has(t.date)) groups.set(t.date, []); groups.get(t.date).push(t); }
  const filters = [['all', 'Tutti'], ['variable', 'Variabili'], ['fixed', 'Fisse'], ['income', 'Entrate'], ['save', 'Risparmi'], ['expense', 'Tutte le uscite']];
  const results = `<div class="sum-row"><span>Uscite <b>${money(out)}</b></span><span>Entrate <b class="good">${money(inc)}</b></span><span class="muted">${list.length} mov.</span></div>
  ${list.length ? [...groups.entries()].map(([d, ts]) => `
    <div class="day-group"><div class="day-head"><span>${fmtDayHeader(d)}</span><span class="muted">${money(sum(ts.filter((t) => t.type === 'expense'), (t) => t.amount))}</span></div>
    <ul class="txlist">${ts.map(txRow).join('')}</ul></div>`).join('') : '<p class="empty">Nessun movimento trovato.</p>'}`;
  if (resultsOnly) return results;
  return `
  <div class="cycle-nav">
    <button class="icon-btn" data-action="tx-prev" aria-label="Ciclo precedente">‹</button>
    <div><b>${fmtDate(cyc.start)} – ${fmtDate(cyc.end, { year: true })}</b><span class="muted small">${ui.txOffset === 0 ? 'ciclo attuale' : `${ui.txOffset} ${ui.txOffset === 1 ? 'ciclo fa' : 'cicli fa'}`}</span></div>
    <button class="icon-btn" data-action="tx-next" ${ui.txOffset === 0 ? 'disabled' : ''} aria-label="Ciclo successivo">›</button>
  </div>
  <div class="search"><input type="search" placeholder="Cerca nota, categoria o importo" value="${esc(ui.search)}" data-bind="search" aria-label="Cerca" enterkeyhint="search" autocomplete="off" autocorrect="off" spellcheck="false"></div>
  <div class="chips scroll">${filters.map(([k, l]) => `<button class="chip ${ui.filter === k ? 'on' : ''}" data-action="tx-filter" data-f="${k}">${l}</button>`).join('')}</div>
  <div class="chips scroll">
    <select data-bind="cat" aria-label="Categoria"><option value="">Tutte le categorie</option>${cats().map((c) => `<option value="${c.id}" ${ui.cat === c.id ? 'selected' : ''}>${esc(c.icon)} ${esc(c.name)}</option>`).join('')}</select>
  </div>
  <div id="txResults">${results}</div>
  `;
}

// ================= PIANO =================
function renderPlan() {
  const tabs = [['riepilogo', 'Riepilogo'], ['ricorrenti', 'Fisse'], ['buste', 'Buste'], ['accantonamenti', 'Accantonamenti'], ['obiettivi', 'Obiettivi']];
  const body = {
    riepilogo: planSummary, ricorrenti: planRecurring, buste: planEnvelopes, accantonamenti: planFunds, obiettivi: planGoals,
  }[ui.planTab]();
  return `<div class="seg scroll">${tabs.map(([k, l]) => `<button class="${ui.planTab === k ? 'on' : ''}" data-action="plan-tab" data-sub="${k}">${l}</button>`).join('')}</div>${body}`;
}

function planSummary() {
  const c = computeCycle(state, todayISO());
  const line = (label, v, cls = '', note = '') => `<li class="row-between ${cls}"><span>${label}${note ? `<span class="muted small"> ${note}</span>` : ''}</span><b>${money(v)}</b></li>`;
  return `
  <div class="card">
    <h2>Come nasce il tuo budget</h2>
    <p class="muted small">Ciclo ${fmtDate(c.cycle.start)} – ${fmtDate(c.cycle.end)}, ${c.cycle.days} giorni</p>
    <ul class="plain waterfall">
      ${line('Entrate del ciclo', c.incomes, 'good', c.incomePlanned ? `(${money0(c.incomePlanned)} attese)` : '')}
      ${c.carryIn ? line('Riporto dal ciclo precedente', c.carryIn, c.carryIn >= 0 ? 'good' : 'bad') : ''}
      ${line('− Spese fisse', -c.fixed, '', c.fixedPlanned ? `(${money0(c.fixedPlanned)} ancora da pagare)` : '')}
      ${line('− Accantonamenti', -c.reservedFunds)}
      ${line('− Obiettivi di risparmio', -c.reservedGoals)}
      <li class="row-between total"><span>Per le spese di tutti i giorni</span><b>${money(c.base)}</b></li>
      <li class="row-between muted"><span>÷ ${c.cycle.days} giorni</span><b>${money(c.stable)} al giorno</b></li>
    </ul>
  </div>
  <div class="card">
    <h2>Situazione ad oggi</h2>
    <ul class="plain">
      ${line('Spese variabili finora', c.variableTotal)}
      ${line('Restano per ' + c.daysLeft + ' giorni', c.remaining, c.remaining >= 0 ? 'good' : 'bad')}
      ${line('Budget di oggi', c.budgetToday)}
      ${c.fromSavings ? line('Pagato con accantonamenti', c.fromSavings, 'muted', '(non pesa sul budget)') : ''}
    </ul>
    ${c.base <= 0 ? '<p class="hero-note warn">Le spese fisse e gli accantonamenti superano le entrate: riduci le quote o rivedi le fisse.</p>' : ''}
  </div>`;
}

function planRecurring() {
  const list = alive(state.recurring);
  const block = (type, title) => {
    const items = list.filter((r) => r.type === type).sort((a, b) => (a.day || 0) - (b.day || 0));
    const monthly = sum(items.filter((r) => !r.paused), (r) => Math.round(r.amount / (FREQ[r.freq]?.months || 1)));
    return `<div class="card"><div class="row-between"><h2>${title}</h2><span class="muted small">≈ ${money0(monthly)} al mese</span></div>
      ${items.length ? `<ul class="txlist">${items.map((r) => {
        const nd = nextDue(r);
        return `<li data-action="edit-rec" data-id="${r.id}">${icon(catById(r.categoryId))}
        <div class="tx-main"><span class="tx-title">${esc(r.name)}${r.paused ? ' <span class="tag">in pausa</span>' : ''}</span>
        <span class="tx-meta">${FREQ[r.freq]?.label || ''}, giorno ${r.day}${nd ? ' · prossima ' + fmtDate(nd) : ''}${people().length > 1 ? ' · ' + esc(personName(r.personId)) : ''}</span></div>
        <span class="tx-amt ${type}">${money(r.amount)}</span></li>`;
      }).join('')}</ul>` : '<p class="empty">Nessuna voce.</p>'}
      <button class="btn ghost full" data-action="new-rec" data-type="${type}">+ Aggiungi ${type === 'income' ? 'entrata' : 'spesa fissa'}</button></div>`;
  };
  return `<p class="hint">Le voci fisse si registrano da sole nel giorno indicato. Se l'importo reale cambia (es. una bolletta), modifica il movimento generato.</p>
    ${block('income', 'Entrate')}${block('expense', 'Spese fisse')}`;
}

function planEnvelopes() {
  const c = computeCycle(state, todayISO());
  const withLimit = c.envelopes;
  const totalLimits = sum(withLimit, (e) => e.limit);
  return `<p class="hint">Le buste sono tetti per categoria dentro il budget giornaliero. La tacca indica dove dovresti essere oggi.</p>
  <div class="card">${withLimit.length ? withLimit.map(envRow).join('') : '<p class="empty">Nessuna busta. Imposta un limite a una categoria.</p>'}
    ${withLimit.length ? `<p class="small muted">Somma dei limiti ${money0(totalLimits)} su ${money0(c.base)} disponibili per le spese variabili.</p>` : ''}
  </div>
  <div class="card"><h2>Categorie senza limite</h2><ul class="txlist">
    ${catsOf('expense').filter((x) => !(x.limit > 0)).map((x) => `<li data-action="edit-cat" data-id="${x.id}">${icon(x)}<div class="tx-main"><span class="tx-title">${esc(x.name)}</span><span class="tx-meta">speso nel ciclo ${money0((c.byCat.get(x.id)?.variable) || 0)}</span></div><span class="link">Imposta</span></li>`).join('')}
  </ul></div>`;
}

function potCard(kind, p) {
  const today = todayISO();
  const cyc = cycleFor(today, state.settings.payday);
  const bal = potBalance(state, kind, p.id);
  const target = p.target || 0;
  const pct = target ? Math.max(0, Math.min(100, (bal / target) * 100)) : 0;
  const quotaTx = state.transactions.find((t) => !t.deleted && t.type === 'save' && (kind === 'fund' ? t.fundId : t.goalId) === p.id && t.cycleStart === cyc.start);
  let sub = '';
  if (kind === 'fund') {
    const d = p.dueDate ? diffDays(today, p.dueDate) : null;
    sub = `Scadenza ${p.dueDate ? fmtDate(p.dueDate, { year: true }) : '—'}${d != null && d >= 0 ? ` · tra ${d} giorni` : ''}${p.repeat === 'yearly' ? ' · ogni anno' : ''}`;
  } else {
    const sug = goalSuggestion(state, p, cyc);
    sub = `${p.deadline ? 'Entro ' + fmtDate(p.deadline, { year: true }) : 'Senza scadenza'}${sug && sug !== (p.monthly || 0) ? ` · per arrivarci servono ${money0(sug)}/mese` : ''}`;
  }
  return `<div class="card pot">
    <div class="row-between" data-action="edit-${kind}" data-id="${p.id}"><span class="pot-title"><span class="ico">${esc(p.icon || (kind === 'fund' ? '📦' : '🎯'))}</span><b>${esc(p.name)}</b>${p.paused ? '<span class="tag">in pausa</span>' : ''}</span><span class="link">Modifica</span></div>
    <div class="pot-amt">${bigMoney(bal)}${target ? `<span class="muted"> / ${money0(target)}</span>` : ''}</div>
    ${target ? `<div class="track"><div class="fill save" style="width:${pct.toFixed(1)}%"></div></div>` : ''}
    <p class="small muted">${sub}</p>
    <p class="small">Quota di questo ciclo: <b>${money(quotaTx?.amount || 0)}</b>${quotaTx ? ` <button class="link" data-action="edit-tx" data-id="${quotaTx.id}">cambia</button>` : ''}</p>
    <div class="btn-row">
      <button class="btn ghost small" data-action="pot-use" data-kind="${kind}" data-id="${p.id}">Usa per una spesa</button>
      <button class="btn ghost small" data-action="pot-add" data-kind="${kind}" data-id="${p.id}">Versa extra</button>
    </div>
  </div>`;
}

function planFunds() {
  const list = alive(state.funds).sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || ''));
  const cyc = cycleFor(todayISO(), state.settings.payday);
  const tot = sum(list, (f) => fundQuota(state, f, cyc));
  return `<p class="hint">Per le spese che arrivano una o poche volte l'anno (assicurazione, bollo, regali, vacanze). Ogni ciclo l'app mette da parte la quota giusta, così la scadenza non svuota il mese.</p>
    ${list.map((f) => potCard('fund', f)).join('') || '<div class="card"><p class="empty">Nessun accantonamento.</p></div>'}
    <button class="btn full" data-action="new-fund">+ Nuovo accantonamento</button>
    ${list.length ? `<p class="small muted center">Quote calcolate per il prossimo ciclo: circa ${money0(tot)}</p>` : ''}`;
}

function planGoals() {
  const list = alive(state.goals);
  return `<p class="hint">Gli obiettivi ricevono una quota fissa ogni ciclo. Un obiettivo senza traguardo funziona come un salvadanaio libero.</p>
    ${list.map((g) => potCard('goal', g)).join('') || '<div class="card"><p class="empty">Nessun obiettivo.</p></div>'}
    <button class="btn full" data-action="new-goal">+ Nuovo obiettivo</button>`;
}

// ================= STATISTICHE =================
function renderStats() {
  const today = todayISO();
  let cyc = cycleFor(today, state.settings.payday);
  for (let i = 0; i < ui.statsOffset; i++) cyc = prevCycle(cyc, state.settings.payday);
  const asOf = cyc.end < today ? cyc.end : today;
  const c = computeCycle(state, asOf, { cycle: cyc });
  const series = dailySeries(state, asOf, c);
  const hist = cycleHistory(state, 6, today).filter((h) => h.current || h.incomes > 0 || h.variable > 0);
  const wd = weekdayAverages(state, 84, today);
  const catRows = [...c.byCat.entries()].map(([id, e]) => ({ c: catById(id), ...e })).filter((x) => x.total > 0).sort((a, b) => b.total - a.total);
  const maxCat = Math.max(...catRows.map((x) => x.total), 1);
  const top = c.txs.filter((t) => t.type === 'expense').sort((a, b) => b.amount - a.amount).slice(0, 5);
  const ppl = people();
  const byPerson = ppl.map((p) => ({ p, v: sum(c.txs.filter((t) => t.type === 'expense' && (t.personId || 'p-me') === p.id), (t) => t.amount) }));
  const totP = Math.max(sum(byPerson, (x) => x.v), 1);
  const savedRate = c.incomes ? (c.reserved + Math.max(0, c.remaining)) / c.incomes : 0;
  const overDays = series.filter((d) => !d.future && d.spent > d.budget).length;
  const pastDays = series.filter((d) => !d.future).length;

  return `
  <div class="cycle-nav">
    <button class="icon-btn" data-action="st-prev" aria-label="Ciclo precedente">‹</button>
    <div><b>${fmtDate(cyc.start)} – ${fmtDate(cyc.end, { year: true })}</b><span class="muted small">${ui.statsOffset === 0 ? 'ciclo attuale' : 'ciclo passato'}</span></div>
    <button class="icon-btn" data-action="st-next" ${ui.statsOffset === 0 ? 'disabled' : ''} aria-label="Ciclo successivo">›</button>
  </div>
  <div class="stats3">
    <div class="stat"><span class="label">Entrate</span><b>${money0(c.incomes)}</b></div>
    <div class="stat"><span class="label">Uscite</span><b>${money0(c.fixed + c.variableTotal + c.fromSavings)}</b></div>
    <div class="stat"><span class="label">Risparmiato</span><b class="good">${Math.round(savedRate * 100)}%</b><span class="muted small">incl. avanzo</span></div>
  </div>
  <div class="card">
    <div class="row-between"><h2>Giorno per giorno</h2><span class="muted small">${overDays} su ${pastDays} giorni oltre</span></div>
    ${dailyChart(series, today)}
    <div class="legend"><span><i class="lg bar"></i>speso</span><span><i class="lg over"></i>oltre il budget</span><span><i class="lg line"></i>budget del giorno</span></div>
  </div>
  <div class="card">
    <h2>Dove vanno i soldi</h2>
    ${catRows.length ? catRows.map((x) => `<div class="hbar" data-action="filter-cat" data-id="${x.c?.id || ''}">
      <div class="row-between"><span>${icon(x.c, 'sm')} ${esc(x.c?.name || 'Senza categoria')}</span><b>${money0(x.total)}</b></div>
      <div class="hbar-track"><span class="seg-var" style="width:${(x.variable / maxCat * 100).toFixed(1)}%"></span><span class="seg-fixed" style="width:${(x.fixed / maxCat * 100).toFixed(1)}%"></span><span class="seg-save" style="width:${(x.fromSavings / maxCat * 100).toFixed(1)}%"></span></div>
    </div>`).join('') : '<p class="empty">Nessuna spesa in questo ciclo.</p>'}
    <div class="legend"><span><i class="lg var"></i>variabili</span><span><i class="lg fixed"></i>fisse</span><span><i class="lg save"></i>da accantonamenti</span></div>
  </div>
  <div class="card">
    <h2>Ultimi 6 cicli</h2>
    ${historyChart(hist)}
    <div class="legend"><span><i class="lg fixed"></i>fisse</span><span><i class="lg var"></i>variabili</span><span><i class="lg save"></i>accantonato</span><span><i class="lg inc"></i>entrate</span></div>
    <table class="tbl"><thead><tr><th>Ciclo</th><th>Entrate</th><th>Uscite</th><th>Avanzo</th></tr></thead><tbody>
      ${hist.map((h) => `<tr><td>${fmtDate(h.cycle.start)}</td><td>${money0(h.incomes)}</td><td>${money0(h.fixed + h.variable + h.fromSavings)}</td><td class="${h.remaining >= 0 ? 'good' : 'bad'}">${money0(h.remaining)}</td></tr>`).join('')}
    </tbody></table>
  </div>
  <div class="card"><h2>Spesa media per giorno</h2><p class="small muted">Spese variabili, ultime 12 settimane</p>${weekdayChart(wd)}</div>
  ${top.length ? `<div class="card"><h2>Le spese più grandi</h2><ul class="txlist">${top.map(txRow).join('')}</ul></div>` : ''}
  ${ppl.length > 1 ? `<div class="card"><h2>Chi ha speso</h2>${byPerson.map((x) => `<div class="hbar"><div class="row-between"><span>${esc(x.p.name)}</span><b>${money0(x.v)} · ${Math.round(x.v / totP * 100)}%</b></div><div class="hbar-track"><span class="seg-var" style="width:${(x.v / totP * 100).toFixed(1)}%"></span></div></div>`).join('')}</div>` : ''}
  `;
}

// ================= ALTRO =================
function renderMore() {
  const s = state.settings;
  const nTx = alive(state.transactions).length;
  return `
  <div class="card"><h2>Profilo e ciclo</h2>
    <label class="field"><span>Il tuo nome</span><input data-setting="name" value="${esc(s.name)}" maxlength="40"></label>
    <label class="field"><span>Giorno dello stipendio</span><select data-setting="payday">${Array.from({ length: 31 }, (_, i) => `<option ${s.payday === i + 1 ? 'selected' : ''} value="${i + 1}">${i + 1}${i === 0 ? ' (mese solare)' : ''}</option>`).join('')}</select></label>
    <label class="field"><span>Avanzo a fine ciclo</span><select data-setting="carryOver">
      <option value="save" ${s.carryOver === 'save' ? 'selected' : ''}>Resta come risparmio</option>
      <option value="carry" ${s.carryOver === 'carry' ? 'selected' : ''}>Si aggiunge al ciclo successivo</option></select></label>
    <p class="small muted">Se lo stipendio cade il 31, nei mesi più corti il ciclo parte dall'ultimo giorno del mese.</p>
  </div>
  <div class="card"><h2>Persone</h2>
    <p class="small muted">Per una gestione di coppia: ogni movimento indica chi ha speso.</p>
    <ul class="txlist">${people().map((p) => `<li data-action="edit-person" data-id="${p.id}"><span class="ico">${esc(p.name.slice(0, 1).toUpperCase())}</span><div class="tx-main"><span class="tx-title">${esc(p.name)}</span><span class="tx-meta">${p.id === local.personId ? 'questo dispositivo' : ''}</span></div><span class="link">Modifica</span></li>`).join('')}</ul>
    <button class="btn ghost full" data-action="new-person">+ Aggiungi persona</button>
    ${people().length > 1 ? `<label class="field"><span>Questo telefono è di</span><select data-local="personId">${people().map((p) => `<option value="${p.id}" ${local.personId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>` : ''}
  </div>
  <div class="card"><h2>Categorie e regole</h2>
    <button class="row-btn" data-action="manage-cats"><span>Categorie</span><span class="muted">${cats().length} ›</span></button>
    <button class="row-btn" data-action="manage-rules"><span>Regole per l'import</span><span class="muted">${alive(state.rules).length} ›</span></button>
  </div>
  <div class="card"><h2>Importa dalla banca</h2>
    <p class="small muted">Scarica l'estratto conto in CSV dall'home banking e caricalo qui. Il file viene letto solo su questo telefono, non viene inviato a nessuno.</p>
    <button class="btn full" data-action="csv-start">Importa file CSV</button>
  </div>
  <div class="card"><h2>Backup</h2>
    <p class="small muted">${nTx} movimenti. Ultimo backup: ${local.lastBackup ? fmtDate(local.lastBackup.slice(0, 10), { year: true }) : 'mai'}.</p>
    <div class="btn-row">
      <button class="btn ghost small" data-action="export-json">Esporta backup</button>
      <button class="btn ghost small" data-action="export-csv">Esporta CSV</button>
      <button class="btn ghost small" data-action="import-json">Ripristina</button>
    </div>
  </div>
  <div class="card"><h2>Sincronizzazione di coppia</h2>
    <p class="small muted">Facoltativa. I dati vengono cifrati sul telefono con una frase segreta che conoscete solo voi; su Firebase arriva un blocco illeggibile.</p>
    ${local.sync.enabled ? `<p>Stato: <b>${esc(syncStatus || 'in avvio')}</b></p><div class="btn-row"><button class="btn ghost small" data-action="sync-now">Sincronizza ora</button><button class="btn ghost small danger" data-action="sync-off">Disattiva</button></div>`
      : '<button class="btn ghost full" data-action="sync-setup">Configura</button>'}
  </div>
  <div class="card"><h2>Sicurezza e aspetto</h2>
    <button class="row-btn" data-action="pin"><span>Blocco con PIN</span><span class="muted">${local.pinHash ? 'attivo' : 'spento'} ›</span></button>
    <label class="field"><span>Tema</span><select data-local="theme">
      <option value="auto" ${local.theme === 'auto' ? 'selected' : ''}>Automatico</option><option value="light" ${local.theme === 'light' ? 'selected' : ''}>Chiaro</option><option value="dark" ${local.theme === 'dark' ? 'selected' : ''}>Scuro</option></select></label>
    <label class="field"><span>Promemoria serale alle</span><select data-local="reminderHour">${[18, 19, 20, 21, 22, 23].map((h) => `<option value="${h}" ${local.reminderHour === h ? 'selected' : ''}>${h}:00</option>`).join('')}</select></label>
    <button class="btn ghost full" data-action="ics">Aggiungi promemoria al calendario</button>
    <p class="small muted">Il promemoria del calendario ti avvisa ogni sera anche ad app chiusa.</p>
  </div>
  <div class="card"><h2>Dati</h2>
    <button class="row-btn" data-action="persist"><span>Proteggi i dati dalla pulizia del browser</span><span class="muted" id="persistState">›</span></button>
    <button class="row-btn" data-action="demo"><span>Carica dati di esempio</span><span class="muted">›</span></button>
    <button class="row-btn danger" data-action="wipe"><span>Cancella tutti i dati</span><span>›</span></button>
  </div>
  <p class="small muted center">Formichina · nessun account, nessuna pubblicità, nessun tracciamento.<br>I dati sono salvati solo in questo browser.</p>
  `;
}

// ================= ONBOARDING =================
function obDefaults() {
  return {
    name: '', payday: 27, salary: '', income2: { name: '', amount: '', day: 10 },
    fixed: [
      { name: 'Affitto o mutuo', amount: '', day: 1, freq: 'monthly' },
      { name: 'Luce e gas', amount: '', day: 15, freq: 'bimonthly' },
      { name: 'Internet e telefono', amount: '', day: 5, freq: 'monthly' },
      { name: 'Abbonamenti', amount: '', day: 10, freq: 'monthly' },
    ],
    saving: '',
    funds: [
      { name: 'Assicurazione auto', icon: '🚗', amount: '', due: '' },
      { name: 'Bollo auto', icon: '🧾', amount: '', due: '' },
      { name: 'Regali di Natale', icon: '🎄', amount: '', due: `${todayISO().slice(0, 4)}-12-15` },
    ],
  };
}

function renderOnboarding() {
  if (!ui.obData) ui.obData = obDefaults();
  const d = ui.obData;
  const steps = 5;
  const dots = `<div class="ob-dots">${Array.from({ length: steps }, (_, i) => `<i class="${i <= ui.ob ? 'on' : ''}"></i>`).join('')}</div>`;
  const nav = (next = 'Avanti') => `<div class="ob-nav">${ui.ob > 0 ? '<button class="btn ghost" data-action="ob-back">Indietro</button>' : '<span></span>'}<button class="btn" data-action="ob-next">${next}</button></div>`;
  if (ui.ob === 0) {
    return `<section class="ob">
      <div class="ob-hero"><img class="logo" src="logo.svg" alt=""><h1>Formichina</h1><p>Ogni giorno ti dice quanto puoi spendere, senza collegare banca o carte.</p></div>
      <ul class="ob-points"><li>I dati restano su questo telefono</li><li>Nessun account, nessuna pubblicità</li><li>Funziona anche offline</li></ul>
      <label class="field"><span>Come ti chiami?</span><input id="ob-name" value="${esc(d.name)}" maxlength="40" autocomplete="given-name" autocapitalize="words" enterkeyhint="next"></label>
      <button class="btn full" data-action="ob-next">Iniziamo</button>
      <div class="btn-row center"><button class="link" data-action="demo">Prova con dati di esempio</button><button class="link" data-action="import-json">Ripristina un backup</button></div>
    </section>`;
  }
  if (ui.ob === 1) {
    return `<section class="ob">${dots}<h2>Le entrate</h2><p class="muted">Il budget segue il ciclo dello stipendio, non il mese solare.</p>
      <label class="field"><span>Giorno in cui arriva lo stipendio</span><select id="ob-payday">${Array.from({ length: 31 }, (_, i) => `<option ${d.payday === i + 1 ? 'selected' : ''}>${i + 1}</option>`).join('')}</select></label>
      <label class="field"><span>Stipendio netto mensile</span><input id="ob-salary" inputmode="decimal" placeholder="es. 1.650" value="${esc(d.salary)}" autocomplete="off" enterkeyhint="next"></label>
      <details ${d.income2.amount ? 'open' : ''}><summary>Un'altra entrata fissa (es. stipendio del partner)</summary>
        <label class="field"><span>Nome</span><input id="ob-i2-name" placeholder="es. Stipendio Mario Rossi" value="${esc(d.income2.name)}" autocapitalize="sentences"></label>
        <div class="grid2"><label class="field"><span>Importo</span><input id="ob-i2-amount" inputmode="decimal" enterkeyhint="done" placeholder="0" value="${esc(d.income2.amount)}" autocomplete="off"></label>
        <label class="field"><span>Giorno</span><select id="ob-i2-day">${dayOptions(d.income2.day)}</select></label></div>
      </details>${nav()}</section>`;
  }
  if (ui.ob === 2) {
    return `<section class="ob">${dots}<h2>Le spese fisse</h2><p class="muted">Quelle che arrivano comunque. Lascia vuoto ciò che non hai; potrai cambiarle in seguito.</p>
      ${d.fixed.map((f, i) => `<div class="ob-card">
        <label class="field"><span>Voce</span><input data-ob="fixed.${i}.name" value="${esc(f.name)}" placeholder="es. Palestra" autocapitalize="sentences" enterkeyhint="next"></label>
        <div class="grid3">
          <label class="field"><span>Importo €</span><input data-ob="fixed.${i}.amount" inputmode="decimal" placeholder="0" value="${esc(f.amount)}" enterkeyhint="next" autocomplete="off"></label>
          <label class="field"><span>Giorno</span><select data-ob="fixed.${i}.day">${dayOptions(f.day)}</select></label>
          <label class="field"><span>Ogni</span><select data-ob="fixed.${i}.freq">${Object.entries(FREQ).map(([k, v]) => `<option value="${k}" ${f.freq === k ? 'selected' : ''}>${v.short}</option>`).join('')}</select></label>
        </div>
      </div>`).join('')}
      <button class="btn ghost full" data-action="ob-addfixed">+ Altra spesa fissa</button>${nav()}</section>`;
  }
  if (ui.ob === 3) {
    return `<section class="ob">${dots}<h2>Risparmio e scadenze</h2>
      <label class="field"><span>Quanto vuoi mettere da parte ogni mese?</span><input id="ob-saving" inputmode="decimal" placeholder="es. 150" value="${esc(d.saving)}" autocomplete="off" enterkeyhint="next"></label>
      <p class="muted small">Spese annuali da preparare un po' alla volta (lascia vuoto se non servono):</p>
      ${d.funds.map((f, i) => `<div class="ob-card">
        <label class="field"><span>Spesa</span><input data-ob="funds.${i}.name" value="${esc(f.name)}" autocapitalize="sentences" enterkeyhint="next"></label>
        <div class="grid2">
          <label class="field"><span>Importo €</span><input data-ob="funds.${i}.amount" inputmode="decimal" placeholder="0" value="${esc(f.amount)}" enterkeyhint="next" autocomplete="off"></label>
          <label class="field"><span>Scadenza</span><input data-ob="funds.${i}.due" type="date" value="${esc(f.due)}"></label>
        </div>
      </div>`).join('')}${nav()}</section>`;
  }
  const preview = obBuild(true);
  const c = computeCycle(preview, todayISO());
  return `<section class="ob">${dots}<h2>Ecco il tuo budget</h2>
    <div class="card hero center"><span class="label">Puoi spendere circa</span>${bigMoney(c.stable)}<span class="muted">al giorno per spesa, bar, benzina e tutto il resto</span></div>
    <ul class="plain waterfall">
      <li class="row-between"><span>Entrate</span><b>${money(c.incomes)}</b></li>
      <li class="row-between"><span>− Fisse</span><b>${money(c.fixed)}</b></li>
      <li class="row-between"><span>− Risparmio e accantonamenti</span><b>${money(c.reserved)}</b></li>
      <li class="row-between total"><span>Per ${c.cycle.days} giorni</span><b>${money(c.base)}</b></li>
    </ul>
    ${c.base <= 0 ? '<p class="hero-note warn">Le uscite programmate superano le entrate: torna indietro e rivedi gli importi.</p>' : ''}
    ${nav('Inizia')}</section>`;
}

function obRead() {
  const d = ui.obData;
  const v = (id) => $('#' + id)?.value;
  if (ui.ob === 0) d.name = v('ob-name')?.trim() || '';
  if (ui.ob === 1) {
    d.payday = Number(v('ob-payday')); d.salary = v('ob-salary');
    d.income2 = { name: v('ob-i2-name') || '', amount: v('ob-i2-amount') || '', day: Number(v('ob-i2-day')) || 10 };
  }
  if (ui.ob === 3) d.saving = v('ob-saving');
  document.querySelectorAll('[data-ob]').forEach((el) => {
    const [arr, i, key] = el.dataset.ob.split('.');
    d[arr][Number(i)][key] = key === 'day' ? Number(el.value) || 1 : el.value;
  });
}

function guessCat(s, name) {
  const n = name.toLowerCase();
  const by = (x) => s.categories.find((c) => c.name === x)?.id;
  if (/affitto|mutuo|condominio|casa/.test(n)) return by('Casa');
  if (/luce|gas|acqua|internet|telefon|bollett|tari|rifiuti/.test(n)) return by('Bollette');
  if (/netflix|spotify|abbonament|streaming|dazn|prime/.test(n)) return by('Abbonamenti');
  if (/auto|benzina|treno|bus|metro|bollo/.test(n)) return by('Trasporti');
  if (/palestra|sport/.test(n)) return by('Svago');
  if (/scuola|asilo|mensa|figli/.test(n)) return by('Figli');
  if (/medic|assicurazione sanitaria|farmac/.test(n)) return by('Salute');
  return by('Altro');
}

function obBuild(preview = false) {
  const d = ui.obData;
  const s = preview ? emptyState() : state;
  const today = todayISO();
  s.settings = { ...s.settings, name: d.name, payday: d.payday, updatedAt: Date.now() };
  const cyc = cycleFor(today, d.payday);
  const catName = (n) => s.categories.find((c) => c.name === n)?.id;
  const sal = parseAmount(d.salary);
  if (sal > 0) upsert(s, 'recurring', { name: 'Stipendio', type: 'income', amount: sal, categoryId: catName('Stipendio'), day: d.payday, freq: 'monthly', startDate: cyc.start, personId: 'p-me' });
  const i2 = parseAmount(d.income2.amount);
  if (i2 > 0) {
    upsert(s, 'recurring', { name: d.income2.name || 'Seconda entrata', type: 'income', amount: i2, categoryId: catName('Stipendio'), day: d.income2.day, freq: 'monthly', startDate: cyc.start, personId: 'p-me' });
  }
  for (const f of d.fixed) {
    const a = parseAmount(f.amount);
    if (!(a > 0) || !f.name.trim()) continue;
    upsert(s, 'recurring', { name: f.name.trim(), type: 'expense', amount: a, categoryId: guessCat(s, f.name), day: f.day, freq: f.freq, startDate: cyc.start, personId: 'p-me' });
  }
  const sv = parseAmount(d.saving);
  if (sv > 0) upsert(s, 'goals', { name: 'Fondo risparmio', icon: '🐷', target: 0, monthly: sv, initial: 0, createdOn: today });
  for (const f of d.funds) {
    const a = parseAmount(f.amount);
    if (!(a > 0) || !f.due) continue;
    upsert(s, 'funds', { name: f.name, icon: f.icon, target: a, dueDate: f.due, repeat: 'yearly', initial: 0, createdOn: today });
  }
  generate(s, today);
  return s;
}

async function obFinish() {
  state = emptyState();
  obBuild(false);
  state.settings.onboarded = true;
  state.settings.updatedAt = Date.now();
  ui.obData = null; ui.ob = 0; ui.tab = 'oggi';
  requestPersist(true);
  await commit('Pronto! Il budget di oggi è calcolato.');
}

// ================= FOGLIO (dialog) =================
const sheet = () => $('#sheet');
let sheetSubmit = null;

function openSheet(title, body, onSubmit, opts = {}) {
  const dlg = sheet();
  dlg.innerHTML = `<form class="sheet" novalidate>
    <header><h2>${esc(title)}</h2><button type="button" class="icon-btn" data-action="close-sheet" aria-label="Chiudi">✕</button></header>
    <div class="sheet-body">${body}</div>
    ${opts.noFooter ? '' : `<footer>${opts.extraButtons || ''}<button class="btn" type="submit">${esc(opts.submitLabel || 'Salva')}</button></footer>`}
  </form>`;
  sheetSubmit = onSubmit;
  if (!dlg.open) {
    dlg.showModal();
    sheetOpenedAt = Date.now();
    // per un attimo il foglio ignora i tocchi: un doppio tocco sul + non preme nulla al suo interno
    dlg.classList.add('opening');
    setTimeout(() => dlg.classList.remove('opening'), 450);
  }
  const body2 = dlg.querySelector('.sheet-body');
  if (body2) body2.scrollTop = 0;
  const first = dlg.querySelector(opts.focus || '[autofocus]');
  if (first) first.focus({ preventScroll: true });
}
let sheetOpenedAt = 0;

function closeSheet() { const d = sheet(); if (d.open) d.close(); sheetSubmit = null; }

function formData(form) {
  const o = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') o[el.name] = el.checked;
    else if (el.type === 'radio') { if (el.checked) o[el.name] = el.value; }
    else o[el.name] = el.value;
  }
  if (o.iconCustom && o.iconCustom.trim()) o.icon = o.iconCustom.trim();
  return o;
}

const dayOptions = (sel) => Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}" ${Number(sel) === i + 1 ? 'selected' : ''}>${i + 1}</option>`).join('');

const ICONS = ['📦', '🛒', '☕', '🍕', '⛽', '🚗', '🏠', '💡', '💊', '👕', '🎬', '🎒', '🎁', '🐾', '📺', '📱', '✈️', '🏖️', '🎄', '🧾', '🛟', '🐷', '🎯', '💶', '✨', '🏋️', '📚', '🧸', '🔧', '💈', '•'];
const iconPicker = (current) => {
  const cur = current || '•';
  const custom = ICONS.includes(cur) ? '' : cur;
  return `<div class="field"><span>Icona</span><div class="icon-grid" role="radiogroup" aria-label="Icona">${ICONS.map((ic) => `<label class="icon-opt"><input type="radio" name="icon" value="${ic}" ${ic === cur ? 'checked' : ''}><span>${ic}</span></label>`).join('')}</div>
    <input name="iconCustom" class="icon-custom" value="${esc(custom)}" maxlength="4" placeholder="oppure scrivi un'altra emoji" autocomplete="off"></div>`;
};

const catPicker = (kind, selected) => `<div class="cat-grid" role="radiogroup" aria-label="Categoria">${catsOf(kind).map((c) => `
  <label class="cat-opt"><input type="radio" name="categoryId" value="${c.id}" ${c.id === selected ? 'checked' : ''}>${icon(c)}<span>${esc(c.name)}</span></label>`).join('')}</div>`;

const personPicker = (selected) => people().length > 1 ? `<div class="field"><span>Chi</span><div class="seg">${people().map((p) => `<label><input type="radio" name="personId" value="${p.id}" ${p.id === selected ? 'checked' : ''}><span>${esc(p.name)}</span></label>`).join('')}</div></div>` : '';

// ---------- Movimento ----------
function openTx(t = null, preset = {}) {
  const isNew = !t;
  if (t && t.type === 'save') return openSaveTx(t);
  const type = t?.type || preset.type || 'expense';
  const tx = t || { type, amount: preset.amount || null, date: todayISO(), categoryId: preset.categoryId || '', note: preset.note || '', personId: local.personId };
  const potOpts = [...alive(state.funds).map((f) => [`fund:${f.id}`, `${f.icon || '📦'} ${f.name} (${money0(potBalance(state, 'fund', f.id))})`]),
    ...alive(state.goals).map((g) => [`goal:${g.id}`, `${g.icon || '🎯'} ${g.name} (${money0(potBalance(state, 'goal', g.id))})`])];
  const potVal = tx.fundId ? `fund:${tx.fundId}` : tx.goalId ? `goal:${tx.goalId}` : '';
  const rec = tx.recurringId ? state.recurring.find((r) => r.id === tx.recurringId) : null;
  const body = `
    <div class="seg type-seg"><label><input type="radio" name="type" value="expense" ${type === 'expense' ? 'checked' : ''}><span>Uscita</span></label><label><input type="radio" name="type" value="income" ${type === 'income' ? 'checked' : ''}><span>Entrata</span></label></div>
    <label class="amount-field"><span class="cur">€</span><input name="amount" inputmode="decimal" enterkeyhint="done" placeholder="0,00" autocomplete="off" value="${tx.amount ? moneyPlain(tx.amount) : ''}" ${isNew ? 'autofocus' : ''} aria-label="Importo"></label>
    ${rec ? `<p class="small muted">Generato dalla voce fissa «${esc(rec.name)}». Correggi l'importo se quello reale è diverso.</p>` : ''}
    <div id="catWrap">${catPicker(type, tx.categoryId || (type === 'expense' ? '' : catsOf('income')[0]?.id))}</div>
    <div class="grid2">
      <label class="field"><span>Data</span><input type="date" name="date" value="${tx.date}" required></label>
      <label class="field"><span>Nota</span><input name="note" value="${esc(tx.note || '')}" maxlength="80" placeholder="facoltativa" autocapitalize="sentences" enterkeyhint="done"></label>
    </div>
    ${personPicker(tx.personId || local.personId)}
    ${potOpts.length ? `<label class="field expense-only" ${type === 'income' ? 'hidden' : ''}><span>Paga con</span><select name="pot"><option value="">Budget giornaliero</option>${potOpts.map(([v, l]) => `<option value="${v}" ${v === potVal ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>` : ''}
  `;
  const extra = (isNew ? '<button type="button" class="btn ghost" data-action="tx-save-more">Salva e aggiungi</button>' : '<button type="button" class="btn ghost danger" data-action="tx-delete">Elimina</button>');
  openSheet(isNew ? 'Nuovo movimento' : 'Modifica movimento', body, async (f, more) => {
    const amount = parseAmount(f.amount);
    if (!(amount > 0)) { toast('Inserisci un importo valido', true); return false; }
    const kind = f.type;
    const categoryId = f.categoryId || fallbackCat(kind)?.id;
    const [pk, pid] = (kind === 'expense' && f.pot ? f.pot : '').split(':');
    const rec2 = {
      ...(t || {}), type: kind, amount, date: f.date || todayISO(), categoryId, note: f.note.trim(),
      personId: f.personId || tx.personId || local.personId, fundId: pk === 'fund' ? pid : null, goalId: pk === 'goal' ? pid : null,
    };
    if (kind === 'income') { rec2.fundId = null; rec2.goalId = null; }
    upsert(state, 'transactions', rec2);
    await commit(isNew ? `${kind === 'income' ? 'Entrata' : 'Spesa'} di ${money(amount)} registrata` : 'Movimento aggiornato');
    if (more) { openTx(null, { type: kind }); return false; }
    return true;
  }, { extraButtons: extra });
  sheet().dataset.editing = t?.id || '';
}

function openSaveTx(t) {
  const name = t.fundId ? fundById(t.fundId)?.name : goalById(t.goalId)?.name;
  openSheet('Quota accantonata', `
    <p class="muted">${esc(name || '')} · ${fmtDate(t.date, { year: true })}</p>
    <label class="amount-field"><span class="cur">€</span><input name="amount" inputmode="decimal" enterkeyhint="done" autocomplete="off" value="${moneyPlain(t.amount)}" autofocus aria-label="Importo"></label>
    <p class="small muted">Questa somma viene tolta dal budget del ciclo e messa da parte. Abbassala se questo mese non ce la fai: le quote dei cicli successivi si adattano.</p>`,
  async (f) => {
    const a = parseAmount(f.amount);
    if (a === null || a < 0) { toast('Importo non valido', true); return false; }
    upsert(state, 'transactions', { ...t, amount: a, auto: false });
    await commit('Quota aggiornata');
    return true;
  }, { extraButtons: '<button type="button" class="btn ghost danger" data-action="tx-delete">Elimina</button>' });
  sheet().dataset.editing = t.id;
}

// ---------- Ricorrente ----------
function openRec(r = null, type = 'expense') {
  const today = todayISO();
  const x = r || { type, name: '', amount: null, day: fromISO(today).getDate(), freq: 'monthly', startDate: cycleFor(today, state.settings.payday).start, personId: local.personId };
  const body = `
    <div class="seg type-seg"><label><input type="radio" name="type" value="expense" ${x.type === 'expense' ? 'checked' : ''}><span>Spesa fissa</span></label><label><input type="radio" name="type" value="income" ${x.type === 'income' ? 'checked' : ''}><span>Entrata</span></label></div>
    <label class="field"><span>Nome</span><input name="name" autocapitalize="sentences" value="${esc(x.name)}" required maxlength="50" placeholder="es. Affitto" ${r ? '' : 'autofocus'}></label>
    <label class="amount-field"><span class="cur">€</span><input name="amount" inputmode="decimal" enterkeyhint="done" autocomplete="off" value="${x.amount ? moneyPlain(x.amount) : ''}" placeholder="0,00" aria-label="Importo"></label>
    <div class="grid2">
      <label class="field"><span>Giorno del mese</span><select name="day">${dayOptions(x.day)}</select></label>
      <label class="field"><span>Frequenza</span><select name="freq">${Object.entries(FREQ).map(([k, v]) => `<option value="${k}" ${x.freq === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select></label>
    </div>
    <div class="grid2">
      <label class="field"><span>Dal</span><input type="date" name="startDate" value="${x.startDate}"></label>
      <label class="field"><span>Fino al (facoltativo)</span><input type="date" name="endDate" value="${x.endDate || ''}"></label>
    </div>
    <p class="small muted">Per le voci ogni 2, 3, 6 o 12 mesi, la data "Dal" indica il mese del primo addebito.</p>
    <div id="catWrap">${catPicker(x.type, x.categoryId)}</div>
    ${personPicker(x.personId)}
    <label class="check"><input type="checkbox" name="paused" ${x.paused ? 'checked' : ''}> In pausa</label>`;
  openSheet(r ? 'Modifica voce fissa' : 'Nuova voce fissa', body, async (f) => {
    const amount = parseAmount(f.amount);
    if (!f.name.trim() || !(amount > 0)) { toast('Servono nome e importo', true); return false; }
    upsert(state, 'recurring', {
      ...(r || {}), type: f.type, name: f.name.trim(), amount, day: Math.min(31, Math.max(1, Number(f.day) || 1)), freq: f.freq,
      startDate: f.startDate || today, endDate: f.endDate || null, categoryId: f.categoryId || fallbackCat(f.type)?.id,
      personId: f.personId || x.personId, paused: f.paused,
    });
    generate(state, today);
    await commit(r ? 'Voce aggiornata' : 'Voce fissa aggiunta');
    return true;
  }, { extraButtons: r ? '<button type="button" class="btn ghost danger" data-action="rec-delete">Elimina</button>' : '' });
  sheet().dataset.editing = r?.id || '';
}

// ---------- Accantonamento ----------
function openFund(fd = null) {
  const x = fd || { name: '', icon: '📦', target: null, dueDate: '', repeat: 'yearly', initial: 0 };
  openSheet(fd ? 'Modifica accantonamento' : 'Nuovo accantonamento', `
    ${iconPicker(x.icon)}
    <div><label class="field"><span>Nome</span><input name="name" autocapitalize="sentences" value="${esc(x.name)}" required placeholder="es. Assicurazione auto" ${fd ? '' : 'autofocus'}></label></div>
    <div class="grid2"><label class="field"><span>Importo da pagare</span><input name="target" inputmode="decimal" enterkeyhint="done" autocomplete="off" value="${x.target ? moneyPlain(x.target) : ''}"></label>
    <label class="field"><span>Scadenza</span><input type="date" name="dueDate" value="${x.dueDate}"></label></div>
    <label class="field"><span>Già messo da parte</span><input name="initial" inputmode="decimal" enterkeyhint="done" autocomplete="off" value="${moneyPlain(x.initial || 0)}"></label>
    <label class="check"><input type="checkbox" name="repeat" ${x.repeat === 'yearly' ? 'checked' : ''}> Si ripete ogni anno</label>
    <label class="check"><input type="checkbox" name="paused" ${x.paused ? 'checked' : ''}> In pausa (nessuna quota nei prossimi cicli)</label>`,
  async (f) => {
    const target = parseAmount(f.target);
    if (!f.name.trim() || !(target > 0) || !f.dueDate) { toast('Servono nome, importo e scadenza', true); return false; }
    const rec = upsert(state, 'funds', {
      ...(fd || { createdOn: todayISO() }), name: f.name.trim(), icon: f.icon || '📦', target, dueDate: f.dueDate,
      repeat: f.repeat ? 'yearly' : 'once', initial: parseAmount(f.initial) || 0, paused: f.paused,
    });
    refreshPotQuota(state, 'fund', rec.id);
    await commit('Accantonamento salvato');
    return true;
  }, { extraButtons: fd ? '<button type="button" class="btn ghost danger" data-action="fund-delete">Elimina</button>' : '' });
  sheet().dataset.editing = fd?.id || '';
}

function openGoal(g = null) {
  const x = g || { name: '', icon: '🎯', target: null, deadline: '', monthly: null, initial: 0 };
  openSheet(g ? 'Modifica obiettivo' : 'Nuovo obiettivo', `
    ${iconPicker(x.icon)}
    <div><label class="field"><span>Nome</span><input name="name" autocapitalize="sentences" value="${esc(x.name)}" required placeholder="es. Fondo emergenze" ${g ? '' : 'autofocus'}></label></div>
    <div class="grid2"><label class="field"><span>Traguardo (vuoto = libero)</span><input name="target" inputmode="decimal" enterkeyhint="done" autocomplete="off" value="${x.target ? moneyPlain(x.target) : ''}"></label>
    <label class="field"><span>Entro il</span><input type="date" name="deadline" value="${x.deadline || ''}"></label></div>
    <div class="grid2"><label class="field"><span>Quota per ciclo</span><input name="monthly" inputmode="decimal" enterkeyhint="done" autocomplete="off" value="${x.monthly ? moneyPlain(x.monthly) : ''}"></label>
    <label class="field"><span>Già risparmiato</span><input name="initial" inputmode="decimal" enterkeyhint="done" autocomplete="off" value="${moneyPlain(x.initial || 0)}"></label></div>
    <label class="check"><input type="checkbox" name="paused" ${x.paused ? 'checked' : ''}> In pausa</label>`,
  async (f) => {
    if (!f.name.trim()) { toast('Serve un nome', true); return false; }
    const rec = upsert(state, 'goals', {
      ...(g || { createdOn: todayISO() }), name: f.name.trim(), icon: f.icon || '🎯', target: parseAmount(f.target) || 0,
      deadline: f.deadline || null, monthly: parseAmount(f.monthly) || 0, initial: parseAmount(f.initial) || 0, paused: f.paused,
    });
    refreshPotQuota(state, 'goal', rec.id);
    await commit('Obiettivo salvato');
    return true;
  }, { extraButtons: g ? '<button type="button" class="btn ghost danger" data-action="goal-delete">Elimina</button>' : '' });
  sheet().dataset.editing = g?.id || '';
}

function openPotMove(kind, id, mode) {
  const pot = kind === 'fund' ? fundById(id) : goalById(id);
  const bal = potBalance(state, kind, id);
  const use = mode === 'use';
  openSheet(use ? `Spesa da «${pot.name}»` : `Versa in «${pot.name}»`, `
    <p class="muted">Disponibile: <b>${money(bal)}</b></p>
    <label class="amount-field"><span class="cur">€</span><input name="amount" inputmode="decimal" enterkeyhint="done" autocomplete="off" placeholder="0,00" autofocus aria-label="Importo" value="${use && kind === 'fund' && pot.target ? moneyPlain(Math.min(pot.target, Math.max(bal, 0))) : ''}"></label>
    ${use ? `<div id="catWrap">${catPicker('expense', guessCat(state, pot.name))}</div>` : ''}
    <div class="grid2"><label class="field"><span>Data</span><input type="date" name="date" value="${todayISO()}"></label>
    <label class="field"><span>Nota</span><input name="note" value="${esc(use ? pot.name : 'Versamento extra')}"></label></div>
    <p class="small muted">${use ? 'La spesa viene pagata con questi soldi e non tocca il budget giornaliero.' : 'Il versamento extra viene tolto dal budget di questo ciclo.'}</p>`,
  async (f) => {
    const amount = parseAmount(f.amount);
    if (!(amount > 0)) { toast('Importo non valido', true); return false; }
    const key = kind === 'fund' ? 'fundId' : 'goalId';
    if (use) upsert(state, 'transactions', { type: 'expense', amount, date: f.date, categoryId: f.categoryId || fallbackCat('expense').id, note: f.note, [key]: id, personId: local.personId });
    else upsert(state, 'transactions', { type: 'save', amount, date: f.date, note: f.note, [key]: id, personId: local.personId });
    await commit(use ? 'Spesa registrata' : 'Versamento registrato');
    return true;
  });
}

// ---------- Categorie, regole, persone ----------
function openCat(c = null, kind = 'expense') {
  const x = c || { name: '', icon: '•', color: '#6b8f71', kind, limit: 0 };
  openSheet(c ? 'Modifica categoria' : 'Nuova categoria', `
    ${iconPicker(x.icon)}
    <div><label class="field"><span>Nome</span><input name="name" autocapitalize="sentences" value="${esc(x.name)}" required maxlength="30"></label></div>
    <div class="grid2"><label class="field"><span>Colore</span><input type="color" name="color" value="${esc(x.color)}"></label>
    <label class="field"><span>Tipo</span><select name="kind"><option value="expense" ${x.kind === 'expense' ? 'selected' : ''}>Uscita</option><option value="income" ${x.kind === 'income' ? 'selected' : ''}>Entrata</option></select></label></div>
    <label class="field"><span>Limite per ciclo (busta)</span><input name="limit" inputmode="decimal" enterkeyhint="done" autocomplete="off" placeholder="nessun limite" value="${x.limit ? moneyPlain(x.limit) : ''}" ${c ? 'autofocus' : ''}></label>`,
  async (f) => {
    if (!f.name.trim()) { toast('Serve un nome', true); return false; }
    upsert(state, 'categories', { ...(c || { order: state.categories.length }), name: f.name.trim(), icon: f.icon || '•', color: f.color, kind: f.kind, limit: parseAmount(f.limit) || 0 });
    await commit('Categoria salvata');
    return true;
  }, { extraButtons: c ? '<button type="button" class="btn ghost danger" data-action="cat-delete">Elimina</button>' : '' });
  sheet().dataset.editing = c?.id || '';
}

function openCatList() {
  openSheet('Categorie', `
    ${['expense', 'income'].map((k) => `<h3>${k === 'expense' ? 'Uscite' : 'Entrate'}</h3><ul class="txlist">${catsOf(k).map((c) => `<li data-action="edit-cat" data-id="${c.id}">${icon(c)}<div class="tx-main"><span class="tx-title">${esc(c.name)}</span><span class="tx-meta">${c.limit ? 'busta ' + money0(c.limit) : ''}</span></div><span class="link">›</span></li>`).join('')}</ul>`).join('')}
    <button type="button" class="btn ghost full" data-action="new-cat">+ Nuova categoria</button>`, null, { noFooter: true });
}

function openRules() {
  const rules = alive(state.rules);
  openSheet('Regole per l\'import', `
    <p class="small muted">Se la descrizione del movimento contiene la parola, la categoria viene assegnata in automatico.</p>
    <ul class="txlist">${rules.map((r) => `<li data-action="edit-rule" data-id="${r.id}">${icon(catById(r.categoryId))}<div class="tx-main"><span class="tx-title">«${esc(r.keyword)}»</span><span class="tx-meta">→ ${esc(catById(r.categoryId)?.name || '')}</span></div><span class="link">›</span></li>`).join('') || '<p class="empty">Nessuna regola.</p>'}</ul>
    <button type="button" class="btn ghost full" data-action="new-rule">+ Nuova regola</button>`, null, { noFooter: true });
}

function openRule(r = null, preset = {}) {
  const x = r || { keyword: preset.keyword || '', categoryId: preset.categoryId || '' };
  openSheet(r ? 'Modifica regola' : 'Nuova regola', `
    <label class="field"><span>La descrizione contiene</span><input name="keyword" value="${esc(x.keyword)}" required autofocus placeholder="es. esselunga"></label>
    ${catPicker('expense', x.categoryId)}`,
  async (f) => {
    if (!f.keyword.trim() || !f.categoryId) { toast('Servono parola e categoria', true); return false; }
    upsert(state, 'rules', { ...(r || {}), keyword: f.keyword.trim().toLowerCase(), categoryId: f.categoryId });
    await commit('Regola salvata');
    openRules();
    return false;
  }, { extraButtons: r ? '<button type="button" class="btn ghost danger" data-action="rule-delete">Elimina</button>' : '' });
  sheet().dataset.editing = r?.id || '';
}

function openPerson(p = null) {
  openSheet(p ? 'Modifica persona' : 'Nuova persona', `<label class="field"><span>Nome</span><input name="name" value="${esc(p?.name || '')}" required autofocus maxlength="30"></label>`,
    async (f) => {
      if (!f.name.trim()) return false;
      upsert(state, 'people', { ...(p || { id: 'p-' + uid().slice(0, 8) }), name: f.name.trim() });
      await commit('Salvato');
      return true;
    }, { extraButtons: p && p.id !== 'p-me' ? '<button type="button" class="btn ghost danger" data-action="person-delete">Elimina</button>' : '' });
  sheet().dataset.editing = p?.id || '';
}

// ---------- Import CSV ----------
function csvStart() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.csv,.txt,text/csv';
  inp.onchange = async () => {
    const file = inp.files[0];
    if (!file) return;
    const text = decodeFile(await file.arrayBuffer());
    const { rows, delimiter } = parseCSV(text);
    if (rows.length < 2) { toast('File vuoto o non riconosciuto', true); return; }
    const headerRow = guessHeaderRow(rows);
    ui.csv = { rows, delimiter, headerRow, map: guessMapping(rows, headerRow), name: file.name, onlyExpenses: true, defaultCat: fallbackCat('expense').id };
    csvMapping();
  };
  inp.click();
}

async function csvMapping() {
  const cs = ui.csv;
  const header = cs.rows[cs.headerRow] || [];
  const colOpts = (sel) => `<option value="-1">—</option>${header.map((h, i) => `<option value="${i}" ${sel === i ? 'selected' : ''}>${esc(h || 'colonna ' + (i + 1))}</option>`).join('')}`;
  const items = await extract(cs.rows, cs.headerRow, cs.map);
  const known = new Set(state.transactions.filter((t) => t.importKey && !t.deleted).map((t) => t.importKey));
  const fresh = items.filter((x) => !known.has(x.key) && (!cs.onlyExpenses || x.type === 'expense'));
  cs.items = fresh;
  const rules = alive(state.rules);
  const preview = fresh.slice(0, 8).map((x) => {
    const cid = x.type === 'expense' ? applyRules(x.desc, rules, cs.defaultCat) : fallbackCat('income').id;
    return `<tr><td>${fmtDate(x.date)}</td><td class="desc">${esc(x.desc.slice(0, 40))}</td><td>${esc(catById(cid)?.icon || '')}</td><td class="${x.type === 'income' ? 'good' : ''}">${x.type === 'income' ? '+' : '−'}${money(x.amount)}</td></tr>`;
  }).join('');
  openSheet('Importa estratto conto', `
    <p class="small muted">${esc(cs.name)} · ${cs.rows.length} righe · separatore «${cs.delimiter === '\t' ? 'tab' : esc(cs.delimiter)}»</p>
    <label class="field"><span>Riga con le intestazioni</span><select data-csv="headerRow">${cs.rows.slice(0, 30).map((r, i) => `<option value="${i}" ${cs.headerRow === i ? 'selected' : ''}>${i + 1}: ${esc(r.filter(Boolean).join(' | ').slice(0, 50))}</option>`).join('')}</select></label>
    <div class="grid2">
      <label class="field"><span>Data</span><select data-csv="map.date">${colOpts(cs.map.date)}</select></label>
      <label class="field"><span>Descrizione</span><select data-csv="map.desc">${colOpts(cs.map.desc)}</select></label>
      <label class="field"><span>Importo (con segno)</span><select data-csv="map.amount">${colOpts(cs.map.amount)}</select></label>
      <label class="field"><span>oppure Uscite / Addebiti</span><select data-csv="map.debit">${colOpts(cs.map.debit)}</select></label>
      <label class="field"><span>e Entrate / Accrediti</span><select data-csv="map.credit">${colOpts(cs.map.credit)}</select></label>
      <label class="field"><span>Categoria se nessuna regola</span><select data-csv="defaultCat">${catsOf('expense').map((c) => `<option value="${c.id}" ${cs.defaultCat === c.id ? 'selected' : ''}>${esc(c.icon)} ${esc(c.name)}</option>`).join('')}</select></label>
    </div>
    <label class="check"><input type="checkbox" data-csv="onlyExpenses" ${cs.onlyExpenses ? 'checked' : ''}> Importa solo le uscite (le entrate fisse sono già nel piano)</label>
    <p><b>${fresh.length}</b> movimenti nuovi${items.length - fresh.length ? `, ${items.length - fresh.length} esclusi o già importati` : ''}.</p>
    ${preview ? `<table class="tbl preview"><tbody>${preview}</tbody></table>` : '<p class="empty">Nessun movimento riconosciuto: controlla le colonne.</p>'}
    <p class="small muted">Attenzione: se nell'estratto ci sono anche affitto, bollette o stipendio già presenti come voci fisse, deselezionali dopo l'import o eliminali, per non contarli due volte.</p>`,
  async () => {
    if (!cs.items.length) return false;
    const rulesNow = alive(state.rules);
    for (const x of cs.items) {
      upsert(state, 'transactions', {
        type: x.type, amount: x.amount, date: x.date, note: x.desc.slice(0, 80), importKey: x.key, personId: local.personId,
        categoryId: x.type === 'expense' ? applyRules(x.desc, rulesNow, cs.defaultCat) : fallbackCat('income').id,
      });
    }
    const n = cs.items.length;
    ui.csv = null;
    ui.tab = 'movimenti';
    await commit(`${n} movimenti importati`);
    return true;
  }, { submitLabel: `Importa ${fresh.length}` });
}

// ---------- Backup ----------
async function shareOrDownload(name, content, type) {
  const blob = new Blob([content], { type });
  const file = new File([blob], name, { type });
  if (navigator.canShare && navigator.canShare({ files: [file] }) && /iphone|ipad|android/i.test(navigator.userAgent)) {
    try { await navigator.share({ files: [file], title: name }); return true; } catch (e) { if (e.name === 'AbortError') return false; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  return true;
}

async function exportJSON() {
  const data = JSON.stringify({ app: 'formichina', version: 1, exportedAt: new Date().toISOString(), state }, null, 1);
  const ok = await shareOrDownload(`formichina-backup-${todayISO()}.json`, data, 'application/json');
  if (ok) { saveLocalAnd(() => { local.lastBackup = new Date().toISOString(); }); render(); toast('Backup esportato'); }
}

async function exportCSV() {
  const rows = [['Data', 'Tipo', 'Importo', 'Categoria', 'Nota', 'Persona', 'Origine']];
  const tipo = { expense: 'Uscita', income: 'Entrata', save: 'Accantonamento' };
  for (const t of alive(state.transactions).sort((a, b) => a.date.localeCompare(b.date))) {
    rows.push([t.date.split('-').reverse().join('/'), tipo[t.type] || t.type, (t.type === 'expense' ? '-' : '') + moneyPlain(t.amount), catById(t.categoryId)?.name || '', txLabel(t), personName(t.personId), txSource(t)]);
  }
  await shareOrDownload(`formichina-movimenti-${todayISO()}.csv`, toCSV(rows), 'text/csv');
}

function importJSON() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.json,application/json';
  inp.onchange = async () => {
    try {
      const data = JSON.parse(await inp.files[0].text());
      const incoming = migrate(data.state || data);
      const n = alive(incoming.transactions).length;
      if (state.settings.onboarded && alive(state.transactions).length) {
        const replace = confirm(`Il backup contiene ${n} movimenti.\n\nOK = sostituisci i dati attuali\nAnnulla = unisci al contenuto attuale`);
        state = replace ? incoming : mergeStates(state, incoming);
      } else state = incoming;
      state.settings.onboarded = true;
      generate(state);
      ui.tab = 'oggi';
      await commit('Backup ripristinato');
    } catch (e) { toast('File non valido: ' + e.message, true); }
  };
  inp.click();
}

// ---------- Promemoria calendario ----------
async function exportICS() {
  const h = String(local.reminderHour).padStart(2, '0');
  const d = todayISO().replace(/-/g, '');
  const url = location.origin + location.pathname + '?action=add';
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Formichina//IT', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
    `UID:formichina-reminder-${local.deviceId}`, `DTSTAMP:${stamp}`, `DTSTART:${d}T${h}0000`, 'DURATION:PT5M', 'RRULE:FREQ=DAILY',
    'SUMMARY:Formichina: registra le spese di oggi', `URL:${url}`, `DESCRIPTION:Apri Formichina: ${url}`,
    'BEGIN:VALARM', 'TRIGGER:PT0M', 'ACTION:DISPLAY', 'DESCRIPTION:Registra le spese di oggi', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  await shareOrDownload('promemoria-formichina.ics', ics, 'text/calendar');
}

// ---------- PIN ----------
const pinHash = (pin) => sha256Hex(local.deviceId + ':formichina-pin:' + pin);

function openPin() {
  if (local.pinHash) {
    openSheet('Blocco con PIN', '<p>Il PIN è attivo. Lo chiederò all\'apertura e quando torni all\'app dopo un minuto.</p>', async () => {
      saveLocalAnd(() => { local.pinHash = null; });
      render(); toast('PIN disattivato');
      return true;
    }, { submitLabel: 'Disattiva PIN' });
    return;
  }
  openSheet('Imposta un PIN', `
    <label class="field"><span>PIN (4-8 cifre)</span><input name="pin" inputmode="numeric" type="password" pattern="[0-9]*" autofocus autocomplete="new-password"></label>
    <label class="field"><span>Ripeti il PIN</span><input name="pin2" inputmode="numeric" type="password" pattern="[0-9]*" autocomplete="new-password"></label>
    <p class="small muted">Il PIN evita occhiate indiscrete, ma non cifra i dati. Se lo dimentichi dovrai cancellare i dati del sito e ripristinare un backup.</p>`,
  async (f) => {
    if (!/^\d{4,8}$/.test(f.pin) || f.pin !== f.pin2) { toast('I PIN non coincidono o non sono validi', true); return false; }
    const hsh = await pinHash(f.pin);
    saveLocalAnd(() => { local.pinHash = hsh; });
    render(); toast('PIN attivato');
    return true;
  });
}

function showLock() {
  if (!local.pinHash) return;
  ui.locked = true;
  const el = $('#lock');
  el.hidden = false;
  let entered = '';
  const draw = () => {
    el.innerHTML = `<div class="lock-box"><img class="logo" src="logo.svg" alt=""><p>Inserisci il PIN</p>
      <div class="pin-dots">${Array.from({ length: Math.max(4, entered.length) }, (_, i) => `<i class="${i < entered.length ? 'on' : ''}"></i>`).join('')}</div>
      <div class="keypad">${[1, 2, 3, 4, 5, 6, 7, 8, 9, '', 0, '⌫'].map((k) => k === '' ? '<span></span>' : `<button data-k="${k}">${k}</button>`).join('')}</div>
      <button class="btn ghost small" data-k="ok">Sblocca</button></div>`;
  };
  draw();
  el.onclick = async (e) => {
    const k = e.target.closest('[data-k]')?.dataset.k;
    if (!k) return;
    if (k === '⌫') entered = entered.slice(0, -1);
    else if (k !== 'ok' && entered.length < 8) entered += k;
    draw();
    if (entered.length >= 4) {
      if ((await pinHash(entered)) === local.pinHash) { el.hidden = true; ui.locked = false; el.innerHTML = ''; }
      else if (k === 'ok' || entered.length === 8) { entered = ''; draw(); el.querySelector('p').textContent = 'PIN errato, riprova'; }
    }
  };
}

// ---------- Sync ----------
function openSyncSetup() {
  openSheet('Sincronizzazione di coppia', `
    <ol class="small steps">
      <li>Su <b>console.firebase.google.com</b> apri (o crea) un progetto. Va bene anche quello del ricettario.</li>
      <li>In Authentication → Metodo di accesso, attiva <b>Anonimo</b>.</li>
      <li>In Firestore Database aggiungi la regola del file <code>firestore.rules</code> incluso nell'app.</li>
      <li>In Impostazioni progetto → Le tue app → Web, copia la configurazione <code>firebaseConfig</code> e incollala qui sotto.</li>
      <li>Scegli una frase segreta lunga e usala uguale sull'altro telefono.</li>
    </ol>
    <label class="field"><span>Configurazione Firebase</span><textarea name="config" rows="6" placeholder='{ "apiKey": "...", "projectId": "..." }'>${local.sync.config ? esc(JSON.stringify(local.sync.config, null, 1)) : ''}</textarea></label>
    <label class="field"><span>Frase segreta condivisa (almeno 12 caratteri)</span><input name="pass" type="password" autocomplete="off"></label>
    <label class="field"><span>Ripeti la frase</span><input name="pass2" type="password" autocomplete="off"></label>
    <p class="small muted">La frase non viene mai inviata: serve a cifrare i dati. Se la perdete, i dati sul cloud sono irrecuperabili (restano quelli sui telefoni).</p>`,
  async (f) => {
    let config;
    try { config = parseFirebaseConfig(f.config); } catch (e) { toast('Configurazione non valida: ' + e.message, true); return false; }
    if ((f.pass || '').length < 12 || f.pass !== f.pass2) { toast('La frase deve avere almeno 12 caratteri e coincidere', true); return false; }
    toast('Preparo la chiave di cifratura…');
    const { docId, keyB64 } = await deriveSecret(f.pass);
    saveLocalAnd(() => { local.sync = { enabled: true, config, docId, keyB64, lastSync: null }; });
    await startSync();
    render();
    return true;
  }, { submitLabel: 'Attiva' });
}

async function startSync() {
  if (!local.sync.enabled || !local.sync.keyB64) return;
  if (sync) sync.stop();
  sync = new Sync({
    deviceId: local.deviceId,
    onStatus: (s) => { syncStatus = s; if (!s.startsWith('errore') && !s.startsWith('connessione')) saveLocalAnd(() => { local.sync.lastSync = new Date().toISOString(); }); if (ui.tab === 'altro' || s.startsWith('errore')) render(); else { const d = $('#syncDot'); if (d) { d.classList.toggle('err', s.startsWith('errore')); d.title = 'Sincronizzazione: ' + s; } } },
    onRemote: async (remote) => {
      if (!remote) { sync.push(state); return; }
      const merged = mergeStates(state, remote);
      const changedLocal = stateFingerprint(merged) !== stateFingerprint(state);
      if (changedLocal) {
        state = merged;
        if (!state.settings.onboarded && alive(state.recurring).length) state.settings.onboarded = true;
        generate(state);
        await saveState(state);
        if (!sheet().open) render();
      }
      if (stateFingerprint(merged) !== stateFingerprint(remote)) sync.push(state);
    },
  });
  try { await sync.start(local.sync); } catch (e) { syncStatus = 'errore: ' + e.message; render(); }
}

// ---------- Storage persistente ----------
async function requestPersist(silent = false) {
  if (!navigator.storage?.persist) { if (!silent) toast('Il browser non lo supporta: installa l\'app nella schermata Home', true); return; }
  const ok = await navigator.storage.persist();
  if (!silent) toast(ok ? 'Dati protetti dalla pulizia automatica' : 'Il browser non l\'ha concesso: installa l\'app nella schermata Home e riprova', !ok);
}

// ================= EVENTI =================
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  const id = el.dataset.id;
  const editing = sheet().dataset.editing;
  switch (a) {
    case 'tab': ui.tab = el.dataset.tab; window.scrollTo(0, 0); render(); break;
    case 'add': openTx(null, { categoryId: el.dataset.cat }); break;
    case 'close-sheet': closeSheet(); break;
    case 'edit-tx': { const t = state.transactions.find((x) => x.id === id); if (t) openTx(t); break; }
    case 'tx-save-more': {
      if (el.disabled) break;
      el.disabled = true;
      const form = sheet().querySelector('form');
      try { const ok = await sheetSubmit?.(formData(form), true); if (ok) closeSheet(); } finally { el.disabled = false; }
      break;
    }
    case 'tx-delete': if (confirm('Eliminare questo movimento?')) { remove(state, 'transactions', editing); closeSheet(); await commit('Movimento eliminato'); } break;
    case 'tx-prev': ui.txOffset++; render(); break;
    case 'tx-next': ui.txOffset = Math.max(0, ui.txOffset - 1); render(); break;
    case 'tx-filter': ui.filter = el.dataset.f; render(); break;
    case 'st-prev': ui.statsOffset++; render(); break;
    case 'st-next': ui.statsOffset = Math.max(0, ui.statsOffset - 1); render(); break;
    case 'filter-cat': if (id) { ui.cat = id; ui.filter = 'all'; ui.txOffset = ui.statsOffset; ui.tab = 'movimenti'; render(); } break;
    case 'plan-tab': ui.planTab = el.dataset.sub; render(); break;
    case 'goto-plan': ui.tab = 'piano'; ui.planTab = el.dataset.sub; render(); break;
    case 'new-rec': openRec(null, el.dataset.type); break;
    case 'edit-rec': openRec(state.recurring.find((x) => x.id === id)); break;
    case 'rec-delete': {
      const keep = confirm('Eliminare la voce fissa?\n\nI movimenti già registrati restano nello storico.');
      if (keep) { remove(state, 'recurring', editing); closeSheet(); await commit('Voce eliminata'); }
      break;
    }
    case 'new-fund': openFund(); break;
    case 'edit-fund': openFund(fundById(id)); break;
    case 'fund-delete': if (confirm('Eliminare l\'accantonamento? Le spese già pagate restano nello storico.')) { remove(state, 'funds', editing); refreshPotQuota(state, 'fund', editing); closeSheet(); await commit('Eliminato'); } break;
    case 'new-goal': openGoal(); break;
    case 'edit-goal': openGoal(goalById(id)); break;
    case 'goal-delete': if (confirm('Eliminare l\'obiettivo?')) { remove(state, 'goals', editing); refreshPotQuota(state, 'goal', editing); closeSheet(); await commit('Eliminato'); } break;
    case 'pot-use': openPotMove(el.dataset.kind, id, 'use'); break;
    case 'pot-add': openPotMove(el.dataset.kind, id, 'add'); break;
    case 'edit-cat': openCat(catById(id)); break;
    case 'new-cat': openCat(); break;
    case 'cat-delete': {
      const used = state.transactions.some((t) => !t.deleted && t.categoryId === editing);
      if (confirm(used ? 'La categoria ha dei movimenti: resteranno senza categoria. Eliminare?' : 'Eliminare la categoria?')) { remove(state, 'categories', editing); closeSheet(); await commit('Categoria eliminata'); }
      break;
    }
    case 'manage-cats': openCatList(); break;
    case 'manage-rules': openRules(); break;
    case 'new-rule': openRule(); break;
    case 'edit-rule': openRule(state.rules.find((r) => r.id === id)); break;
    case 'rule-delete': remove(state, 'rules', editing); await commit('Regola eliminata'); openRules(); break;
    case 'new-person': openPerson(); break;
    case 'edit-person': openPerson(people().find((p) => p.id === id)); break;
    case 'person-delete': if (confirm('Eliminare la persona? I suoi movimenti restano.')) { remove(state, 'people', editing); if (local.personId === editing) saveLocalAnd(() => { local.personId = 'p-me'; }); closeSheet(); await commit('Eliminata'); } break;
    case 'csv-start': csvStart(); break;
    case 'export-json': exportJSON(); break;
    case 'export-csv': exportCSV(); break;
    case 'import-json': importJSON(); break;
    case 'ics': exportICS(); break;
    case 'pin': openPin(); break;
    case 'persist': requestPersist(); break;
    case 'sync-setup': openSyncSetup(); break;
    case 'sync-now': if (sync) { await sync.push(state); toast('Sincronizzato'); } else startSync(); break;
    case 'sync-off':
      if (confirm('Disattivare la sincronizzazione su questo telefono? I dati locali restano.')) {
        if (sync) sync.stop(); sync = null; syncStatus = '';
        saveLocalAnd(() => { local.sync = { enabled: false, config: local.sync.config, docId: null, keyB64: null, lastSync: null }; });
        render();
      }
      break;
    case 'demo':
      if (!state.settings.onboarded || confirm('Sostituire i dati attuali con quelli di esempio?')) {
        state = demoState(); generate(state); ui.tab = 'oggi'; await commit('Dati di esempio caricati');
      }
      break;
    case 'wipe':
      if (confirm('Cancellare TUTTI i dati da questo telefono? Fai prima un backup.') && confirm('Sei sicuro? L\'operazione non si può annullare.')) {
        state = emptyState(); ui.ob = 0; ui.obData = null; await commit('Dati cancellati');
      }
      break;
    case 'ob-next':
      obRead();
      if (ui.ob === 1 && !(parseAmount(ui.obData.salary) > 0)) { toast('Inserisci lo stipendio (o un\'entrata indicativa)', true); return; }
      if (ui.ob >= 4) { await obFinish(); return; }
      ui.ob++; render(); window.scrollTo(0, 0); break;
    case 'ob-back': obRead(); ui.ob = Math.max(0, ui.ob - 1); render(); break;
    case 'ob-addfixed': obRead(); ui.obData.fixed.push({ name: '', amount: '', day: 1, freq: 'monthly' }); render(); break;
    default: break;
  }
});

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('#sheet form');
  if (!form) return;
  e.preventDefault();
  if (!sheetSubmit) { closeSheet(); return; }
  const btn = form.querySelector('footer .btn[type=submit]');
  if (btn) btn.disabled = true;
  try {
    const ok = await sheetSubmit(formData(form), false);
    if (ok) closeSheet();
  } finally { if (btn) btn.disabled = false; }
});

document.addEventListener('change', async (e) => {
  const el = e.target;
  // cambio Uscita/Entrata nel foglio: aggiorna le categorie mostrate
  if (el.name === 'type' && el.closest('#sheet')) {
    const wrap = $('#catWrap');
    if (wrap) wrap.innerHTML = catPicker(el.value, el.value === 'income' ? catsOf('income')[0]?.id : '');
    sheet().querySelectorAll('.expense-only').forEach((x) => { x.hidden = el.value !== 'expense'; });
    return;
  }
  // griglia icone: scegliere un'icona svuota il campo "altra emoji"
  if (el.name === 'icon' && el.type === 'radio') {
    const c = el.closest('.field')?.querySelector('.icon-custom');
    if (c) c.value = '';
    return;
  }
  if (el.dataset.setting) {
    const k = el.dataset.setting;
    const v = k === 'payday' ? Number(el.value) : el.value.trim();
    updateSettings(state, { [k]: v });
    if (k === 'payday') generate(state);
    await commit('Impostazione salvata');
    return;
  }
  if (el.dataset.local) {
    const k = el.dataset.local;
    saveLocalAnd(() => { local[k] = k === 'reminderHour' ? Number(el.value) : el.value; });
    if (k === 'theme') applyTheme();
    render();
    return;
  }
  if (el.dataset.bind === 'cat') { ui.cat = el.value; render(); return; }
  if (el.dataset.csv && ui.csv) {
    const k = el.dataset.csv;
    if (k === 'onlyExpenses') ui.csv.onlyExpenses = el.checked;
    else if (k === 'defaultCat') ui.csv.defaultCat = el.value;
    else if (k === 'headerRow') { ui.csv.headerRow = Number(el.value); ui.csv.map = guessMapping(ui.csv.rows, ui.csv.headerRow); }
    else ui.csv.map[k.split('.')[1]] = Number(el.value);
    if (k === 'map.amount' && Number(el.value) >= 0) { ui.csv.map.debit = -1; ui.csv.map.credit = -1; }
    if ((k === 'map.debit' || k === 'map.credit') && Number(el.value) >= 0) ui.csv.map.amount = -1;
    csvMapping();
  }
});

const searchLater = debounce(() => {
  const box = $('#txResults');
  if (box) box.innerHTML = renderTx(true); else render();
}, 200);
document.addEventListener('input', (e) => {
  if (e.target.dataset.bind === 'search') { ui.search = e.target.value; searchLater(); }
  if (e.target.classList?.contains('icon-custom') && e.target.value.trim()) {
    e.target.closest('.field')?.querySelectorAll('input[name=icon]').forEach((r) => { r.checked = false; });
  }
});

// tastiera: chiudi il foglio con Esc gestito dal dialog; tocco sullo sfondo chiude
// tocco sullo sfondo scuro chiude il foglio (non nei primi istanti: evita che un doppio tocco lo richiuda)
document.addEventListener('click', (e) => {
  const d = sheet();
  if (e.target === d && Date.now() - sheetOpenedAt > 500) closeSheet();
});
// un tocco sullo sfondo non deve togliere il cursore dal campo (su iPhone chiuderebbe la tastiera)
document.addEventListener('pointerdown', (e) => { if (e.target === sheet()) e.preventDefault(); });
document.addEventListener('mousedown', (e) => { if (e.target === sheet()) e.preventDefault(); });

// Invio sulla tastiera durante la configurazione iniziale = passa al campo successivo / Avanti
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target.matches?.('.ob input')) return;
  e.preventDefault();
  const fields = [...document.querySelectorAll('.ob input, .ob select')].filter((x) => x.offsetParent);
  const next = fields[fields.indexOf(e.target) + 1];
  if (next && next.tagName === 'INPUT') next.focus();
  else { e.target.blur(); document.querySelector('[data-action="ob-next"]')?.click(); }
});

// Tastiera del telefono: il foglio resta sopra la tastiera (iPhone non ridimensiona la pagina)
if (window.visualViewport) {
  const vv = window.visualViewport;
  const fit = () => {
    const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty('--kb', (kb > 80 ? kb : 0) + 'px');
  };
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
}
document.addEventListener('focusin', (e) => {
  if (e.target.closest?.('.sheet-body') && e.target.matches('input, select, textarea')) {
    setTimeout(() => e.target.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300);
  }
});

// ---------- Avvio ----------
let lastDay = todayISO();
function onDayChange() {
  const t = todayISO();
  if (t !== lastDay) {
    lastDay = t;
    if (state.settings.onboarded && generate(state)) saveState(state);
    if (!sheet().open) render();
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { ui.hiddenAt = Date.now(); return; }
  onDayChange();
  if (local.pinHash && !ui.locked && Date.now() - ui.hiddenAt > 60000) showLock();
});
setInterval(onDayChange, 60000);
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);

function handleURL() {
  const p = new URLSearchParams(location.search);
  if (!p.has('action') && !p.has('amount') && !p.has('tab')) return;
  if (state.settings.onboarded && (p.get('action') === 'add' || p.has('amount'))) {
    const name = (p.get('cat') || '').toLowerCase();
    const c = cats().find((x) => x.name.toLowerCase() === name || x.id === name);
    openTx(null, {
      amount: parseAmount(p.get('amount')) || null, categoryId: c?.id, note: p.get('note') || '',
      type: p.get('type') === 'income' ? 'income' : 'expense',
    });
  }
  if (p.get('tab') && ['oggi', 'movimenti', 'piano', 'stats', 'altro'].includes(p.get('tab'))) { ui.tab = p.get('tab'); render(); }
  history.replaceState(null, '', location.pathname);
}

async function init() {
  local = loadLocal();
  saveLocal(local);
  applyTheme();
  state = await loadState();
  if (state.settings.onboarded) {
    const n = generate(state);
    compact(state);
    if (n) await saveState(state);
  }
  render();
  handleURL();
  if (local.pinHash) showLock();
  if (local.sync.enabled) startSync();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        nw?.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) toast('Nuova versione pronta: riapri l\'app per aggiornarla');
        });
      });
    }).catch(() => {});
  }
}

init();

// esposto per i test
window.__formichina = { get state() { return state; }, computeCycle, MONTHS };
