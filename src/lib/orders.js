// Skema tabel order dan logika pemrosesan order. Dipakai Order Service (migrasi) dan Worker (pemrosesan).
import { HttpError } from './common.js';
import { migrate } from './db.js';

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
      status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','CONFIRMED','REJECTED')),
      reason text,
      idempotency_key text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, idempotency_key)
    )`);
    await c.query(`CREATE INDEX IF NOT EXISTS idx_orders_user ON orders.orders(user_id, created_at DESC)`);
    await c.query(`CREATE INDEX IF NOT EXISTS idx_orders_pending ON orders.orders(updated_at) WHERE status = 'PENDING'`);
  });
}

/**
 * Pemroses order: reservasi stok ke Event Service lalu tetapkan status akhir.
 * Idempoten: reservasi memakai order.id sebagai kunci, jadi aman dipanggil ulang (retry Worker).
 * Melempar HttpError 503 INVENTORY_UNAVAILABLE bila hasil belum pasti -> job di-retry oleh antrian.
 */
export function createOrderProcessor({ pool, eventPool, getServiceToken }) {
  async function callInventory(path, body) {
    const doCall = async (token) =>
      eventPool.request('POST', path, { json: body, headers: { authorization: `Bearer ${token}` } });
    let r = await doCall(await getServiceToken());
    if (r.status === 401) r = await doCall(await getServiceToken(true)); // token kedaluwarsa/rotasi kunci
    return r;
  }

  return async function processOrder(order) {
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
  };
}
