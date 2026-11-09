// Order Service: menerima pesanan, menyimpannya sebagai PENDING, lalu memasukkannya ke message queue.
// Stok dimiliki Event Service dan diproses oleh Worker (src/worker.js) satu per satu, sehingga lonjakan
// request saat penjualan dibuka tidak langsung menekan Event Service/database dan tiket tidak terjual ganda.
import express from 'express';
import { z } from 'zod';
import { setService, createApp, finishApp, listen, env, envInt, log, wrap, validate, HttpError } from './lib/common.js';
import { createPool, waitForDb } from './lib/db.js';
import { createVerifier, authenticate, requireScopes, requireRole } from './lib/security.js';
import { migrateOrders } from './lib/orders.js';
import { createOrderQueue, enqueueOrder } from './lib/queue.js';
import { createOrderSchema } from './lib/schemas.js';
setService('order-service');

const PORT_DEFAULT = 4002;
const MAX_TICKETS_PER_ORDER = envInt('MAX_TICKETS_PER_ORDER', 4);

const pool = createPool(env('DATABASE_URL'));
await waitForDb(pool);
await migrateOrders(pool);

// Producer: enableOfflineQueue=false agar gagal cepat (bukan menggantung) bila Redis tidak dapat dijangkau.
const queue = createOrderQueue({ enableOfflineQueue: false });

const mapOrder = (r) => ({
  id: r.id, userId: r.user_id, eventId: r.event_id, ticketTypeId: r.ticket_type_id, quantity: r.quantity,
  unitPrice: r.unit_price === null ? null : Number(r.unit_price),
  totalPrice: r.total_price === null ? null : Number(r.total_price),
  status: r.status, reason: r.reason, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
});

const app = createApp('order-service');
const verify = createVerifier({
  jwksUrl: env('AUTH_JWKS_URL', 'http://auth-service:4000/.well-known/jwks.json'),
  issuer: env('AUTH_ISSUER', 'ticketing-auth'),
  audience: env('AUTH_AUDIENCE', 'ticketing-api'),
});
const auth = authenticate(verify);
const userOnly = requireRole('user', 'admin');

app.get('/health', wrap(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok', service: 'order-service' });
}));

const createSchema = createOrderSchema(MAX_TICKETS_PER_ORDER);

/**
 * Asinkron: 202 Accepted + status PENDING. Hasil akhir (CONFIRMED/REJECTED) dibaca lewat GET /orders/{id}.
 * Urutan sengaja: simpan ke database dulu, baru antrikan. Jika langkah antrian gagal, order tetap PENDING
 * dan dipulihkan oleh sweeper Worker, jadi tidak ada pesanan yang hilang.
 */
app.post('/orders', auth, userOnly, requireScopes('orders:write'), express.json({ limit: '10kb' }), wrap(async (req, res) => {
  const body = validate(createSchema, req.body);
  const key = req.get('idempotency-key') ?? null;
  if (key !== null && !/^[\w.:-]{1,64}$/.test(key)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Idempotency-Key harus 1-64 karakter (huruf, angka, . : _ -)');
  }

  const ins = await pool.query(
    `INSERT INTO orders.orders(user_id, ticket_type_id, quantity, idempotency_key) VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING *`,
    [req.user.id, body.ticketTypeId, body.quantity, key],
  );
  if (ins.rowCount === 0) {
    // Permintaan ulang dengan Idempotency-Key yang sama: kembalikan hasil sebelumnya, jangan memesan lagi.
    const prev = (await pool.query('SELECT * FROM orders.orders WHERE user_id=$1 AND idempotency_key=$2', [req.user.id, key])).rows[0];
    if (prev.ticket_type_id !== body.ticketTypeId || prev.quantity !== body.quantity) {
      throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key sudah dipakai untuk pesanan yang berbeda');
    }
    return res.status(200).json(mapOrder(prev));
  }

  const order = ins.rows[0];
  const queued = await enqueueOrder(queue, order.id);
  if (!queued) log('warn', 'order tersimpan PENDING tanpa antrian', { orderId: order.id });
  res.status(202).location(`/orders/${order.id}`).json(mapOrder(order));
}));

app.get('/orders', auth, userOnly, requireScopes('orders:read'), wrap(async (req, res) => {
  const q = validate(z.object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    offset: z.coerce.number().int().min(0).max(100000).default(0),
  }), req.query);
  const rows = (await pool.query('SELECT * FROM orders.orders WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3', [req.user.id, q.limit, q.offset])).rows;
  const total = (await pool.query('SELECT count(*)::int AS n FROM orders.orders WHERE user_id=$1', [req.user.id])).rows[0].n;
  res.json({ data: rows.map(mapOrder), page: { limit: q.limit, offset: q.offset, total } });
}));

app.get('/orders/:id', auth, userOnly, requireScopes('orders:read'), wrap(async (req, res) => {
  const id = validate(z.uuid(), req.params.id);
  const r = (await pool.query('SELECT * FROM orders.orders WHERE id=$1', [id])).rows[0];
  // Bukan pemilik (dan bukan admin) diperlakukan sama seperti tidak ada: mencegah akses ke pesanan orang lain (BOLA/IDOR).
  if (!r || (r.user_id !== req.user.id && req.user.role !== 'admin')) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Pesanan tidak ditemukan');
  res.json(mapOrder(r));
}));

finishApp(app);
const server = listen(app, PORT_DEFAULT);
server.on('close', () => queue.close().catch(() => {}));