// Gear (snorkeling masks & bikes): the state the desk sees, rebuilt from the last copy pulled
// from the sheet with the operations not yet in it replayed on top. Shared by the reception
// tab, the Sell screen and the gear staff app.
import { db, localKey } from './db.js';
import { newerOps } from './ledger.js';

const H = 3600000, DAY = 24 * H, TZ = 8 * H; // reception time is UTC+8

/** Start of the reception day (UTC+8) of a time, in ms. */
export const dayStart = ms => Math.floor((ms + TZ) / DAY) * DAY - TZ;
/** 24 h rental: out before noon → next day 12:00; from noon → next day 18:00 (plus extra days). */
export function backBefore(fromMs, days = 1) {
  const hour = new Date(fromMs + TZ).getUTCHours();
  return dayStart(fromMs) + Math.max(1, days) * DAY + (hour < 12 ? 12 : 18) * H;
}
export const sunsetBack = fromMs => dayStart(fromMs) + 21.5 * H;
/** Past its return time (information only: being overdue is not charged by itself). */
export const isOverdue = (backIso, nowMs = Date.now()) => !!backIso && nowMs > Date.parse(backIso);
/**
 * Billable extension days: the evening checks (at most one per reception day) done after
 * the return time `back` and up to `untilMs`, while the item was still out. A guest who
 * brings it back at 20:00 before the check pays nothing. Same rule as the sheet (lateDays_).
 * A check is an instant (ISO or ms) or { at, seen: [numbers found in the box] }: a check
 * that found `itemId` in the box does not count.
 */
export function extensionDays(backIso, countTimes, untilMs = Date.now(), itemId = null) {
  if (!backIso) return 0;
  const b = Date.parse(backIso), days = new Set();
  for (const t of countTimes || []) {
    const obj = t && typeof t === 'object';
    if (obj && itemId && (t.seen || []).includes(itemId)) continue;
    const ms = typeof t === 'number' ? t : Date.parse(obj ? t.at : t);
    if (ms > b && ms <= untilMs) days.add(dayStart(ms));
  }
  return days.size;
}
/**
 * Extension days of a rental out now (or, with `untilMs`, of one found back at that time).
 * Uses what the sheet worked out (`g.counts`, or the item's `lateDays`), plus the evening
 * checks this device has not sent yet.
 */
export function daysLate(it, g, untilMs = Date.now()) {
  if (!it || it.where !== 'out' || !it.back || (it.last && it.last.kind && it.last.kind !== 'rental')) return 0;
  const local = (g && g.localCounts) || [];
  if (g && Array.isArray(g.counts)) return extensionDays(it.back, [...g.counts, ...local], untilMs, it.id);
  if (typeof it.lateDays === 'number') {
    // Checks already in the copy are in lateDays; add the local ones of a later day.
    const known = g && g.sheetLastCount ? dayStart(Date.parse(g.sheetLastCount.at)) : -Infinity;
    const extra = local.filter(t => dayStart(Date.parse(t.at)) > known);
    return it.lateDays + extensionDays(it.back, extra, untilMs, it.id);
  }
  return extensionDays(it.back, local, untilMs, it.id);
}
export const fmtWhen = iso => {
  if (!iso) return '';
  const d = new Date(Date.parse(iso) + TZ);
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
  return `${wd} ${d.getUTCDate()}/${d.getUTCMonth() + 1} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};
export const lastUseText = last => !last ? 'never used' :
  last.kind === 'sunset' ? `Sunset Boat ${fmtWhen(last.from).split(' ').slice(0, 2).join(' ')}` :
  `${last.kind === 'volunteer' ? 'Volunteer' : 'rental'}, ${last.guest}, ${fmtWhen(last.from)}${last.returned ? ' → ' + fmtWhen(last.returned) : ''}`;

/** Product names compare without case or spaces (same rule as nameKey_ in the sheet). */
export const sameName = (a, b) => {
  const k = v => String(v ?? '').replace(/^'/, '').replace(/\s+/g, ' ').trim().toLowerCase();
  return k(a) === k(b);
};

export function applyGearOps(snap, ops, side = 'reception') {
  const g = JSON.parse(JSON.stringify(snap || { items: [], diffs: [], damages: [], trips: [] }));
  const items = new Map((g.items || []).map(i => [i.id, i]));
  const diffs = new Map((g.diffs || []).map(d => [d.id, d]));
  const damages = new Map((g.damages || []).map(d => [d.id, d]));
  const at = op => Date.parse(op.at);
  // A number given up as lost stays out of service (not back in stock).
  const ret = (it, cond, when) => { it.where = cond === 'Lost' ? 'lost' : 'in'; it.back = null; it.condition = cond || 'OK'; if (it.last) it.last.returned = when; };
  // A damage noticed off the boat or at the evening check (the sheet's 'damage' event).
  const damageSeen = (it, cond, did, guest) => {
    if (!it || !cond || cond === 'OK' || cond === it.condition) return;
    it.condition = cond;
    if (cond === 'Lost') { it.where = 'lost'; it.back = null; }
    mark(it);
    if (!damages.has(did)) damages.set(did, { id: did, item: it.id, condition: cond, guest, decision: 'pending', pending: true });
  };
  let mark = () => {};
  const productOf = it => (g.product ? (it.kind === 'mask' ? g.product.mask : g.product.bike) : null);
  g.sheetLastCount = g.lastCount || null; // the last check the copy knows
  g.localCounts = [];                     // checks done on this device, not yet in the copy
  for (const { op, pending } of ops) {
    const p = op.payload || {};
    mark = x => { if (pending && x) x.pending = true; };
    if (op.type === 'sale') {
      // The sale and its money always go through; the gear follows when it can.
      const used = new Set();
      for (const l of p.lines || []) {
        if (!l.gear) continue;
        const id = String(l.gear).trim().toUpperCase(), it = items.get(id);
        const product = it && productOf(it);
        if (!it || used.has(id) || (product && l.object && !sameName(l.object, product)) || it.where === 'lost' || (it.condition && it.condition !== 'OK')) {
          // Unknown, out of service or not this product: not linked, both sides check it.
          const did = 'G' + l.ts + '-u';
          if (!diffs.has(did) && ![...diffs.values()].some(d => d.kind === 'sale_unlinked' && d.item === id && String(d.count || '').includes(String(l.ts)))) {
            diffs.set(did, { id: did, item: id, kind: 'sale_unlinked', at: op.at, last: it ? it.last : null, reception: false, gear: false, pending: !!pending });
          }
          continue;
        }
        used.add(id);
        // Already out (rental, Volunteer, Sunset Boat): back first, no extension for the previous guest.
        if (it.where === 'out' || it.where === 'sunset') ret(it, it.condition, op.at);
        it.where = 'out'; it.back = new Date(backBefore(at(op), Math.max(1, Math.round(l.qty || 1)))).toISOString();
        it.last = { kind: 'rental', guest: l.guest, from: op.at, saleTs: l.ts }; mark(it);
      }
    } else if (op.type === 'settle') {
      // A later payment gives the sale line a new id: the rental follows it.
      for (const x of p.items || []) {
        for (const it of items.values()) if (it.last && it.last.kind === 'rental' && String(it.last.saleTs) === String(x.oldTs)) it.last.saleTs = x.newTs;
      }
    } else if (op.type === 'line_update' || op.type === 'line_delete') {
      // A corrected or deleted rental line: its number follows (days = quantity, guest).
      const it = [...items.values()].find(i => i.where === 'out' && i.last && i.last.kind === 'rental' && String(i.last.saleTs) === String(p.ts));
      if (!it) continue;
      if (op.type === 'line_delete') { ret(it, it.condition, op.at); mark(it); continue; }
      if (p.qty !== undefined) it.back = new Date(backBefore(Date.parse(it.last.from), Math.max(1, Math.round(Number(p.qty) || 1)))).toISOString();
      if (p.guest) it.last.guest = p.guest;
      mark(it);
    } else if (op.type === 'gear_out') {
      for (const id of p.items || []) {
        // Same as the sheet: out of service (broken, lost) does not leave.
        const it = items.get(id); if (!it || it.where !== 'in' || (it.condition && it.condition !== 'OK')) continue;
        it.where = 'out'; it.back = new Date(backBefore(at(op), p.days || 1)).toISOString();
        it.last = { kind: 'volunteer', guest: p.guest || 'Volunteer', from: op.at }; mark(it);
      }
    } else if (op.type === 'gear_return') {
      for (const x of p.items || []) {
        const it = items.get(x.item); if (!it || (it.where !== 'out' && it.where !== 'sunset')) continue;
        ret(it, x.condition, op.at); mark(it);
        const did = 'D' + p.gid + '-' + x.item; // same id as the sheet gives it
        if (x.condition && x.condition !== 'OK') damages.set(did, { id: did, item: x.item, condition: x.condition, guest: it.last ? it.last.guest : '', decision: 'pending', pending: true });
      }
    } else if (op.type === 'gear_confirm') {
      const d = diffs.get(p.diff); if (!d) continue;
      const it = items.get(d.item);
      if (side === 'reception' && d.kind === 'counted_but_out' && p.action !== 'mistake' && it && (it.where === 'out' || it.where === 'sunset')) ret(it, it.condition, op.at);
      if (d.kind === 'sunset_missing' && p.action === 'found' && it && it.where === 'sunset') ret(it, it.condition, op.at);
      d[side] = true; mark(d);
      if (d.gear && d.reception) diffs.delete(d.id);
    } else if (op.type === 'gear_lost') {
      const d = diffs.get(p.diff); if (!d) continue;
      diffs.delete(d.id);
      const it = items.get(d.item); if (it) { it.where = 'lost'; it.condition = 'Lost'; mark(it); }
      damages.set('D' + p.lid, { id: 'D' + p.lid, item: d.item, condition: 'Lost', guest: d.last ? d.last.guest : '', decision: 'pending', pending: true });
    } else if (op.type === 'gear_decide') {
      const dm = damages.get(p.damage); if (dm) { dm.decision = p.decision; mark(dm); }
    } else if (op.type === 'sunset_out') {
      g.trips = g.trips || [];
      // Numbers already out stay with their rental (a difference for the sheet); none left: no trip.
      // The gear phone does not know where numbers are (blind check): it keeps them all.
      const go = (p.items || []).filter(id => { const it = items.get(id); return it && (it.where === undefined || it.where === 'in'); });
      if (go.length && !g.trips.some(t => t.trip === p.trip)) g.trips.push({ trip: p.trip, at: op.at, by: op.by, items: go, back: [], closed: false, pending: !!pending });
      for (const id of go) { const it = items.get(id); if (it.where === 'in') { it.where = 'sunset'; it.last = { kind: 'sunset', guest: 'Sunset Boat', from: op.at }; mark(it); } }
    } else if (op.type === 'sunset_back') {
      const t = (g.trips || []).find(x => x.trip === p.trip); if (!t) continue;
      t.back = [...(p.items || [])]; t.closed = true; mark(t);
      for (const id of t.back) { const it = items.get(id); if (it && it.where === 'sunset') { ret(it, it.condition, op.at); mark(it); } }
      // Damage seen off the boat (Lost: out of service), as the sheet records it.
      const cond = p.conditions && typeof p.conditions === 'object' ? p.conditions : {};
      for (const id of t.back) damageSeen(items.get(id), cond[id], 'D' + p.trip + '-' + id, 'Sunset Boat');
    } else if (op.type === 'gear_count') {
      g.countedToday = true; g.lastCount = { at: op.at, by: op.by, pending: !!pending, n: (p.items || []).length };
      g.localCounts.push({ at: op.at, seen: (p.items || []).map(x => String(x && x.item || '').toUpperCase()) });
      for (const x of p.items || []) { const it = items.get(String(x && x.item || '').toUpperCase()); if (it) damageSeen(it, x.condition, 'D' + p.cid + '-' + it.id, it.last ? it.last.guest : ''); }
      if (Array.isArray(g.broken)) for (const x of p.items || []) {
        const id = String(x && x.item || '').toUpperCase();
        if (x && x.condition && x.condition !== 'OK' && !g.broken.some(b => b.id === id)) g.broken.push({ id, condition: x.condition, note: x.note || '', pending: !!pending });
      }
    } else if (op.type === 'gear_condition') {
      // Status set by hand: OK = repaired (as gear_service), else out of service, nothing to charge.
      const it = items.get(p.item);
      if (Array.isArray(g.broken)) { // the gear app: its list of what is out of service
        g.broken = g.broken.filter(b => b.id !== p.item);
        if (p.condition && p.condition !== 'OK') g.broken.push({ id: p.item, condition: p.condition, note: p.note || '', pending: !!pending });
      }
      if (it && (it.where === undefined || it.where === 'in')) {
        if (p.condition === 'OK') { it.condition = 'OK'; mark(it); for (const [k, dm] of damages) if (dm.item === p.item) { if (dm.decision !== 'pending') damages.delete(k); else dm.serviced = true; } }
        else if (p.condition && p.condition !== it.condition) {
          it.condition = p.condition; mark(it);
          const did = 'D' + p.uid + '-' + it.id;
          if (!damages.has(did)) damages.set(did, { id: did, item: it.id, condition: p.condition, note: p.note || '', guest: '', from: 'status', decision: 'nocharge', pending: true });
        }
      }
    } else if (op.type === 'gear_service') {
      const it = items.get(p.item); if (it) { it.condition = 'OK'; if (it.where === 'lost') it.where = 'in'; mark(it); }
      for (const [k, dm] of damages) if (dm.item === p.item) { if (dm.decision !== 'pending') damages.delete(k); else dm.serviced = true; }
    }
  }
  g.items = [...items.values()];
  g.diffs = [...diffs.values()];
  g.damages = [...damages.values()].filter(d => d.decision === 'pending' || (!d.serviced && (items.get(d.item) || {}).condition !== 'OK'));
  // A trip whose masks all came back another way (desk return, found) is over.
  for (const t of g.trips || []) if (!t.closed && side === 'reception' && !t.items.some(id => (items.get(id) || {}).where === 'sunset')) { t.closed = true; t.back = [...t.items]; }
  return g;
}
export async function gearView(side = 'reception') {
  const [snap, ops] = await Promise.all([db.get('gear'), newerOps()]);
  if (!snap) return null;
  const g = applyGearOps(snap, ops, side);
  // Worked out here, so a copy pulled yesterday does not say "checked today".
  g.countedToday = !!(g.lastCount && dayStart(Date.parse(g.lastCount.at)) === dayStart(Date.now()));
  g.trips = (g.trips || []).filter(t => !t.closed || dayStart(Date.parse(t.at)) === dayStart(Date.now()));
  return g;
}
/** Today's evening check is due from 20:00 (reception time) until one is recorded. */
export function checkDue(g, nowMs = Date.now()) {
  return !!g && !g.countedToday && new Date(nowMs + TZ).getUTCHours() >= 20;
}
/**
 * One notification per day and key, when the person allowed them. Shown by the service
 * worker (phones refuse `new Notification`); marked as done only once it was shown.
 */
const shown = new Set(); // keys being shown now (no double while the first is on its way)
export async function notifyOnce(key, title, body, url = './') {
  try {
    if (!('Notification' in globalThis) || Notification.permission !== 'granted') return false;
    const day = new Date(Date.now() + TZ).toISOString().slice(0, 10);
    const k = localKey('notified:' + key);
    if (localStorage.getItem(k) === day || shown.has(k)) return false;
    shown.add(k);
    try {
      const opts = { body, icon: 'icon-192.png', tag: key, data: { url } };
      const sw = 'serviceWorker' in navigator && await Promise.race([navigator.serviceWorker.ready, new Promise(r => setTimeout(() => r(null), 3000))]);
      if (sw) await sw.showNotification(title, opts);
      else new Notification(title, opts); // no service worker (desktop only)
      localStorage.setItem(k, day);
      return true;
    } finally { shown.delete(k); }
  } catch { return false; /* notifications unavailable: tried again next time */ }
}
