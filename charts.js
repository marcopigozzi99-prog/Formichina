// Grafici SVG disegnati a mano: nessuna libreria, funzionano offline e seguono il tema.
import { money0, fromISO, WEEKDAYS_SHORT, esc } from './util.js';

const niceMax = (v) => {
  if (v <= 0) return 100;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
};

// Anello del budget di oggi
export function ring(ratio, size = 196) {
  const r = size / 2 - 12;
  const c = 2 * Math.PI * r;
  const used = Math.max(0, Math.min(1, ratio));
  const over = ratio > 1;
  return `<svg class="ring" viewBox="0 0 ${size} ${size}" aria-hidden="true">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="ring-track"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="ring-fill ${over ? 'over' : ''}"
      stroke-dasharray="${(c * used).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 ${size / 2} ${size / 2})"/>
  </svg>`;
}

// Spesa giornaliera (barre) contro budget del giorno (linea a gradini)
export function dailyChart(series, today) {
  const W = 340, H = 170, L = 34, R = 6, T = 10, B = 22;
  const max = niceMax(Math.max(...series.map((d) => Math.max(d.spent, d.budget, 0))) * 1.05);
  const n = series.length;
  const bw = (W - L - R) / n;
  const y = (v) => T + (H - T - B) * (1 - Math.max(0, v) / max);
  let bars = '';
  let line = '';
  series.forEach((d, i) => {
    const x = L + i * bw;
    if (!d.future) {
      const over = d.spent > d.budget;
      bars += `<rect x="${(x + bw * 0.18).toFixed(1)}" y="${y(d.spent).toFixed(1)}" width="${(bw * 0.64).toFixed(1)}" height="${(H - B - y(d.spent)).toFixed(1)}" rx="1.5" class="${over ? 'bar-over' : 'bar'}${d.date === today ? ' bar-today' : ''}"><title>${esc(d.date)}: ${money0(d.spent)} su ${money0(d.budget)}</title></rect>`;
    }
    line += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y(d.budget).toFixed(1)}H${(x + bw).toFixed(1)}`;
  });
  const ticks = [0, max / 2, max].map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 4}" y="${y(v) + 3}" class="axis" text-anchor="end">${money0(v).replace(/\s?€/, '')}</text>`).join('');
  const labels = series.map((d, i) => {
    const day = fromISO(d.date).getDate();
    if (i !== 0 && i !== n - 1 && d.date !== today && i % 7 !== 0) return '';
    if (i !== n - 1 && d.date !== today && (n - 1 - i < 3 || Math.abs(series.findIndex((x) => x.date === today) - i) < 2)) return '';
    return `<text x="${(L + i * bw + bw / 2).toFixed(1)}" y="${H - 6}" class="axis${d.date === today ? ' axis-strong' : ''}" text-anchor="middle">${day}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Spesa giornaliera rispetto al budget del giorno">${ticks}${bars}<path d="${line}" class="budget-line"/>${labels}</svg>`;
}

// Cicli: barre impilate (fisse, variabili, risparmi) e tacca delle entrate
export function historyChart(cycles) {
  const W = 340, H = 190, L = 40, R = 6, T = 10, B = 26;
  const data = [...cycles].reverse();
  const max = niceMax(Math.max(...data.map((c) => Math.max(c.incomes, c.fixed + c.variable + c.reserved))) * 1.05);
  const bw = (W - L - R) / data.length;
  const y = (v) => T + (H - T - B) * (1 - Math.max(0, v) / max);
  const h = (v) => (H - T - B) * Math.max(0, v) / max;
  let out = '';
  data.forEach((c, i) => {
    const x = L + i * bw + bw * 0.2;
    const w = bw * 0.6;
    let base = H - B;
    for (const [v, cls] of [[c.fixed, 'seg-fixed'], [c.variable, 'seg-var'], [c.reserved, 'seg-save']]) {
      const hh = h(v);
      base -= hh;
      out += `<rect x="${x.toFixed(1)}" y="${base.toFixed(1)}" width="${w.toFixed(1)}" height="${hh.toFixed(1)}" class="${cls}"/>`;
    }
    out += `<line x1="${(x - 4).toFixed(1)}" x2="${(x + w + 4).toFixed(1)}" y1="${y(c.incomes).toFixed(1)}" y2="${y(c.incomes).toFixed(1)}" class="income-tick"/>`;
    const d = fromISO(c.cycle.start);
    const lab = d.toLocaleDateString('it-IT', { month: 'short' });
    out += `<text x="${(x + w / 2).toFixed(1)}" y="${H - 8}" class="axis${c.current ? ' axis-strong' : ''}" text-anchor="middle">${lab}</text>`;
  });
  const ticks = [0, max / 2, max].map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 4}" y="${y(v) + 3}" class="axis" text-anchor="end">${money0(v).replace(/\s?€/, '')}</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Entrate e uscite per ciclo">${ticks}${out}</svg>`;
}

export function weekdayChart(values) {
  const W = 340, H = 140, L = 6, R = 6, T = 18, B = 20;
  const order = [1, 2, 3, 4, 5, 6, 0];
  const max = Math.max(...values, 1);
  const bw = (W - L - R) / 7;
  const top = order.reduce((m, i) => (values[i] > values[m] ? i : m), 1);
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Spesa media per giorno della settimana">${order.map((wd, k) => {
    const v = values[wd];
    const hh = (H - T - B) * v / max;
    const x = L + k * bw + bw * 0.18;
    return `<rect x="${x.toFixed(1)}" y="${(H - B - hh).toFixed(1)}" width="${(bw * 0.64).toFixed(1)}" height="${hh.toFixed(1)}" rx="3" class="${wd === top ? 'bar-accent' : 'bar'}"/>
      <text x="${(x + bw * 0.32).toFixed(1)}" y="${(H - B - hh - 5).toFixed(1)}" class="axis" text-anchor="middle">${money0(v).replace(/\s?€/, '')}</text>
      <text x="${(x + bw * 0.32).toFixed(1)}" y="${H - 5}" class="axis${wd === top ? ' axis-strong' : ''}" text-anchor="middle">${WEEKDAYS_SHORT[wd]}</text>`;
  }).join('')}</svg>`;
}
