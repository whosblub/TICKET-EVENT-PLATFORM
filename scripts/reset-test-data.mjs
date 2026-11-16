// Mengembalikan data uji ke kondisi awal: stok semua jenis tiket = total, semua pesanan dan reservasi dihapus.
// Opsi --purge-events juga menghapus event buatan penguji (selain 5 event seed).
// Akun pengguna TIDAK disentuh.
//
// Pakai:  DATABASE_URL=postgres://... node scripts/reset-test-data.mjs --yes [--purge-events]
// Railway: ambil connection string PUBLIK Postgres (bukan alamat internal) dari Railway Dashboard.
// HANYA untuk lingkungan uji. Tanpa --yes, skrip hanya menampilkan apa yang akan dilakukan.
import pg from 'pg';

const SEED_EVENT_IDS = [1, 2, 3, 4, 5].map((n) => `a0000000-0000-4000-8000-00000000000${n}`);
const yes = process.argv.includes('--yes');
const purge = process.argv.includes('--purge-events');
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL belum diatur'); process.exit(1); }

const host = (() => { try { return new URL(url).host; } catch { return '(tidak terbaca)'; } })();
console.log(`Target database: ${host}`);
console.log('Akan: hapus semua pesanan + reservasi, kembalikan stok semua tiket ke total' + (purge ? ', hapus event non-seed' : ''));
if (!yes) { console.log('\nDry run. Tambahkan --yes untuk benar-benar menjalankan.'); process.exit(0); }

const client = new pg.Client({ connectionString: url, ssl: /sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined });
await client.connect();
try {
  await client.query('BEGIN');
  const o = await client.query('DELETE FROM orders.orders');
  const r = await client.query('DELETE FROM events.reservations');
  let purged = 0;
  if (purge) purged = (await client.query('DELETE FROM events.events WHERE id <> ALL($1::uuid[])', [SEED_EVENT_IDS])).rowCount;
  const s = await client.query('UPDATE events.ticket_types SET available = total WHERE available <> total');
  await client.query('COMMIT');
  console.log(`Selesai: pesanan dihapus=${o.rowCount}, reservasi dihapus=${r.rowCount}, event non-seed dihapus=${purged}, stok dipulihkan=${s.rowCount} jenis tiket`);
  const t = await client.query(`SELECT e.name, t.name AS tiket, t.available, t.total FROM events.ticket_types t JOIN events.events e ON e.id=t.event_id WHERE e.id = ANY($1::uuid[]) ORDER BY e.starts_at, t.price`, [SEED_EVENT_IDS]);
  console.table(t.rows);
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('Gagal, tidak ada yang diubah:', e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
