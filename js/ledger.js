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
    } else if (op.type === 'expense') {
      if (byTs.has(p.ts)) { if (pending) byTs.get(p.ts).pending = true; continue; }
      byTs.set(p.ts, mark({ ts: p.ts, type: 'Expense', category: '', object: p.object, qty: null, unit: 0, total: 0,
        unitCost: 0, cost: p.amount, author: op.author || '', guest: 'Expense' + p.object, payment: p.payment,
        comment: p.comment || '', soldBy: op.by, label: p.label }));
    } else if (op.type === 'line_update') {
      const l = byTs.get(p.ts);
      if (!l) continue;
      if (p.amount !== undefined) l.cost = p.amount;
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
    } else if (op.type === 'cash_supply') {
      // Cash brought to the desk: an Income line paid Cash and an Expense line paid "Extern Cash".
      const base = { category: 'Other', object: 'Cash Supply', qty: null, unit: 0, unitCost: 0, author: op.author || '',
        guest: 'Cash Supply', comment: '', soldBy: op.by };
      if (!byTs.has(p.ts)) byTs.set(p.ts, mark({ ...base, ts: p.ts, type: 'Income', total: p.amount, cost: 0, payment: 'Cash' }));
      if (!byTs.has(p.ts2)) byTs.set(p.ts2, mark({ ...base, ts: p.ts2, type: 'Expense', total: 0, cost: p.amount, payment: 'Extern Cash' }));
    } else if (op.type === 'partner_bill') {
      for (const it of p.items || []) { const l = byTs.get(it.ts); if (l) { l.cost = it.cost; l.bill = p.bill; mark(l); } }
    } else if (op.type === 'partner_bill_delete') {
      for (const l of byTs.values()) if (l.bill === p.bill) { l.bill = ''; mark(l); }
    } else if (op.type === 'partner_settle') {
      for (const l of byTs.values()) if (l.bill === p.bill) { l.bill = 'Paid'; mark(l); }
      for (const r of p.rows || []) {
        if (!r.net || byTs.has(r.ts)) continue;
        const toPartner = r.net > 0;
        byTs.set(r.ts, mark({ ts: r.ts, type: toPartner ? 'Expense' : 'Income', category: '', object: r.object, qty: null, unit: 0,
          total: toPartner ? 0 : -r.net, unitCost: 0, cost: toPartner ? r.net : 0, author: op.author || '',
          guest: toPartner ? 'Payment to Partner' : 'Payment From Partner', payment: p.payment, comment: p.bill, bill: 'Settled', soldBy: '' }));
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

/** Operations not yet in the last copy pulled from the sheet: those already sent, then those waiting. */
async function newerOps() {
  const [linesV, applied, outbox] = await Promise.all([db.get('linesV'), db.all('applied'), db.all('outbox')]);
  const v = linesV || 0;
  return [
    ...applied.filter(a => a.v > v).sort((a, b) => a.seq - b.seq).map(a => ({ op: a.op, pending: false })),
    ...outbox.sort((a, b) => a.seq - b.seq).map(op => ({ op, pending: true })),
  ];
}

/** Lines as the device should show them right now. */
export async function ledgerView() {
  const [lines, ops] = await Promise.all([db.get('lines'), newerOps()]);
  return applyOps(lines || [], ops);
}

/**
 * Phantom cash rows of Cashouts&Cor (Phantom, Phantom Solved, Phantom Salvation), with
 * phantom and phantom_solve operations replayed on top. A row written through the
 * interface is known by its id (pid) both here and in the sheet.
 */
export function applyCashOps(entries, ops) {
  const byKey = new Map(entries.map(e => [e.key, { ...e }]));
  for (const { op, pending } of ops) {
    const p = op.payload || {};
    if (op.type === 'phantom') {
      if (byKey.has(p.pid)) continue;
      byKey.set(p.pid, { key: p.pid, pid: p.pid, ts: tsFromIso(op.at), diff: p.notGiven ? p.notGiven : -p.notReceived,
        comment: p.comment || '', author: op.author || '', type: 'Phantom', pending, by: op.by });
    } else if (op.type === 'phantom_solve') {
      const orig = byKey.get(p.target);
      if (!orig || orig.type !== 'Phantom' || byKey.has(p.pid)) continue; // solved elsewhere: the sheet will refuse it
      orig.type = 'Phantom Solved';
      if (pending) orig.pending = true;
      byKey.set(p.pid, { key: p.pid, pid: p.pid, ts: tsFromIso(op.at), diff: -orig.diff, comment: orig.comment,
        author: op.author || '', type: 'Phantom Salvation', pending, by: op.by });
    }
  }
  return [...byKey.values()].sort((a, b) => (a.ts < b.ts ? 1 : -1));
}
export async function cashboxView() {
  const [entries, ops] = await Promise.all([db.get('cashbox'), newerOps()]);
  return applyCashOps(entries || [], ops);
}
/**
 * Partner sales not settled yet (snapshot from the sheet), with bill operations replayed:
 * bill = "" not billed, "B_dd/MM-HH:mm" on that bill; settled bills leave the list.
 */
export function applyPartnerOps(snap, ops) {
  const lines = new Map((snap.lines || []).map(l => [l.ts, { ...l }]));
  for (const { op, pending } of ops) {
    const p = op.payload || {};
    if (op.type === 'partner_bill') {
      for (const it of p.items || []) { const l = lines.get(it.ts); if (l && (!l.bill || l.bill === p.bill)) { l.bill = p.bill; l.cost = it.cost; if (pending) l.pending = true; } }
    } else if (op.type === 'partner_bill_delete') {
      for (const l of lines.values()) if (l.bill === p.bill) { l.bill = ''; if (pending) l.pending = true; }
    } else if (op.type === 'partner_settle') {
      for (const [ts, l] of lines) if (l.bill === p.bill) lines.delete(ts);
    } else if (op.type === 'settle') { // a guest paid an Unpaid sale: the line gets a new id
      for (const it of p.items || []) {
        const l = lines.get(it.oldTs);
        if (!l || lines.has(it.newTs)) continue;
        lines.delete(it.oldTs);
        lines.set(it.newTs, { ...l, ts: it.newTs, payment: p.payment });
      }
    } else if (op.type === 'line_delete') {
      lines.delete(p.ts);
    } else if (op.type === 'line_update') {
      const l = lines.get(p.ts);
      if (l && p.payment !== undefined) l.payment = p.payment;
      if (l && p.guest !== undefined) l.guest = p.guest;
    } else if (op.type === 'refund') {
      lines.delete(p.origTs); // a refunded sale no longer goes on a bill
    }
  }
  return { items: snap.items || [], lines: [...lines.values()].sort((a, b) => (a.ts < b.ts ? -1 : 1)) };
}
export async function partnerView() {
  const [snap, ops] = await Promise.all([db.get('partners'), newerOps()]);
  return applyPartnerOps(snap || {}, ops);
}
/** What a line adds to its partner bill: its cost, or cost − price when the guest paid the partner. */
export const billNet = l => Math.round(l.payment === 'Paid to Partner' ? (l.cost || 0) - (l.price || 0) : (l.cost || 0));

/** The last card terminal settlement (its line-id time), including one waiting to be sent. */
export async function lastSettlementView() {
  const [snap, ops] = await Promise.all([db.get('settlement'), newerOps()]);
  let last = snap ? { ts: snap.ts, author: snap.author } : null;
  for (const { op, pending } of ops) if (op.type === 'card_settlement') last = { ts: tsFromIso(op.at).slice(0, 14) + '000', author: op.author, pending };
  return last;
}
/** Card money recorded after a line id: card sales in, card expenses out (as the sheet counts it). */
export const isCard = p => /credit|debit/i.test(String(p || ''));
export function cardLines(lines, afterTs) {
  const after = (afterTs || '0').slice(0, 14); // to the second, like the Settlements time stamps
  return lines.filter(l => l.ts.slice(0, 14) > after && isCard(l.payment) && (l.type === 'Income' || l.type === 'Expense'))
    .sort((a, b) => (a.ts < b.ts ? -1 : 1));
}
export const cardAmount = l => (l.type === 'Income' ? (l.total || 0) : -Math.abs(l.cost || 0));

/** Phantom rows recorded during a shift (the sheet keeps whole seconds for them). */
export function shiftCash(entries, shift) {
  if (!shift) return [];
  const from = tsFromIso(shift.openedAt).slice(0, 14);
  const to = shift.closedAt ? tsFromIso(shift.closedAt).slice(0, 14) : '99999999999999';
  return entries.filter(e => e.ts && e.ts.slice(0, 14) >= from && e.ts.slice(0, 14) <= to);
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
  if (line.object === 'Cash Supply') return false;
  if (line.bill) return false; // on a partner bill (or a payment of one): a manager's job
  return !!shift && shift.status === 'open' && shift.user === user.username && (line.type === 'Income' || line.type === 'Expense') &&
    !REFUND_MARKS.includes(line.comment) && line.soldBy === user.username && line.ts >= tsFromIso(shift.openedAt);
}
export const canRefund = l => l.type === 'Income' && l.object !== 'Cash Supply' && l.payment !== 'Unpaid' && l.comment !== 'Refunded' && !l.pending;
