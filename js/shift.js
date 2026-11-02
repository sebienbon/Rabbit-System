import { db } from './db.js';
import { enqueue } from './sync.js';
import { ledgerView, shiftLines, totals, cashboxView, shiftCash } from './ledger.js';

// Local view of shifts. The computer is the source of truth while offline;
// the server re-checks every operation when it arrives.

export const money = n => new Intl.NumberFormat('id-ID').format(Math.round(n || 0));
export const parseMoney = s => {
  const digits = String(s ?? '').replace(/[^\d]/g, '');
  return digits === '' ? null : Number(digits);
};

async function allShifts() {
  return (await db.all('shifts')).sort((a, b) => a.openedAt.localeCompare(b.openedAt));
}

export async function currentShift() {
  const list = await allShifts();
  return list.filter(s => s.status === 'open').pop() || null;
}

/** Cash that should be in the box right now, before counting. */
export async function cashInBoxBeforeOpening() {
  const [outbox, server, list] = await Promise.all([db.all('outbox'), db.get('serverShift'), allShifts()]);
  const pendingClose = outbox.filter(o => o.type === 'shift_close').pop();
  if (pendingClose) return pendingClose.payload.cashCounted;
  if (server && !server.open && typeof server.lastCashInBox === 'number') return server.lastCashInBox;
  const lastClosed = list.filter(s => s.status === 'closed').pop();
  return lastClosed ? lastClosed.closingCash : 0;
}

/** Cash taken and paid out during the shift (lines recorded in it), and phantom cash. */
export async function cashMovements(shift) {
  const [lines, box] = await Promise.all([ledgerView(), cashboxView()]);
  const t = totals(shiftLines(lines, shift));
  const phantom = shiftCash(box, shift).reduce((s, e) => s + (e.diff || 0), 0);
  return { cashIn: t.cashIn, cashOut: t.cashOut, phantom };
}

export async function expectedCash(shift) {
  const m = await cashMovements(shift);
  return shift.openingCash + m.cashIn - m.cashOut + m.phantom;
}

export async function openShift(user, cashCounted, comment) {
  if (await currentShift()) throw new Error('A shift is already open.');
  const reference = await cashInBoxBeforeOpening();
  const id = 'S' + new Date().toISOString().replace(/\D/g, '').slice(0, 14) + '-' + crypto.randomUUID().slice(0, 4);
  const shift = {
    id, user: user.username, userName: user.name, openedAt: new Date().toISOString(),
    openingCash: cashCounted, openingReference: reference, openingDifference: cashCounted - reference,
    status: 'open', comment: comment || '',
  };
  await db.put('shifts', shift);
  await enqueue('shift_open', { shiftId: id, cashCounted, comment: comment || '' });
  return shift;
}

export function canClose(user, shift) {
  return !!shift && (shift.user === user.username || user.role !== 'staff');
}

export async function closeShift(user, shift, { cashCounted, cashout, comment }) {
  if (!canClose(user, shift)) throw new Error('Only the person who opened the shift or a manager can close it.');
  const expected = await expectedCash(shift);
  const difference = cashCounted + cashout - expected;
  const closed = {
    ...shift, status: 'closed', closedAt: new Date().toISOString(), closedBy: user.username,
    closingCash: cashCounted, cashout, expectedCash: expected, difference,
    comment: [shift.comment, comment].filter(Boolean).join(' | '),
  };
  await db.put('shifts', closed);
  await enqueue('shift_close', { shiftId: shift.id, cashCounted, cashout, expectedCash: expected, comment: comment || '' });
  return closed;
}

/**
 * After talking to the server. The server's word wins for every shift that has
 * nothing still waiting to be sent from this computer:
 *  - opening refused  -> the local shift is void
 *  - server says Closed -> closed here too (e.g. a manager closed it elsewhere)
 *  - server says Open  -> open here too (adopted, or a refused close is undone)
 */
export async function reconcile() {
  const [server, rejected, list, outbox] = await Promise.all([db.get('serverShift'), db.all('rejected'), allShifts(), db.all('outbox')]);
  if (!server) return;
  const waiting = new Set(outbox.map(o => o.payload && o.payload.shiftId));
  const recent = server.recent || {};
  const refusedOpen = new Set(rejected.filter(r => r.type === 'shift_open').map(r => r.payload.shiftId));
  for (const s of list) {
    if (waiting.has(s.id)) continue;
    if (refusedOpen.has(s.id) && !(server.open && server.id === s.id) && s.status !== 'void') {
      await db.put('shifts', { ...s, status: 'void' });
    } else if (recent[s.id] === 'Closed' && s.status === 'open') {
      await db.put('shifts', { ...s, status: 'closed', closedElsewhere: true, closedAt: new Date().toISOString() });
    } else if (server.open && server.id === s.id && s.status !== 'open') {
      await db.put('shifts', { ...s, status: 'open', reopened: true });
    }
  }
  if (server.open && !waiting.has(server.id) && !list.some(s => s.id === server.id)) {
    await db.put('shifts', {
      id: server.id, user: server.user, userName: server.user, openedAt: server.openedAt,
      openingCash: server.openingCash, status: 'open', comment: '', adopted: true,
    });
  }
}
