/* Signal archive (daily.html): paginated approved digests + interest-weight chart.
   Uses the helpers from daily.js. All fetched text goes through textContent; the chart is
   inline SVG built with createElementNS (no library). */
(() => {
  'use strict';
  const S = window.SignalDaily;
  if (!S) return;
  const { getJSON, parsePage, renderItem, relDay, localDate, el, isStr, DATE_RE, MOCK } = S;
  const q = sel => document.querySelector(sel);

  if (MOCK) q('[data-back]').href = 'index.html?mock#signal';

  const yearOf = () => new Date().getFullYear();
  const fmtDay = ymd => {
    const d = localDate(ymd);
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric',
      year: d.getFullYear() === yearOf() ? undefined : 'numeric' });
  };
  const fmtShort = ymd => localDate(ymd).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  /* =================== digests: paginated, approved only =================== */
  const box = q('[data-digests]'), note = q('[data-dig-note]'), more = q('[data-more]');
  const seen = new Set();
  let nextBefore = null, pagesLoaded = 0, busy = false;

  function renderDigest(d) {
    const art = el('article', 'arch-dig');
    const h = el('h3', 'arch-date');
    const t = el('time', null, fmtDay(d.date));
    t.dateTime = d.date;
    h.append(t, el('span', 'rel', relDay(d.date)));
    const ol = el('ol', 'daily-list');
    ol.setAttribute('role', 'list');
    d.items.forEach(it => ol.appendChild(renderItem(it, { showDate: false })));
    art.append(h, ol);
    return art;
  }

  function showNote(text) { note.textContent = text; note.hidden = !text; }

  async function loadPage() {
    if (busy) return;
    busy = true;
    const first = pagesLoaded === 0;
    more.disabled = true;
    more.textContent = 'Loading…';
    const path = '/digests?approved=true&limit=10' + (nextBefore ? '&before=' + nextBefore : '');
    try {
      const { data } = await getJSON(path, 'daily.mock.json');
      const page = parsePage(data);
      for (const d of page.digests) {
        if (seen.has(d.id)) continue;           // pages shouldn't overlap; never render twice anyway
        seen.add(d.id);
        box.appendChild(renderDigest(d));
      }
      // The cursor must strictly decrease (ids descend); anything else would loop forever.
      const nb = page.nextBefore;
      nextBefore = (nb !== null && (nextBefore === null || nb < nextBefore)) ? nb : null;
      pagesLoaded++;

      if (!seen.size) showNote('No approved digests yet. New ones arrive most mornings at 8:00 ET.');
      else if (nextBefore === null) showNote(seen.size === 1 ? "That's everything so far: one digest." : `That's everything: ${seen.size} digests.`);
      else showNote('');
      more.hidden = nextBefore === null;
      more.textContent = 'Load more';
    } catch (_) {
      showNote(first
        ? "Couldn't reach Signal right now. The backend may be waking up; try again in a minute."
        : "Couldn't load the next page.");
      more.hidden = false;
      more.textContent = 'Try again';
    } finally {
      busy = false;
      more.disabled = false;
    }
  }
  more.addEventListener('click', loadPage);
  loadPage();

  /* =================== interest chart =================== */
  const chartEl = q('[data-chart]'), legendEl = q('[data-legend]'), chartNote = q('[data-chart-note]');
  const tableWrap = q('[data-table-wrap]'), tableEl = q('[data-table]');
  const NS = 'http://www.w3.org/2000/svg';
  const MAX_SERIES = 8;           // categorical slots; more terms fold into the table
  const W_MAX = 5;                // weights are 0–5 by contract: fixed, honest scale

  function svg(tag, attrs = {}, style = {}) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    Object.assign(e.style, style);  // var() colours need style, not presentation attributes
    return e;
  }
  const dayNum = ymd => { const m = DATE_RE.exec(ymd); return Date.UTC(+m[1], +m[2] - 1, +m[3]) / 864e5; };
  const ymdOf = day => new Date(day * 864e5).toISOString().slice(0, 10);
  const fmtW = w => (w == null ? '—' : w.toFixed(2));
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  function parseHistory(h) {
    if (!h || typeof h !== 'object' || !DATE_RE.test(h.start) || !DATE_RE.test(h.end) || !Array.isArray(h.terms)) {
      throw new Error('malformed');
    }
    const terms = h.terms
      .filter(t => t && isStr(t.term) && Array.isArray(t.points))
      .map(t => ({
        term: t.term,
        origin: t.origin === 'manual' || t.origin === 'learned' ? t.origin : null,
        current: Number.isFinite(t.current_weight) ? t.current_weight : null,
        points: t.points
          .filter(p => p && DATE_RE.test(p.date) && Number.isFinite(p.weight))
          .map(p => ({ day: dayNum(p.date), w: p.weight }))
          .sort((a, b) => a.day - b.day),
      }));
    terms.forEach(t => { t.removed = t.current === null; });
    return { start: h.start, end: h.end, d0: dayNum(h.start), d1: dayNum(h.end), terms };
  }

  let H = null, series = [], removed = [], folded = [], days = [];

  function prepare(hist) {
    H = hist;
    const active = H.terms.filter(t => !t.removed && t.points.length);
    // API order is heaviest-first, so the top 8 get plotted; colours then follow the term
    // (alphabetical), not its rank, so a reorder in weight doesn't repaint the lines.
    series = active.slice(0, MAX_SERIES);
    folded = active.slice(MAX_SERIES);
    [...series].sort((a, b) => a.term.toLowerCase().localeCompare(b.term.toLowerCase()))
      .forEach((s, i) => { s.color = `var(--s${i + 1})`; });
    removed = H.terms.filter(t => t.removed && t.points.length).slice(0, 4);
    removed.forEach(s => { s.color = 'var(--muted)'; s.dashed = true; });
    days = [...new Set([...series, ...removed].flatMap(s => s.points.map(p => p.day)))].sort((a, b) => a - b);
  }

  let tip = null, cross = null, geom = null, activeIdx = -1;

  function draw() {
    const W = Math.max(280, Math.round(chartEl.clientWidth));
    const all = [...series, ...removed];
    const direct = all.length <= 4;
    const m = { t: 10, r: direct ? 104 : 14, b: 26, l: 30 };
    const h = 230, pw = W - m.l - m.r, ph = h - m.t - m.b;
    const span = Math.max(1, H.d1 - H.d0);
    const x = d => m.l + (d - H.d0) / span * pw;
    const y = w => m.t + ph * (1 - Math.min(W_MAX, Math.max(0, w)) / W_MAX);
    geom = { x, y, m, pw, ph, W };

    const root = svg('svg', {
      width: W, height: h, viewBox: `0 0 ${W} ${h}`, role: 'img',
      'aria-label': `Line chart of interest weights, 0 to 5, from ${fmtShort(H.start)} to ${fmtShort(H.end)}, `
        + `${all.length} term${all.length === 1 ? '' : 's'}. Values are in the legend and the table below.`,
    });

    // recessive grid + y ticks
    for (let v = 0; v <= W_MAX; v++) {
      root.appendChild(svg('line', { x1: m.l, x2: m.l + pw, y1: y(v), y2: y(v), 'stroke-width': 1 },
        { stroke: v === 0 ? 'var(--line)' : 'var(--line-soft)' }));
      const t = svg('text', { x: m.l - 8, y: y(v) + 3, 'text-anchor': 'end', class: 'axis' });
      t.textContent = String(v);
      root.appendChild(t);
    }
    // x ticks: range start / end (+ middle when there's room)
    const xt = [[H.d0, 'start'], [H.d1, 'end']];
    if (pw > 360) xt.push([Math.round((H.d0 + H.d1) / 2), 'middle']);
    for (const [d, anchor] of xt) {
      const t = svg('text', { x: x(d), y: h - 6, 'text-anchor': anchor, class: 'axis' });
      t.textContent = fmtShort(ymdOf(d));
      root.appendChild(t);
    }

    // series: 2px lines, markers only where they carry information (last point / lone points)
    for (const s of all) {
      if (s.points.length > 1) {
        root.appendChild(svg('path', {
          d: s.points.map((p, i) => `${i ? 'L' : 'M'}${x(p.day).toFixed(1)},${y(p.w).toFixed(1)}`).join(''),
          fill: 'none', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
          ...(s.dashed ? { 'stroke-dasharray': '5 4' } : {}),
        }, { stroke: s.color }));
      }
      const last = s.points[s.points.length - 1];
      root.appendChild(svg('circle', { cx: x(last.day), cy: y(last.w), r: 4, 'stroke-width': 2 },
        { fill: s.color, stroke: 'var(--paper-3)' }));
    }

    // direct labels (≤4 series), pushed apart so identical weights don't overprint
    if (direct) {
      const labels = all.map(s => {
        const last = s.points[s.points.length - 1];
        return { s, y: y(last.w) };
      }).sort((a, b) => a.y - b.y);
      const GAP = 15;
      for (let i = 1; i < labels.length; i++) labels[i].y = Math.max(labels[i].y, labels[i - 1].y + GAP);
      const overflow = labels.length ? labels[labels.length - 1].y - (m.t + ph) : 0;
      if (overflow > 0) labels.forEach(l => { l.y -= overflow; });
      const lx = m.l + pw + 12;
      for (const l of labels) {
        root.appendChild(svg('line', { x1: lx, x2: lx + 12, y1: l.y, y2: l.y, 'stroke-width': 2,
          ...(l.s.dashed ? { 'stroke-dasharray': '3 2' } : {}) }, { stroke: l.s.color }));
        const t = svg('text', { x: lx + 18, y: l.y + 4, class: 'dlabel' });
        t.textContent = clip(l.s.term, 11);
        root.appendChild(t);
      }
    }

    // crosshair (hover / keyboard) + an overlay bigger than the marks as the hit target
    cross = svg('line', { y1: m.t, y2: m.t + ph, 'stroke-width': 1, visibility: 'hidden' }, { stroke: 'var(--ink)' });
    root.appendChild(cross);
    const hit = svg('rect', { x: m.l - 12, y: 0, width: pw + 24, height: h, fill: 'transparent' });
    hit.addEventListener('pointermove', e => {
      const r = root.getBoundingClientRect();
      show(nearestIdx(e.clientX - r.left));
    });
    hit.addEventListener('pointerleave', hide);
    root.appendChild(hit);

    tip = el('div', 'sig-tip');
    tip.hidden = true;
    tip.setAttribute('aria-hidden', 'true');   // same values are in the legend + table
    chartEl.replaceChildren(root, tip);
    if (activeIdx >= 0) show(activeIdx);
  }

  function nearestIdx(px) {
    let best = -1, bd = Infinity;
    days.forEach((d, i) => { const dd = Math.abs(geom.x(d) - px); if (dd < bd) { bd = dd; best = i; } });
    return best;
  }

  function show(i) {
    if (i < 0 || !days.length) return;
    activeIdx = i;
    const day = days[i], cx = geom.x(day);
    cross.setAttribute('x1', cx);
    cross.setAttribute('x2', cx);
    cross.setAttribute('visibility', 'visible');

    tip.replaceChildren(el('div', 'tip-date', fmtDay(ymdOf(day))));
    for (const s of [...series, ...removed]) {
      const p = s.points.find(pt => pt.day === day);
      const row = el('div', 'tip-row');
      const key = el('span', 'tip-key');
      key.style.background = s.color;
      row.append(key, el('span', 'tip-val', fmtW(p ? p.w : null)), el('span', 'tip-term', s.term + (s.removed ? ' (removed)' : '')));
      tip.appendChild(row);
    }
    tip.hidden = false;
    const tw = tip.offsetWidth;
    const left = cx + 12 + tw > geom.W ? cx - 12 - tw : cx + 12;
    tip.style.left = Math.max(0, left) + 'px';
    tip.style.top = geom.m.t + 'px';
  }

  function hide() {
    activeIdx = -1;
    if (cross) cross.setAttribute('visibility', 'hidden');
    if (tip) tip.hidden = true;
  }

  chartEl.addEventListener('keydown', e => {
    if (!days.length) return;
    const last = days.length - 1;
    const cur = activeIdx < 0 ? last : activeIdx;
    let n = null;
    if (e.key === 'ArrowLeft') n = Math.max(0, cur - 1);
    else if (e.key === 'ArrowRight') n = Math.min(last, cur + 1);
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = last;
    else if (e.key === 'Escape') { hide(); return; }
    if (n !== null) { e.preventDefault(); show(n); }
  });
  chartEl.addEventListener('focus', () => show(activeIdx < 0 ? days.length - 1 : activeIdx));
  chartEl.addEventListener('blur', hide);

  function renderLegend() {
    const items = [];
    for (const s of [...series, ...removed]) {
      const li = el('li');
      const key = el('span', 'key' + (s.dashed ? ' dashed' : ''));
      if (!s.dashed) key.style.background = s.color;
      li.append(key, el('span', null, s.term), el('span', 'val', s.removed ? 'removed' : fmtW(s.current)));
      items.push(li);
    }
    if (folded.length) items.push(el('li', 'val', `+${folded.length} more in the table`));
    legendEl.replaceChildren(...items);
  }

  function renderTable() {
    const table = el('table');
    const cap = el('caption', 'sr-only', 'Interest terms and weights');
    const thead = el('thead'), hr = el('tr');
    ['Term', 'Status', 'Current weight', 'Snapshots', 'Latest snapshot'].forEach(c => {
      const th = el('th', null, c); th.scope = 'col'; hr.appendChild(th);
    });
    thead.appendChild(hr);
    const tbody = el('tbody');
    for (const t of H.terms) {
      const tr = el('tr');
      const last = t.points[t.points.length - 1];
      tr.append(
        el('td', null, t.term),
        el('td', null, t.removed ? 'removed' : (t.origin || '—')),
        el('td', 'num', t.removed ? '—' : fmtW(t.current)),
        el('td', 'num', String(t.points.length)),
        el('td', null, last ? `${fmtShort(ymdOf(last.day))} · ${fmtW(last.w)}` : '—'),
      );
      tbody.appendChild(tr);
    }
    table.append(cap, thead, tbody);
    tableEl.replaceChildren(table);
  }

  function setChartNote(text) { chartNote.textContent = text; chartNote.hidden = !text; }

  async function loadHistory() {
    try {
      const { data } = await getJSON('/interests/history?days=90', 'daily-history.mock.json');
      const hist = parseHistory(data);
      if (!hist.terms.length) { setChartNote('No interest terms yet.'); return; }

      prepare(hist);
      renderTable();
      tableWrap.hidden = false;

      if (!days.length) {
        setChartNote("No snapshots yet. One is taken each morning Signal sends, so this fills in over time.");
        return;
      }
      chartEl.hidden = false;
      legendEl.hidden = false;
      chartEl.tabIndex = 0;
      chartEl.setAttribute('aria-label', 'Interest chart. Use the left and right arrow keys to step through dates.');
      draw();
      renderLegend();
      setChartNote(days.length === 1
        ? `Only one day of snapshots so far (${fmtShort(ymdOf(days[0]))}). Lines appear as history builds.`
        : '');

      let lastW = chartEl.clientWidth;
      new ResizeObserver(() => {
        const w = chartEl.clientWidth;
        if (w && Math.abs(w - lastW) > 1) { lastW = w; draw(); }
      }).observe(chartEl);
    } catch (_) {
      chartEl.hidden = true;
      legendEl.hidden = true;
      setChartNote("Interest history is unavailable right now.");
    }
  }
  loadHistory();
})();
