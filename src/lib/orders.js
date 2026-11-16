// Skema tabel order dan logika pemrosesan order. Dipakai Order Service (migrasi) dan Worker (pemrosesan).
//
// Siklus hidup order:
//   PENDING --(stok ditahan)--> RESERVED --(bayar sebelum expires_at)--> CONFIRMED
//   PENDING --(stok habis / event tutup)--> REJECTED
//   RESERVED --(lewat expires_at)--> EXPIRED      (stok dikembalikan)
//   RESERVED --(dibatalkan pembeli)--> CANCELLED  (stok dikembalikan)
// Order Service/Worker adalah SATU-SATUNYA pemilik keputusan "kapan stok dilepas". Event Service hanya
// menjalankan perintah release, supaya tidak ada dua pihak yang saling berebut (mis. stok dilepas padahal sudah dibayar).
import { HttpError, envInt } from './common.js';
import { migrate } from './db.js';

export const ORDER_STATUSES = ['PENDING', 'RESERVED', 'CONFIRMED', 'REJECTED', 'EXPIRED', 'CANCELLED'];
const statusList = ORDER_STATUSES.map((s) => `'${s}'`).join(',');

export async function migrateOrders(pool) {
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
      status text NOT NULL DEFAULT 'PENDING' CONSTRAINT orders_status_check CHECK (status IN (${statusList})),
      reason text,
      idempotency_key text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, idempotency_key)
    )`);
    // Database lama: perluas daftar status yang diizinkan (hanya bila constraint lama belum memuat RESERVED).
    await c.query(`DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'orders_status_check' AND conrelid = 'orders.orders'::regclass
          AND pg_get_constraintdef(oid) LIKE '%RESERVED%'
      ) THEN
        ALTER TABLE orders.orders DROP CONSTRAINT IF EXISTS orders_status_check;
        ALTER TABLE orders.orders ADD CONSTRAINT orders_status_check CHECK (status IN (${statusList}));
      END IF;
    END $$`);
    await c.query(`ALTER TABLE orders.orders ADD COLUMN IF NOT EXISTS expires_at timestamptz`);
    await c.query(`ALTER TABLE orders.orders ADD COLUMN IF NOT EXISTS paid_at timestamptz`);
    // true = stok order ini masih harus dikembalikan ke Event Service (dicoba ulang oleh sweeper sampai berhasil).
    await c.query(`ALTER TABLE orders.orders ADD COLUMN IF NOT EXISTS release_pending boolean NOT NULL DEFAULT false`);
    await c.query(`CREATE INDEX IF NOT EXISTS idx_orders_user ON orders.orders(user_id, created_at DESC)`);
    await c.query(`CREATE INDEX IF NOT EXISTS idx_orders_pending ON orders.orders(updated_at) WHERE status = 'PENDING'`);
    await c.query(`CREATE INDEX IF NOT EXISTS idx_orders_reserved_expiry ON orders.orders(expires_at) WHERE status = 'RESERVED'`);
    await c.query(`CREATE INDEX IF NOT EXISTS idx_orders_release_pending ON orders.orders(updated_at) WHERE release_pending`);
  });
}

/** Pemanggil endpoint internal Event Service dengan token layanan (otomatis ambil token baru bila ditolak 401). */
function createInventoryCaller({ eventPool, getServiceToken }) {
  return async function callInventory(path, body) {
    const doCall = async (token) =>
      eventPool.request('POST', path, { json: body, headers: { authorization: `Bearer ${token}` } });
    let r = await doCall(await getServiceToken());
    if (r.status === 401) r = await doCall(await getServiceToken(true)); // token kedaluwarsa/rotasi kunci
    return r;
  };
}

/**
 * Pemroses order: reservasi stok ke Event Service lalu tetapkan status.
 * Idempoten: reservasi memakai order.id sebagai kunci, jadi aman dipanggil ulang (retry Worker).
 * Melempar HttpError 503 INVENTORY_UNAVAILABLE bila hasil belum pasti -> job di-retry oleh antrian.
 * Reservasi berhasil -> RESERVED (stok ditahan sampai expires_at). CONFIRMED baru terjadi setelah dibayar.
 */
export function createOrderProcessor({ pool, eventPool, getServiceToken }) {
  const callInventory = createInventoryCaller({ eventPool, getServiceToken });
  const ttlSeconds = () => envInt('RESERVATION_TTL_SECONDS', 900);

  return async function processOrder(order) {
    const r = await callInventory('/internal/reservations', {
      orderId: order.id, ticketTypeId: order.ticket_type_id, quantity: order.quantity,
    });
    if (r.status === 200 || r.status === 201) {
      const price = Number(r.body.unitPrice);
      const upd = await pool.query(
        `UPDATE orders.orders SET status='RESERVED', event_id=$2, unit_price=$3::numeric, total_price=$3::numeric * quantity,
           reason=NULL, expires_at=now() + make_interval(secs => $4), updated_at=now()
         WHERE id=$1 AND status='PENDING' RETURNING *`,
        [order.id, r.body.eventId, price, ttlSeconds()],
      );
      if (upd.rows[0]) return upd.rows[0];
      // Order sudah berpindah status saat reservasi selesai. Bila statusnya sudah final-tanpa-stok (ditolak/expired/batal),
      // stok yang baru ditahan harus dikembalikan. Bila RESERVED/CONFIRMED (job ganda yang sama-sama sukses), jangan disentuh.
      await pool.query(`UPDATE orders.orders SET release_pending=true WHERE id=$1 AND status IN ('REJECTED','EXPIRED','CANCELLED')`, [order.id]);
      return (await pool.query('SELECT * FROM orders.orders WHERE id=$1', [order.id])).rows[0];
    }
    if (r.status === 404 || r.status === 409) {
      const reason = r.body?.error?.code ?? 'REJECTED';
      return (await pool.query(`UPDATE orders.orders SET status='REJECTED', reason=$2, updated_at=now() WHERE id=$1 AND status='PENDING' RETURNING *`, [order.id, reason])).rows[0]
        ?? (await pool.query('SELECT * FROM orders.orders WHERE id=$1', [order.id])).rows[0];
    }
    throw new HttpError(503, 'INVENTORY_UNAVAILABLE', 'Layanan stok tidak tersedia');
  };
}

/**
 * Mengembalikan stok sebuah order ke Event Service. Idempoten (aman dipanggil berkali-kali).
 * Melempar 503 bila Event Service belum bisa memastikan, supaya pemanggil mencoba lagi nanti.
 */
export function createStockReleaser({ eventPool, getServiceToken }) {
  const callInventory = createInventoryCaller({ eventPool, getServiceToken });
  return async function releaseStock(orderId) {
    const r = await callInventory(`/internal/reservations/${orderId}/release`, {});
    if (r.status === 200) return r.body;
    throw new HttpError(503, 'INVENTORY_UNAVAILABLE', 'Stok belum dapat dikembalikan');
  };
}