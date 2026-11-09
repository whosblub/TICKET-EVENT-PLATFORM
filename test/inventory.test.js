import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reserve } from '../src/lib/inventory.js';

const TT = '22222222-2222-4222-8222-222222222222';
const EV = 'a0000000-0000-4000-8000-000000000001';

// Database palsu yang meniru semantik PostgreSQL (transaksi, ROLLBACK, ON CONFLICT, UPDATE bersyarat)
function fakeDb(stock) {
  const state = { tickets: { [TT]: { event_id: EV, price: 150000, available: stock } }, reservations: new Map(), log: [] };
  return {
    state,
    async connect() {
      let undo = [];
      return {
        release() { state.log.push('release'); },
        async query(sql, p = []) {
          sql = sql.trim();
          if (sql === 'BEGIN') { undo = []; state.log.push('BEGIN'); return {}; }
          if (sql === 'COMMIT') { undo = []; state.log.push('COMMIT'); return {}; }
          if (sql === 'ROLLBACK') { for (const f of undo.reverse()) f(); undo = []; state.log.push('ROLLBACK'); return {}; }
          await Promise.resolve();
          if (sql.startsWith('SELECT event_id, price')) { const t = state.tickets[p[0]]; return { rows: t ? [{ event_id: t.event_id, price: t.price }] : [] }; }
          if (sql.startsWith('INSERT INTO events.reservations')) {
            if (state.reservations.has(p[0])) return { rowCount: 0, rows: [] };
            state.reservations.set(p[0], { ticketTypeId: p[1], quantity: p[2] });
            undo.push(() => state.reservations.delete(p[0]));
            return { rowCount: 1, rows: [{ order_id: p[0] }] };
          }
          if (sql.startsWith('UPDATE events.ticket_types')) {
            const t = state.tickets[p[0]];
            if (t && t.available >= p[1]) { t.available -= p[1]; undo.push(() => { t.available += p[1]; }); return { rowCount: 1 }; }
            return { rowCount: 0 };
          }
          throw new Error(`SQL tak dikenal: ${sql}`);
        },
      };
    },
  };
}
const order = (n, qty = 1) => ({ orderId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, ticketTypeId: TT, quantity: qty });

test('reservasi berhasil: stok berkurang dan respons memuat harga serta eventId', async () => {
  const db = fakeDb(10);
  const r = await reserve(db, order(1, 2));
  assert.equal(r.created, true);
  assert.deepEqual(r.body, { orderId: order(1).orderId, eventId: EV, ticketTypeId: TT, quantity: 2, unitPrice: 150000 });
  assert.equal(db.state.tickets[TT].available, 8);
});

test('jenis tiket tidak ada -> 404', async () => {
  const db = fakeDb(10);
  await assert.rejects(reserve(db, { ...order(1), ticketTypeId: '99999999-9999-4999-8999-999999999999' }), (e) => e.status === 404);
});

test('stok tidak cukup -> 409 dan transaksi di-ROLLBACK', async () => {
  const db = fakeDb(1);
  await assert.rejects(reserve(db, order(1, 2)), (e) => e.status === 409 && e.code === 'INSUFFICIENT_STOCK');
  assert.equal(db.state.tickets[TT].available, 1);
  assert.deepEqual(db.state.log, ['BEGIN', 'ROLLBACK', 'release']);
});

test('order yang ditolak lalu dicoba lagi TIDAK dianggap sudah berhasil', async () => {
  const db = fakeDb(0);
  await assert.rejects(reserve(db, order(1)), (e) => e.code === 'INSUFFICIENT_STOCK');
  assert.equal(db.state.reservations.size, 0);
  await assert.rejects(reserve(db, order(1)), (e) => e.code === 'INSUFFICIENT_STOCK');
});

test('idempoten: order yang sama dikirim ulang -> stok tidak berkurang lagi', async () => {
  const db = fakeDb(10);
  const first = await reserve(db, order(1, 3));
  const again = await reserve(db, order(1, 3));
  assert.equal(first.created, true);
  assert.equal(again.created, false);
  assert.equal(db.state.tickets[TT].available, 7);
});

test('30 pembelian bersamaan untuk stok 10 -> tepat 10 berhasil, 20 ditolak', async () => {
  const db = fakeDb(10);
  const results = await Promise.allSettled(Array.from({ length: 30 }, (_, i) => reserve(db, order(i + 1))));
  assert.equal(results.filter((r) => r.status === 'fulfilled' && r.value.created).length, 10);
  assert.equal(results.filter((r) => r.status === 'rejected' && r.reason.code === 'INSUFFICIENT_STOCK').length, 20);
  assert.equal(db.state.tickets[TT].available, 0);
  assert.equal(db.state.reservations.size, 10);
});