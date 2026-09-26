/* Signal — the portfolio side. Fills index.html#signal from the live API and exposes shared
   helpers for daily.html (window.SignalDaily).

   Rules this file keeps (from the Signal frontend handoff):
   - Always request approved=true.
   - Fetched text is untrusted: build DOM with createElement + textContent, never innerHTML.
   - Links only for http(s) URLs, opened with rel="noopener noreferrer".
   - Fail quietly: 3s AbortController timeout; on timeout, network error, non-2xx, bad JSON
     or an empty result the homepage section simply stays hidden.
   - ?mock reads daily.mock.json / daily-history.mock.json (localhost isn't an allowed CORS
     origin for the live API). */
(() => {
  'use strict';

  const API = 'https://signal-yfj9.onrender.com';
  const TIMEOUT_MS = 3000;
  const MOCK = new URLSearchParams(location.search).has('mock');
  const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

  async function getJSON(path, mockFile) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const t0 = performance.now();
    try {
      const res = await fetch(MOCK ? mockFile : API + path, { signal: ctrl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();          // throws on malformed JSON
      return { data, ms: performance.now() - t0 };
    } finally {
      clearTimeout(timer);                     // the timeout covers the body read too
    }
  }

  const isStr = v => typeof v === 'string' && v.trim() !== '';
  const safeHref = u => (typeof u === 'string' && /^https?:\/\//i.test(u)) ? u : null;

  const validItem = it => it && typeof it === 'object' && isStr(it.headline) && typeof it.url === 'string'
    && isStr(it.source) && typeof it.reason === 'string' && DATE_RE.test(it.digest_date);
  const validDigest = d => d && typeof d === 'object' && Number.isInteger(d.id)
    && DATE_RE.test(d.date) && Array.isArray(d.items);

  // Shape-check a DigestPage. Throws if the top level is wrong; drops individual bad
  // digests/items rather than trusting them.
  function parsePage(data) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.digests)) throw new Error('malformed');
    const digests = data.digests.filter(validDigest)
      .map(d => ({ id: d.id, date: d.date, items: d.items.filter(validItem) }))
      .filter(d => d.items.length);
    const nb = data.next_before;
    return { digests, nextBefore: Number.isInteger(nb) && nb >= 1 ? nb : null };
  }

  // YYYY-MM-DD as a local calendar date (not UTC midnight), so "today" is the viewer's today.
  function localDate(ymd) {
    const m = DATE_RE.exec(ymd);
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  }

  function relDay(ymd) {
    const d = localDate(ymd);
    if (!d) return '';
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const days = Math.round((today - d) / 864e5);   // round: DST days are 23/25h
    if (days <= 0) return 'today';                  // <0 when the viewer is behind New York
    if (days === 1) return 'yesterday';
    if (days < 7) return days + ' days ago';
    return d.toLocaleDateString('en-US', {
      month: 'short', day: 'numeric',
      year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric',
    });
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function renderItem(it, { showDate = true } = {}) {
    const li = el('li', 'daily-item');
    const href = safeHref(it.url);
    let head;
    if (href) {
      head = el('a', 'daily-head', it.headline);
      head.href = href;
      head.target = '_blank';
      head.rel = 'noopener noreferrer';
      head.appendChild(el('span', 'sr-only', ' (opens in a new tab)'));
    } else {
      head = el('span', 'daily-head', it.headline);
    }

    const sub = el('p', 'daily-sub');
    sub.appendChild(el('span', 'daily-src', it.source));
    if (showDate) {
      const t = el('time', null, relDay(it.digest_date));
      t.dateTime = it.digest_date;
      sub.append(' · ', t);
    }
    if (isStr(it.entity)) sub.append(' · ', it.entity);   // string → text node

    li.append(head, sub);
    if (isStr(it.reason)) li.appendChild(el('p', 'daily-why', it.reason));
    return li;
  }

  async function initHome() {
    const section = document.getElementById('signal');
    if (!section) return;
    try {
      const { data, ms } = await getJSON('/digests?approved=true&limit=5', 'daily.mock.json');
      const seen = new Set();
      const items = [];
      for (const d of parsePage(data).digests) {
        for (const it of d.items) {
          if (items.length >= 5) break;
          if (seen.has(it.id)) continue;
          seen.add(it.id);
          items.push(it);
        }
      }
      if (!items.length) return;

      section.querySelector('[data-daily-list]').replaceChildren(...items.map(it => renderItem(it)));
      section.querySelector('[data-daily-meta]').textContent =
        MOCK ? 'mock data' : `live · ${Math.round(ms)} ms`;
      if (MOCK) section.querySelector('[data-daily-archive]').href = 'daily.html?mock';

      section.hidden = false;
      document.querySelectorAll('.tree a[href="#signal"]').forEach(a => { a.hidden = false; });
      document.dispatchEvent(new Event('docs:change'));
    } catch (_) {
      /* fail quiet — section stays hidden, the rest of the page is unaffected */
    }
  }

  window.SignalDaily = { API, MOCK, DATE_RE, getJSON, parsePage, renderItem, relDay, localDate, el, isStr };
  initHome();
})();
