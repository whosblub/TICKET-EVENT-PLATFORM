import { HttpError } from './common.js';
import { withTx } from './db.js';

export async function reserve(pool, { orderId, ticketTypeId, quantity }) {
  return withTx(pool, async (c) => {
    const tt = (await c.query('SELECT event_id, price FROM events.ticket_types WHERE id=$1', [ticketTypeId])).rows[0];
    if (!tt) throw new HttpError(404, 'TICKET_TYPE_NOT_FOUND', 'Jenis tiket tidak ditemukan');
    const ins = await c.query(
      'INSERT INTO events.reservations(order_id, ticket_type_id, quantity) VALUES ($1,$2,$3) ON CONFLICT (order_id) DO NOTHING RETURNING order_id',
      [orderId, ticketTypeId, quantity],
    );
    const created = ins.rowCount === 1;
    if (created) {
      const upd = await c.query('UPDATE events.ticket_types SET available = available - $2 WHERE id=$1 AND available >= $2', [ticketTypeId, quantity]);
      if (upd.rowCount === 0) throw new HttpError(409, 'INSUFFICIENT_STOCK', 'Stok tiket tidak mencukupi');
    }
    return { created, body: { orderId, eventId: tt.event_id, ticketTypeId, quantity, unitPrice: Number(tt.price) } };
  });
}