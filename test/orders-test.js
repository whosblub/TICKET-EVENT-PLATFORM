import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOrderProcessor } from '../src/lib/orders.js';
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

test('reservasi sukses (201) -> CONFIRMED dengan harga dari Event Service', async () => {
  const t = setup([{ status: 201, body: { eventId: 'ev-1', unitPrice: 150000 } }]);
  await t.processOrder(ORDER);
  assert.match(t.queries[0].sql, /status='CONFIRMED'/);
  assert.deepEqual(t.queries[0].params, [ORDER.id, 'ev-1', 150000]);
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