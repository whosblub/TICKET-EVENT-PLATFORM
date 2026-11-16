import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOrderProcessor, createStockReleaser, newTicketCode } from '../src/lib/orders.js';
import { HttpError } from '../src/lib/common.js';

const ORDER = { id: '11111111-1111-4111-8111-111111111111', ticket_type_id: '22222222-2222-4222-8222-222222222222', quantity: 3 };

function setup(responses) {
  const queries = [];
  const requests = [];
  const tokenCalls = [];
  const pool = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [{ ...ORDER, status: 'X' }] }; } };
  const eventPool = { request: async (method, path, opts) => { requests.push({ method, path, opts }); return responses.shift(); } };
  const getServiceToken = async (force) => { tokenCalls.push(!!force); return force ? 'token-baru' : 'token-lama'; };
  return { processOrder: createOrderProcessor({ pool, eventPool, getServiceToken }), queries, requests, tokenCalls };
}

test('reservasi sukses (201) -> RESERVED (bukan CONFIRMED) dengan harga dan batas waktu bayar', async () => {
  const t = setup([{ status: 201, body: { eventId: 'ev-1', unitPrice: 150000 } }]);
  await t.processOrder(ORDER);
  assert.match(t.queries[0].sql, /status='RESERVED'/);
  assert.doesNotMatch(t.queries[0].sql, /status='CONFIRMED'/);
  assert.match(t.queries[0].sql, /status='PENDING'/); // hanya order yang masih PENDING yang boleh diubah
  assert.deepEqual(t.queries[0].params, [ORDER.id, 'ev-1', 150000, 900]);
});

test('reservasi sukses tapi order sudah ditolak permanen -> stok ditandai untuk dikembalikan', async () => {
  const queries = [];
  const pool = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: sql.startsWith('UPDATE orders.orders SET status=\'RESERVED\'') ? [] : [{ ...ORDER, status: 'REJECTED' }] }; } };
  const eventPool = { request: async () => ({ status: 201, body: { eventId: 'e', unitPrice: 10 } }) };
  const processOrder = createOrderProcessor({ pool, eventPool, getServiceToken: async () => 't' });
  const done = await processOrder(ORDER);
  assert.equal(done.status, 'REJECTED');
  assert.match(queries[1].sql, /release_pending=true/);
  assert.match(queries[1].sql, /status IN \('REJECTED','EXPIRED','CANCELLED'\)/); // jangan sentuh RESERVED/CONFIRMED
});

test('stok habis (409) -> REJECTED dengan alasan dari Event Service', async () => {
  const t = setup([{ status: 409, body: { error: { code: 'INSUFFICIENT_STOCK' } } }]);
  await t.processOrder(ORDER);
  assert.match(t.queries[0].sql, /status='REJECTED'/);
  assert.deepEqual(t.queries[0].params, [ORDER.id, 'INSUFFICIENT_STOCK']);
});

test('hasil belum pasti (5xx) -> lempar error agar di-retry, status order TIDAK diubah', async () => {
  for (const status of [500, 502, 503, 429]) {
    const t = setup([{ status, body: {} }]);
    await assert.rejects(t.processOrder(ORDER), (e) => e instanceof HttpError && e.code === 'INVENTORY_UNAVAILABLE');
    assert.equal(t.queries.length, 0);
  }
});

test('token ditolak (401) -> ambil token baru lalu coba sekali lagi', async () => {
  const t = setup([{ status: 401, body: {} }, { status: 201, body: { eventId: 'e', unitPrice: 10 } }]);
  await t.processOrder(ORDER);
  assert.deepEqual(t.tokenCalls, [false, true]);
  assert.equal(t.requests[1].opts.headers.authorization, 'Bearer token-baru');
});

test('releaseStock: 200 -> sukses, memanggil endpoint release milik order tersebut', async () => {
  const requests = [];
  const eventPool = { request: async (method, path, opts) => { requests.push({ method, path, opts }); return { status: 200, body: { orderId: ORDER.id, released: true } }; } };
  const releaseStock = createStockReleaser({ eventPool, getServiceToken: async () => 'tok' });
  const r = await releaseStock(ORDER.id);
  assert.equal(r.released, true);
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].path, `/internal/reservations/${ORDER.id}/release`);
  assert.equal(requests[0].opts.headers.authorization, 'Bearer tok');
});

test('releaseStock: Event Service bermasalah (5xx) -> lempar error agar dicoba lagi, tidak dianggap berhasil', async () => {
  const eventPool = { request: async () => ({ status: 503, body: {} }) };
  const releaseStock = createStockReleaser({ eventPool, getServiceToken: async () => 'tok' });
  await assert.rejects(releaseStock(ORDER.id), (e) => e instanceof HttpError && e.code === 'INVENTORY_UNAVAILABLE');
});

test('kode e-tiket: format TKT-XXXX-XXXX-XXXX, tanpa karakter ambigu, dan tidak berulang', () => {
  const codes = new Set();
  for (let i = 0; i < 2000; i++) {
    const c = newTicketCode();
    assert.match(c, /^TKT-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.doesNotMatch(c.slice(4), /[01OIL]/); // karakter yang mudah tertukar tidak pernah muncul
    codes.add(c);
  }
  assert.equal(codes.size, 2000);
});
