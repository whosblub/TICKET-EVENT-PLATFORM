import { HttpError } from './common.js';
import { withTx } from './db.js';

/**
 * Menahan stok untuk sebuah order. Idempoten per orderId.
 * Reservasi yang sudah dilepas (RELEASED) tidak bisa dihidupkan lagi oleh retry lama: dijawab 409.
 */
export async function reserve(pool, { orderId, ticketTypeId, quantity }) {
  return withTx(pool, async (c) => {
    const tt = (await c.query(
      `SELECT event_id, price, (SELECT status FROM events.events e WHERE e.id = ticket_types.event_id) AS status,
              (SELECT starts_at FROM events.events e WHERE e.id = ticket_types.event_id) AS starts_at
       FROM events.ticket_types WHERE id=$1`, [ticketTypeId])).rows[0];
    if (!tt) throw new HttpError(404, 'TICKET_TYPE_NOT_FOUND', 'Jenis tiket tidak ditemukan');
    if (tt.status !== 'ON_SALE') throw new HttpError(409, 'EVENT_NOT_ON_SALE', 'Penjualan tiket event ini tidak sedang dibuka');
    if (new Date(tt.starts_at).getTime() <= Date.now()) throw new HttpError(409, 'EVENT_ALREADY_STARTED', 'Event ini sudah dimulai');
    const ins = await c.query(
      'INSERT INTO events.reservations(order_id, ticket_type_id, quantity) VALUES ($1,$2,$3) ON CONFLICT (order_id) DO NOTHING RETURNING order_id',
      [orderId, ticketTypeId, quantity],
    );
    const created = ins.rowCount === 1;
    if (created) {
      const upd = await c.query('UPDATE events.ticket_types SET available = available - $2 WHERE id=$1 AND available >= $2', [ticketTypeId, quantity]);
      if (upd.rowCount === 0) throw new HttpError(409, 'INSUFFICIENT_STOCK', 'Stok tiket tidak mencukupi');
    } else {
      const prev = (await c.query('SELECT status FROM events.reservations WHERE order_id=$1', [orderId])).rows[0];
      if (prev?.status === 'RELEASED') throw new HttpError(409, 'RESERVATION_RELEASED', 'Reservasi order ini sudah dilepas');
    }
    return { created, body: { orderId, eventId: tt.event_id, ticketTypeId, quantity, unitPrice: Number(tt.price) } };
  });
}

/**
 * Mengembalikan stok reservasi yang masih ACTIVE. Idempoten: panggilan kedua (atau untuk order yang
 * tidak punya reservasi) tidak mengubah apa pun dan mengembalikan released:false.
 */
export async function release(pool, orderId) {
  return withTx(pool, async (c) => {
    const r = await c.query(
      `UPDATE events.reservations SET status='RELEASED', released_at=now()
       WHERE order_id=$1 AND status='ACTIVE' RETURNING ticket_type_id, quantity`,
      [orderId],
    );
    if (r.rowCount === 0) return { orderId, released: false };
    const { ticket_type_id: ticketTypeId, quantity } = r.rows[0];
    await c.query('UPDATE events.ticket_types SET available = LEAST(total, available + $2) WHERE id=$1', [ticketTypeId, quantity]);
    return { orderId, released: true };
  });
}