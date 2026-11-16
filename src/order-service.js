// Order Service: menerima pesanan, menyimpannya sebagai PENDING, lalu memasukkannya ke message queue.
// Worker menahan stok (RESERVED, berbatas waktu); pembeli harus membayar sebelum expires_at agar menjadi CONFIRMED,
// atau membatalkan. Pesanan yang tidak dibayar kedaluwarsa (EXPIRED) dan stoknya dikembalikan oleh Worker.
// Stok dimiliki Event Service dan diproses oleh Worker (src/worker.js) satu per satu, sehingga lonjakan
// request saat penjualan dibuka tidak langsung menekan Event Service/database dan tiket tidak terjual ganda.
import express from 'express';
import { z } from 'zod';
import { setService, createApp, finishApp, listen, env, envInt, log, wrap, validate, HttpError } from './lib/common.js';
import { createPool, waitForDb } from './lib/db.js';
import { createVerifier, authenticate, requireScopes, requireRole } from './lib/security.js';
import { migrateOrders, newTicketCode } from './lib/orders.js';
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
  status: r.status, reason: r.reason,
  expiresAt: r.expires_at ? r.expires_at.toISOString() : null,
  paidAt: r.paid_at ? r.paid_at.toISOString() : null,
  createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
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

/** Pesanan milik user yang sedang login. Bukan pemilik diperlakukan sama seperti tidak ada (anti BOLA/IDOR); admin tidak ikut membayar/membatalkan. */
async function findOwnedOrder(id, userId) {
  const r = (await pool.query('SELECT * FROM orders.orders WHERE id=$1 AND user_id=$2', [id, userId])).rows[0];
  if (!r) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Pesanan tidak ditemukan');
  return r;
}

/**
 * Pembayaran (SIMULASI): menandai pesanan RESERVED menjadi CONFIRMED selama belum lewat expires_at.
 * Satu UPDATE bersyarat sehingga aman terhadap balapan dengan sweeper kedaluwarsa dan klik ganda.
 * Pada sistem sungguhan, endpoint ini diganti webhook penyedia pembayaran yang diverifikasi tanda tangannya.
 */
app.post('/orders/:id/pay', auth, userOnly, requireScopes('orders:write'), wrap(async (req, res) => {
  const id = validate(z.uuid(), req.params.id);
  const upd = await pool.query(
    `UPDATE orders.orders SET status='CONFIRMED', paid_at=now(), updated_at=now(), ticket_code=COALESCE(ticket_code, $3)
     WHERE id=$1 AND user_id=$2 AND status='RESERVED' AND expires_at > now() RETURNING *`,
    [id, req.user.id, newTicketCode()],
  );
  if (upd.rows[0]) return res.status(200).json(mapOrder(upd.rows[0]));
  const o = await findOwnedOrder(id, req.user.id);
  if (o.status === 'CONFIRMED') return res.status(200).json(mapOrder(o)); // idempoten: sudah dibayar
  if (o.status === 'RESERVED' || o.status === 'EXPIRED') throw new HttpError(409, 'ORDER_EXPIRED', 'Batas waktu pembayaran sudah lewat');
  throw new HttpError(409, 'ORDER_NOT_PAYABLE', `Pesanan berstatus ${o.status} dan tidak dapat dibayar`);
}));

/**
 * E-tiket: kode tiket (untuk ditampilkan sebagai teks dan QR) dari pesanan CONFIRMED milik pembeli.
 * Kode berlaku sebagai kredensial masuk, jadi hanya pemilik yang dapat membacanya (admin tidak ikut, pesanan orang lain 404).
 * Kode dibuat saat pembayaran; pesanan CONFIRMED lama yang belum punya kode diberi kode di sini (satu UPDATE bersyarat).
 */
app.get('/orders/:id/ticket', auth, userOnly, requireScopes('orders:read'), wrap(async (req, res) => {
  const id = validate(z.uuid(), req.params.id);
  let o = await findOwnedOrder(id, req.user.id);
  if (o.status !== 'CONFIRMED') throw new HttpError(409, 'ORDER_NOT_PAID', `E-tiket hanya tersedia untuk pesanan yang sudah dibayar (status saat ini ${o.status})`);
  if (!o.ticket_code) {
    await pool.query(`UPDATE orders.orders SET ticket_code=$2 WHERE id=$1 AND status='CONFIRMED' AND ticket_code IS NULL`, [id, newTicketCode()]);
    o = await findOwnedOrder(id, req.user.id);
  }
  res.set('Cache-Control', 'no-store').json({
    orderId: o.id, ticketCode: o.ticket_code, status: o.status, quantity: o.quantity,
    eventId: o.event_id, ticketTypeId: o.ticket_type_id,
    issuedAt: (o.paid_at ?? o.updated_at).toISOString(),
  });
}));

/**
 * Pembatalan oleh pembeli: hanya untuk pesanan RESERVED (belum dibayar). Stok dikembalikan oleh Worker
 * (release_pending) dalam satu siklus sweeper. Pesanan CONFIRMED tidak dapat dibatalkan karena refund belum tersedia.
 */
app.post('/orders/:id/cancel', auth, userOnly, requireScopes('orders:write'), wrap(async (req, res) => {
  const id = validate(z.uuid(), req.params.id);
  const upd = await pool.query(
    `UPDATE orders.orders SET status='CANCELLED', release_pending=true, updated_at=now()
     WHERE id=$1 AND user_id=$2 AND status='RESERVED' RETURNING *`,
    [id, req.user.id],
  );
  if (upd.rows[0]) return res.status(200).json(mapOrder(upd.rows[0]));
  const o = await findOwnedOrder(id, req.user.id);
  if (o.status === 'CANCELLED') return res.status(200).json(mapOrder(o)); // idempoten
  throw new HttpError(409, 'ORDER_NOT_CANCELLABLE', `Pesanan berstatus ${o.status} dan tidak dapat dibatalkan`);
}));

finishApp(app);
const server = listen(app, PORT_DEFAULT);
server.on('close', () => queue.close().catch(() => {}));