// Membuat (atau mengubah menjadi) akun admin, mis. akun khusus kelompok penguji yang terpisah dari admin pembangun.
// Pakai:  DATABASE_URL=postgres://... node scripts/create-admin.mjs penguji-admin@example.com 'PasswordKuat123!' [Nama]
// Bila email sudah ada, role diubah menjadi admin dan password diganti.
// Service auth harus pernah berjalan satu kali (tabel auth.users sudah dibuat).
import pg from 'pg';
import bcrypt from 'bcryptjs';

const [email, password, name = 'Admin Penguji'] = process.argv.slice(2);
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL belum diatur'); process.exit(1); }
if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { console.error('Email tidak valid. Pakai: node scripts/create-admin.mjs <email> <password> [nama]'); process.exit(1); }
if (!password || password.length < 8 || password.length > 72) { console.error('Password harus 8-72 karakter'); process.exit(1); }

const client = new pg.Client({ connectionString: url, ssl: /sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined });
await client.connect();
try {
  const hash = await bcrypt.hash(password, 10);
  const r = await client.query(
    `INSERT INTO auth.users(email, name, password_hash, role) VALUES ($1,$2,$3,'admin')
     ON CONFLICT (email) DO UPDATE SET role='admin', password_hash=EXCLUDED.password_hash
     RETURNING id, email, role, (xmax = 0) AS dibuat_baru`,
    [email.trim().toLowerCase(), name, hash],
  );
  console.log(r.rows[0].dibuat_baru ? 'Akun admin dibuat:' : 'Akun sudah ada, diubah menjadi admin dan password diganti:', r.rows[0].email);
} catch (e) {
  console.error('Gagal:', e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
