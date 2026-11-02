// Order Service: pemesanan tiket. Stok dimiliki Event Service; Order Service memanggilnya
// dengan token OAuth2 Client Credentials. Minggu 11: pemrosesan dipindah ke message queue + worker.
import express from 'express';
import { z } from 'zod';
import { setService, createApp, finishApp, listen, env, envInt, envList, log, wrap, validate, HttpError, assertSecrets } from './lib/common.js';
import { createPool, waitForDb, migrate } from './lib/db.js';
import { createVerifier, authenticate, requireScopes, requireRole, createServiceTokenProvider } from './lib/security.js';
import { UpstreamPool } from './lib/upstream.js';
setService('order-service');

const PORT_DEFAULT = 4002;
const MAX_TICKETS_PER_ORDER = envInt('MAX_TICKETS_PER_ORDER', 4);
const DISCOVERY = env('DISCOVERY', 'static');

assertSecrets({ ORDER_SERVICE_CLIENT_SECRET: env('ORDER_SERVICE_CLIENT_SECRET') });

const pool = createPool(env('DATABASE_URL'));
await waitForDb(pool);
await migrate(pool, 7003, async (c) => {
  await c.query(`CREATE SCHEMA IF NOT EXISTS orders`);
  await c.query(`CREATE TABLE IF NOT EXISTS orders.orders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id text NOT NULL,
    event_id uuid,
    ticket_type_id uuid NOT NULL,
    quantity int NOT NULL CHECK (quantity > 0),
    unit_price numeric(12,2),
    total_price numeric(12,2),
    status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','CONFIRMED','REJECTED')),
    reason text,
    idempotency_key text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, idempotency_key)
  )`);
  await c.query(`CREATE INDEX IF NOT EXISTS idx_orders_user ON orders.orders(user_id, created_at DESC)`);
});

const eventPool = await new UpstreamPool('event-service', envList('EVENT_SERVICE_URLS', ['http://event-service:4001']), { discovery: DISCOVERY }).start();
const authPool = await new UpstreamPool('auth-service', envList('AUTH_SERVICE_URLS', ['http://auth-service:4000']), { discovery: DISCOVERY }).start();
const getServiceToken = createServiceTokenProvider({
  authPool,
  clientId: 'order-service',
  clientSecret: env('ORDER_SERVICE_CLIENT_SECRET', ''),
  scope: 'inventory:write',
});

const mapOrder = (r) => ({
  id: r.id, userId: r.user_id, eventId: r.event_id, ticketTypeId: r.ticket_type_id, quantity: r.quantity,
  unitPrice: r.unit_price === null ? null : Number(r.unit_price),
  totalPrice: r.total_price === null ? null : Number(r.total_price),
  status: r.status, reason: r.reason, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
});

async function callInventory(path, body) {
  const doCall = async (token) =>
    eventPool.request('POST', path, { json: body, headers: { authorization: `Bearer ${token}` } });
  let r = await doCall(await getServiceToken());
  if (r.status === 401) r = await doCall(await getServiceToken(true)); // token kedaluwarsa/rotasi kunci
  return r;
}

/**
 * Memproses satu order: reservasi stok lalu tetapkan status akhir.
 * Dipisahkan sebagai fungsi sendiri agar minggu 11 dapat dipanggil oleh Worker dari message queue.
 * Aman dipanggil ulang (idempoten) karena reservasi memakai order.id sebagai kunci.
 */
async function processOrder(order) {
  const r = await callInventory('/internal/reservations', {
    orderId: order.id, ticketTypeId: order.ticket_type_id, quantity: order.quantity,
  });
  if (r.status === 200 || r.status === 201) {
    const price = Number(r.body.unitPrice);
    return (await pool.query(
      `UPDATE orders.orders SET status='CONFIRMED', event_id=$2, unit_price=$3::numeric, total_price=$3::numeric * quantity, reason=NULL, updated_at=now()
       WHERE id=$1 RETURNING *`,
      [order.id, r.body.eventId, price],
    )).rows[0];
  }
  if (r.status === 404 || r.status === 409) {
    const reason = r.body?.error?.code ?? 'REJECTED';
    return (await pool.query(`UPDATE orders.orders SET status='REJECTED', reason=$2, updated_at=now() WHERE id=$1 RETURNING *`, [order.id, reason])).rows[0];
  }
  throw new HttpError(503, 'INVENTORY_UNAVAILABLE', 'Layanan stok tidak tersedia');
}

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

const createSchema = z.object({
  ticketTypeId: z.uuid(),
  quantity: z.number().int().min(1).max(MAX_TICKETS_PER_ORDER),
});

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

  let order;
  try {
    order = await processOrder(ins.rows[0]);
  } catch (e) {
    if (e instanceof HttpError && e.code === 'INVENTORY_UNAVAILABLE') {
      // Hasil belum pasti: order tetap PENDING agar bisa diproses ulang (Worker, minggu 11).
      log('warn', 'order tetap PENDING', { orderId: ins.rows[0].id });
      return res.status(202).location(`/orders/${ins.rows[0].id}`).json(mapOrder(ins.rows[0]));
    }
    throw e;
  }
  if (order.status === 'REJECTED') {
    const status = order.reason === 'TICKET_TYPE_NOT_FOUND' ? 404 : 409;
    throw new HttpError(status, order.reason, order.reason === 'INSUFFICIENT_STOCK' ? 'Stok tiket tidak mencukupi' : 'Pesanan ditolak', { orderId: order.id });
  }
  res.status(201).location(`/orders/${order.id}`).json(mapOrder(order));
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
listen(app, PORT_DEFAULT);
