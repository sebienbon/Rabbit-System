import { db } from './db.js';

// The device's view of Entries: the last copy pulled from the sheet, with every
// operation not yet in that copy replayed on top (those already sent, then those
// still waiting). Pure functions here are shared with the tests.

/** yyyyMMddHHmmssSSS in UTC+8, the timestamp format of the old dialogs (script timezone Asia/Singapore). */
export function tsFromMs(ms) {
  return new Date(ms + 8 * 3600000).toISOString().replace(/\D/g, '').slice(0, 17);
}
export const tsFromIso = iso => tsFromMs(new Date(iso).getTime());

/** A new, never-repeating line id (one per sale line, payment or refund). */
export async function nextTs() {
  let last = (await db.get('lastTsMs')) || 0;
  if (last > Date.now() + 60000) last = 0; // the clock was wrong for a while: don't stay stuck in the future
  const ms = Math.max(Date.now(), last + 1);
  await db.set('lastTsMs', ms);
  return tsFromMs(ms);
}

const round = n => Math.round(n);

/**
 * Replays operations on a list of lines. Safe to replay an operation the list
 * already contains (same result), because a pull and a push can overlap.
 */
export function applyOps(lines, ops) {
  const byTs = new Map(lines.map(l => [l.ts, { ...l }]));
  for (const { op, pending } of ops) {
    const p = op.payload || {};
    const mark = l => { if (pending) l.pending = true; return l; };
    if (op.type === 'sale') {
      for (const l of p.lines || []) {
        if (byTs.has(l.ts)) { if (pending) byTs.get(l.ts).pending = true; continue; }
        const total = round(l.qty * l.unit), cost = round(l.qty * (l.unitCost || 0));
        byTs.set(l.ts, mark({ ts: l.ts, type: 'Income', category: l.category || '', object: l.object, qty: l.qty,
          unit: l.unit, total, unitCost: l.unitCost || 0, cost, author: op.author || '', guest: l.guest,
          payment: p.payment, comment: l.comment || '', saleId: p.saleId, soldBy: op.by }));
      }
    } else if (op.type === 'line_update') {
      const l = byTs.get(p.ts);
      if (!l) continue;
      if (p.qty !== undefined) l.qty = p.qty;
      if (p.unit !== undefined) l.unit = p.unit;
      if (p.qty !== undefined || p.unit !== undefined) {
        l.total = round((l.qty || 1) * l.unit);
        if (l.unitCost) l.cost = round((l.qty || 1) * l.unitCost);
      }
      for (const k of ['payment', 'guest', 'comment']) if (p[k] !== undefined) l[k] = p[k];
      mark(l);
    } else if (op.type === 'line_delete') {
      byTs.delete(p.ts);
    } else if (op.type === 'settle') {
      for (const it of p.items || []) {
        const l = byTs.get(it.oldTs);
        if (!l || byTs.has(it.newTs)) continue;
        byTs.delete(it.oldTs);
        byTs.set(it.newTs, mark({ ...l, ts: it.newTs, payment: p.payment, author: op.author || l.author }));
      }
    } else if (op.type === 'refund') {
      const orig = byTs.get(p.origTs);
      if (orig) { orig.comment = 'Refunded'; mark(orig); }
      if (!byTs.has(p.newTs)) {
        byTs.set(p.newTs, mark({ ts: p.newTs, type: 'Expense', category: orig ? orig.category : '', object: orig ? orig.object : '',
          qty: orig ? orig.qty : null, unit: 0, total: 0, unitCost: 0, cost: p.amount, author: op.author || '',
          guest: orig ? orig.guest : '', payment: p.payment, comment: 'Refunding', refundOf: p.origTs }));
      }
    }
  }
  return [...byTs.values()].sort((a, b) => (a.ts < b.ts ? 1 : -1));
}

/** Lines as the device should show them right now. */
export async function ledgerView() {
  const [lines, linesV, applied, outbox] = await Promise.all([db.get('lines'), db.get('linesV'), db.all('applied'), db.all('outbox')]);
  const v = linesV || 0;
  const ops = [
    ...applied.filter(a => a.v > v).sort((a, b) => a.seq - b.seq).map(a => ({ op: a.op, pending: false })),
    ...outbox.sort((a, b) => a.seq - b.seq).map(op => ({ op, pending: true })),
  ];
  return applyOps(lines || [], ops);
}

/** Lines that belong to a shift: recorded between its opening and its closing. */
export function shiftLines(lines, shift) {
  if (!shift) return [];
  const from = tsFromIso(shift.openedAt);
  const to = shift.closedAt ? tsFromIso(shift.closedAt) : '99999999999999999';
  return lines.filter(l => l.ts >= from && l.ts < to);
}

/** Totals per payment type, as the old close-shift dialog computed them. */
export function totals(lines) {
  const income = {}, expense = {};
  for (const l of lines) {
    if (l.type === 'Income') income[l.payment] = (income[l.payment] || 0) + (l.total || 0);
    else if (l.type === 'Expense') expense[l.payment] = (expense[l.payment] || 0) + (l.cost || 0);
  }
  return { income, expense, cashIn: income.Cash || 0, cashOut: expense.Cash || 0 };
}

const REFUND_MARKS = ['Refunded', 'Refunding'];
/**
 * Staff may change only sales they entered themselves during their own open shift
 * (never a refund, never a bill they collected for someone else); managers anything.
 * The sheet applies the same rule.
 */
export function canChange(line, user, shift) {
  if (!user) return false;
  if (user.role !== 'staff') return true;
  return !!shift && shift.status === 'open' && shift.user === user.username && line.type === 'Income' &&
    !REFUND_MARKS.includes(line.comment) && line.soldBy === user.username && line.ts >= tsFromIso(shift.openedAt);
}
export const canRefund = l => l.type === 'Income' && l.payment !== 'Unpaid' && l.comment !== 'Refunded' && !l.pending;
