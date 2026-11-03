// Gear (snorkeling masks & bikes): the state the desk sees, rebuilt from the last copy pulled
// from the sheet with the operations not yet in it replayed on top. Shared by the reception
// tab, the Sell screen and the gear staff app.
import { db } from './db.js';
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
/** Whole days late (started), 0 if on time. */
export const daysLate = (backIso, nowMs = Date.now()) => (backIso && nowMs > Date.parse(backIso) ? Math.ceil((nowMs - Date.parse(backIso)) / DAY) : 0);
export const fmtWhen = iso => {
  if (!iso) return '';
  const d = new Date(Date.parse(iso) + TZ);
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
  return `${wd} ${d.getUTCDate()}/${d.getUTCMonth() + 1} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};
export const lastUseText = last => !last ? 'never used' :
  last.kind === 'sunset' ? `Sunset Boat ${fmtWhen(last.from).split(' ').slice(0, 2).join(' ')}` :
  `${last.kind === 'volunteer' ? 'Volunteer' : 'rental'}, ${last.guest}, ${fmtWhen(last.from)}${last.returned ? ' → ' + fmtWhen(last.returned) : ''}`;

export function applyGearOps(snap, ops, side = 'reception') {
  const g = JSON.parse(JSON.stringify(snap || { items: [], diffs: [], damages: [], trips: [] }));
  const items = new Map((g.items || []).map(i => [i.id, i]));
  const diffs = new Map((g.diffs || []).map(d => [d.id, d]));
  const damages = new Map((g.damages || []).map(d => [d.id, d]));
  const at = op => Date.parse(op.at);
  const ret = (it, cond, when) => { it.where = 'in'; it.back = null; it.condition = cond || 'OK'; if (it.last) it.last.returned = when; };
  for (const { op, pending } of ops) {
    const p = op.payload || {};
    const mark = x => { if (pending && x) x.pending = true; };
    if (op.type === 'sale') {
      for (const l of p.lines || []) {
        const it = l.gear && items.get(l.gear);
        if (!it) continue; // the sheet makes a difference if it was elsewhere; the rental wins
        it.where = 'out'; it.back = new Date(backBefore(at(op), Math.max(1, Math.round(l.qty || 1)))).toISOString();
        it.last = { kind: 'rental', guest: l.guest, from: op.at, saleTs: l.ts }; mark(it);
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
        const it = items.get(id); if (!it || it.where !== 'in') continue;
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
      if (side === 'reception' && d.kind === 'counted_but_out' && it && (it.where === 'out' || it.where === 'sunset')) ret(it, it.condition, op.at);
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
      if (!g.trips.some(t => t.trip === p.trip)) g.trips.push({ trip: p.trip, at: op.at, by: op.by, items: [...(p.items || [])], back: [], closed: false, pending: !!pending });
      for (const id of p.items || []) { const it = items.get(id); if (it && it.where === 'in') { it.where = 'sunset'; it.last = { kind: 'sunset', guest: 'Sunset Boat', from: op.at }; mark(it); } }
    } else if (op.type === 'sunset_back') {
      const t = (g.trips || []).find(x => x.trip === p.trip); if (!t) continue;
      t.back = [...(p.items || [])]; t.closed = true; mark(t);
      for (const id of t.back) { const it = items.get(id); if (it && it.where === 'sunset') { ret(it, it.condition, op.at); mark(it); } }
    } else if (op.type === 'gear_count') {
      g.countedToday = true; g.lastCount = { at: op.at, by: op.by, pending: !!pending, n: (p.items || []).length };
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
/** One browser notification per day, when the person allowed them. */
export function notifyOnce(key, title, body) {
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const day = new Date(Date.now() + TZ).toISOString().slice(0, 10);
    if (localStorage.getItem('notified:' + key) === day) return;
    localStorage.setItem('notified:' + key, day);
    new Notification(title, { body, icon: 'icon-192.png' });
  } catch { /* notifications unavailable */ }
}
