// Guided tour ("panduan"): a small card points at one thing on the screen and explains it,
// then "Lanjut ›" moves to the next one, across all the screens of the app.
// The page under the tour cannot be touched (a layer catches every tap), so nothing is ever
// recorded while it runs. The app shows each screen through step.show(), awaited before pointing.
//
//   startTour(steps, { labels, onEnd })
//   step = { show?: async () => {}, el?: 'css selector' | [selectors, first found wins], title, text }
//   A step whose element is not on the screen is shown as a card in the middle (never skipped,
//   so the counter stays the same for everyone).

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let current = null;
export const tourRunning = () => !!current;

export function startTour(steps, { labels = {}, onEnd = () => {} } = {}) {
  if (current || !steps.length) return;
  const L = { next: 'Next ›', back: '‹ Back', done: 'Finish', close: 'Close', of: '/', ...labels };
  const root = document.createElement('div');
  root.className = 'tour';
  root.innerHTML = `<div class="tour-block"></div><div class="tour-spot" hidden></div>
    <div class="tour-card" role="dialog" aria-modal="true" aria-live="polite"><div class="tour-arrow"></div>
      <div class="tour-head"><span class="tour-n"></span><button type="button" class="tour-x" data-tour="close" aria-label="${esc(L.close)}">×</button></div>
      <b class="tour-title"></b><p class="tour-text"></p>
      <div class="tour-nav"><button type="button" class="ghost small" data-tour="back">${esc(L.back)}</button><button type="button" class="primary" data-tour="next"></button></div>
    </div>`;
  document.body.appendChild(root);
  const card = root.querySelector('.tour-card'), spot = root.querySelector('.tour-spot'), arrow = root.querySelector('.tour-arrow');
  let i = 0, target = null, token = 0;

  const find = sel => {
    for (const s of [].concat(sel || [])) {
      const el = typeof s === 'function' ? s() : document.querySelector(s);
      if (el && el.getClientRects().length) return el;
    }
    return null;
  };

  function place() {
    const vw = innerWidth, vh = innerHeight, pad = 6, gap = 14;
    card.style.maxWidth = Math.min(340, vw - 24) + 'px';
    const cw = card.offsetWidth, ch = card.offsetHeight;
    // The screen was redrawn under the tour (a sync): point at the new copy of the element.
    if (target && !target.isConnected) target = find(steps[i].el);
    if (!target) {
      spot.hidden = true; arrow.hidden = true;
      card.style.left = Math.max(12, (vw - cw) / 2) + 'px';
      card.style.top = Math.max(12, (vh - ch) / 2) + 'px';
      return;
    }
    const r = target.getBoundingClientRect();
    spot.hidden = false;
    Object.assign(spot.style, { left: r.left - pad + 'px', top: r.top - pad + 'px', width: r.width + pad * 2 + 'px', height: r.height + pad * 2 + 'px' });
    const below = vh - r.bottom >= ch + gap + pad || r.top < ch + gap + pad;
    let top = below ? r.bottom + pad + gap : r.top - pad - gap - ch;
    top = Math.min(Math.max(12, top), vh - ch - 12);
    const left = Math.min(Math.max(12, r.left + r.width / 2 - cw / 2), vw - cw - 12);
    card.style.left = left + 'px'; card.style.top = top + 'px';
    arrow.hidden = false;
    arrow.className = 'tour-arrow ' + (below ? 'up' : 'down');
    arrow.style.left = Math.min(Math.max(16, r.left + r.width / 2 - left - 8), cw - 32) + 'px';
  }

  async function go(n) {
    const my = ++token;
    i = Math.max(0, Math.min(steps.length - 1, n));
    const st = steps[i];
    card.classList.add('busy');
    try { if (st.show) await st.show(); } catch (e) { console.error(e); }
    if (my !== token || !current) return;
    target = find(st.el);
    if (target) {
      target.scrollIntoView({ block: 'center', inline: 'nearest' });
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      if (my !== token || !current) return;
    }
    root.querySelector('.tour-n').textContent = `${i + 1} ${L.of} ${steps.length}`;
    root.querySelector('.tour-title').textContent = st.title || '';
    root.querySelector('.tour-text').innerHTML = esc(st.text || '').replace(/\*([^*]+)\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
    root.querySelector('[data-tour="back"]').hidden = i === 0;
    root.querySelector('[data-tour="next"]').textContent = i === steps.length - 1 ? L.done : L.next;
    card.classList.remove('busy');
    place();
    root.querySelector('[data-tour="next"]').focus({ preventScroll: true });
  }

  function end() {
    if (!current) return;
    current = null; token++;
    removeEventListener('resize', place); removeEventListener('scroll', place, true); removeEventListener('keydown', key, true);
    root.remove();
    onEnd();
  }
  function key(e) {
    if (e.key === 'Escape') { e.preventDefault(); end(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); i === steps.length - 1 ? end() : go(i + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(i - 1); }
  }
  // Every tap stops here: the app underneath never sees it.
  root.addEventListener('click', e => {
    e.stopPropagation();
    const b = e.target.closest('[data-tour]'); if (!b) return;
    const a = b.dataset.tour;
    if (a === 'close') end();
    else if (a === 'back') go(i - 1);
    else if (a === 'next') (i === steps.length - 1 ? end() : go(i + 1));
  });
  addEventListener('resize', place); addEventListener('scroll', place, true); addEventListener('keydown', key, true);
  current = { end };
  go(0);
}

export const endTour = () => current && current.end();
// Is one of these on the screen now? (A guide leaves out the steps about what is not there.)
export const onScreen = sel => [].concat(sel || []).some(x => { const el = typeof x === 'function' ? x() : document.querySelector(x); return !!(el && el.getClientRects().length); });

// The "?" in the header: a small card under it with one button that starts the tour.
let closeMenu = null;
// actions: [{ label, run, primary }] (or start + startLabel for a single button).
export function helpMenu(anchor, { title, text, start, startLabel, closeLabel = 'Close', actions }) {
  actions = actions || [{ label: startLabel, run: start, primary: true }];
  if (closeMenu) { closeMenu(); return; } // the "?" again closes it
  const m = document.createElement('div');
  m.className = 'tour-menu tour-card';
  m.setAttribute('role', 'dialog');
  m.innerHTML = `<div class="tour-arrow up"></div><div class="tour-head"><b class="tour-title">${esc(title)}</b>
      <button type="button" class="tour-x" data-m="close" aria-label="${esc(closeLabel)}">×</button></div>
    <p class="tour-text">${esc(text)}</p>${actions.map((a, k) => `<button type="button" class="${a.primary === false ? 'ghost' : 'primary'} wide tour-act" data-m="${k}">${esc(a.label)}</button>`).join('')}`;
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect(), cw = Math.min(300, innerWidth - 24);
  m.style.maxWidth = cw + 'px';
  const left = Math.min(Math.max(12, r.right - m.offsetWidth), innerWidth - m.offsetWidth - 12);
  m.style.left = left + 'px'; m.style.top = r.bottom + 12 + 'px';
  m.querySelector('.tour-arrow').style.left = Math.min(Math.max(16, r.left + r.width / 2 - left - 8), m.offsetWidth - 32) + 'px';
  const away = e => { if (!m.contains(e.target) && e.target !== anchor) close(); };
  const close = () => { m.remove(); removeEventListener('click', away, true); closeMenu = null; };
  closeMenu = close;
  m.addEventListener('click', e => {
    e.stopPropagation();
    const a = e.target.closest('[data-m]')?.dataset.m;
    if (a === 'close') close();
    if (a !== undefined && a !== 'close' && actions[+a]) { close(); actions[+a].run(); }
  });
  setTimeout(() => addEventListener('click', away, true));
  m.querySelector('[data-m="0"]').focus({ preventScroll: true });
}
