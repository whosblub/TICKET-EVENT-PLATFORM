# Platform Tiket Event/Konser (Kelompok B)

Sistem tiket berbasis microservices untuk proyek lintas mata kuliah Web Service x Software Testing.
Status: **progress sampai minggu 10** (keamanan OAuth2, API Gateway, service discovery, load balancing).
Message queue + worker dikerjakan di minggu 11.

## Arsitektur

```
                        +-----------------+
 Pengguna --HTTPS-->    |   API Gateway   |  cek token OAuth2, rate limiting (Redis),
                        |  (port 8080)    |  routing, load balancing, blokir /internal
                        +--------+--------+
          +----------------------+-----------------------+
          v                      v                       v
  +---------------+     +------------------+     +------------------+
  | Auth Service  |     |  Event Service   |<----|  Order Service   |
  | OAuth2, JWKS  |     | REST + GraphQL   |     | pemesanan tiket  |
  | (1 instance)  |     | pemilik stok     |     | (2 replika)      |
  +-------+-------+     | (2 replika)      |     +---------+--------+
          |             +--------+---------+               |
          v                      v                         v
   +------------------------ PostgreSQL ------------------------+
   |  schema auth        schema events         schema orders     |
   +-------------------------------------------------------------+
   Redis: penyimpanan hitungan rate limit gateway
   Minggu 11: Order Service -> Message Queue -> Worker -> Event Service (reservasi stok)
```

| Service | Port | Tugas |
|---|---|---|
| gateway | 8080 | Satu-satunya pintu masuk publik. Verifikasi JWT, rate limit, routing, load balancing |
| auth-service | 4000 | Authorization Server OAuth2 (password dan client credentials), JWKS, registrasi |
| event-service | 4001 | Katalog event (REST dan GraphQL), pemilik stok tiket, endpoint reservasi internal |
| order-service | 4002 | Pemesanan, idempotensi, riwayat pesanan |

Semua service memakai satu codebase dan satu image Docker; service dipilih lewat perintah start (`node src/<service>.js`).

## Menjalankan dengan Docker

Prasyarat: Docker Desktop (Compose v2).

```bash
docker compose up --build        # gateway di http://localhost:8080
docker compose ps                # event-service dan order-service masing-masing 2 replika
docker compose down -v           # hentikan dan hapus data
```

Tanpa file `.env`, nilai default pengembangan dipakai (lihat `.env.example`). **Ganti semua secret sebelum deployment.**

Smoke test end-to-end (butuh Node 20+ di mesin host):

```bash
node scripts/smoke.mjs                       # melawan http://localhost:8080
BASE_URL=https://url-deploy node scripts/smoke.mjs
```

Tanpa Docker (pengembangan): jalankan Postgres dan Redis sendiri, isi variabel dari `.env.example`, lalu `npm ci` dan jalankan `node src/auth-service.js`, `event-service.js`, `order-service.js`, `gateway.js` (masing-masing proses terpisah, `PORT` berbeda, `DISCOVERY=static`).

## Cara autentikasi

Akun admin awal dibuat dari `ADMIN_EMAIL` dan `ADMIN_PASSWORD`. Pengguna biasa mendaftar sendiri.

```bash
# 1. Daftar
curl -X POST localhost:8080/auth/register -H 'content-type: application/json' \
  -d '{"email":"budi@example.com","password":"Password123!","name":"Budi"}'

# 2. Minta token (OAuth2 password grant, client publik "ticketing-web")
curl -X POST localhost:8080/oauth/token \
  -d grant_type=password -d client_id=ticketing-web \
  -d username=budi@example.com -d password='Password123!'
# -> {"access_token":"eyJ...","token_type":"Bearer","expires_in":900,"scope":"events:read orders:read orders:write"}

# 3. Pakai token
TOKEN=eyJ...
curl localhost:8080/events?city=Jakarta -H "authorization: Bearer $TOKEN"

# 4. Pesan tiket (Idempotency-Key opsional tetapi disarankan)
curl -X POST localhost:8080/orders -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -H 'Idempotency-Key: pesanan-001' \
  -d '{"ticketTypeId":"<id dari /events>","quantity":2}'

# 5. GraphQL
curl -X POST localhost:8080/graphql -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"query":"{ events(limit:3){ items{ name startsAt minPrice } } }"}'
```

Token berumur 15 menit (`ACCESS_TOKEN_TTL_SECONDS`), ditandatangani RS256. Kunci publik ada di `GET /.well-known/jwks.json`.

| Role | Scope |
|---|---|
| user | `events:read`, `orders:read`, `orders:write` |
| admin | semua scope user + `events:write` |
| service (order-service) | `inventory:write`, `inventory:read` (hanya untuk panggilan internal) |

## Daftar endpoint

Spesifikasi lengkap: [`docs/openapi.yaml`](docs/openapi.yaml). Skema GraphQL beserta contoh query/mutation: [`docs/schema.graphql`](docs/schema.graphql).

| Metode | Path | Akses | Keterangan |
|---|---|---|---|
| GET | `/health` | publik | Status gateway (minimal, tanpa detail internal) |
| POST | `/auth/register` | publik | Daftar akun |
| POST | `/oauth/token` | publik | Minta token (OAuth2) |
| GET | `/.well-known/jwks.json` | publik | Kunci publik JWT |
| GET | `/auth/me` | token | Identitas dari token |
| GET | `/admin/upstreams` | admin | Daftar replika upstream dan kesehatannya (bukti service discovery) |
| GET | `/events` | `events:read` | Daftar event (filter `q`, `city`, `category`, `status`, `onlyAvailable`, `limit`, `offset`) |
| GET | `/events/{id}` | `events:read` | Detail event dan jenis tiket |
| POST | `/events` | admin, `events:write` | Buat event |
| POST | `/graphql` | `events:read` | Katalog via GraphQL; mutation `createEvent` khusus admin |
| POST | `/orders` | `orders:write` | Pesan tiket |
| GET | `/orders` | `orders:read` | Daftar pesanan sendiri |
| GET | `/orders/{id}` | `orders:read` | Detail pesanan (pemilik atau admin) |

Endpoint `/internal/*` (reservasi stok) sengaja tidak dapat dijangkau lewat gateway (404) dan hanya menerima token `client_credentials`.

Format error seragam: `{"error":{"code":"...","message":"...","details":[...],"requestId":"..."}}`. Error pada `/oauth/token` mengikuti RFC 6749 (`error`, `error_description`).

Batas yang berlaku (default, dapat diubah lewat env; respons `429` selalu disertai header `Retry-After`): global 300/menit per IP; `/oauth/token` 20 percobaan **gagal** per 5 menit per IP; `/auth/register` 20 per 5 menit per IP; `/events` 120/menit per pengguna; `/graphql` 60/menit per pengguna; `POST /orders` 10/menit per pengguna; `GET /orders` 60/menit per pengguna. Maksimum 4 tiket per pesanan; GraphQL kedalaman maksimum 5 dan field maksimum 100 (alias dihitung); `limit` halaman maksimum 50; body maksimum 100 KB di gateway.

## Data awal untuk pengujian

Event Service mengisi 5 event contoh saat pertama kali jalan, termasuk **"Konser Uji Beban (stok terbatas)"** dengan stok 10 tiket untuk menguji pemesanan bersamaan. Penguji dapat membuat event baru lewat akun admin (`POST /events`) untuk skenario lain.

## Daftar environment variable

Lengkap dengan placeholder di [`.env.example`](.env.example). Variabel wajib per service:

| Service | Wajib |
|---|---|
| gateway | `AUTH_JWKS_URL`, `AUTH_SERVICE_URLS`, `EVENT_SERVICE_URLS`, `ORDER_SERVICE_URLS`, `DISCOVERY`; opsional `REDIS_URL`, `TRUST_PROXY`, `CORS_ORIGINS`, `RATE_LIMIT_*` |
| auth-service | `DATABASE_URL`, `ORDER_SERVICE_CLIENT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`; opsional `JWT_PRIVATE_JWK_B64`, `ACCESS_TOKEN_TTL_SECONDS` |
| event-service | `DATABASE_URL`, `AUTH_JWKS_URL` |
| order-service | `DATABASE_URL`, `AUTH_JWKS_URL`, `AUTH_SERVICE_URLS`, `EVENT_SERVICE_URLS`, `ORDER_SERVICE_CLIENT_SECRET` |

Semua service: `ENFORCE_SECRETS=true` membuat service menolak start jika secret kosong, terlalu pendek, atau masih default. **Wajib aktif pada deployment publik.** Buat kunci JWT dengan `npm run gen:jwk`.

## Deployment (Render + Neon + Upstash)

1. Neon: buat database Postgres, salin connection string ke `DATABASE_URL` (tabel dibuat otomatis saat service pertama kali start).
2. Upstash (atau Redis lain): salin URL `rediss://...` ke `REDIS_URL` gateway.
3. Render: buat 4 Web Service dari repo yang sama (build `npm install`, start `node src/<service>.js`). Isi `DISCOVERY=static` dan URL publik antarlayanan (mis. `EVENT_SERVICE_URLS=https://event-service-xxxx.onrender.com`). Isi `TRUST_PROXY=1` pada gateway, `ENFORCE_SECRETS=true` di semua service, dan `JWT_PRIVATE_JWK_B64` (hasil `npm run gen:jwk`) di auth-service. Ganti `ADMIN_PASSWORD` dan `ORDER_SERVICE_CLIENT_SECRET`.
4. Hanya URL gateway yang diberikan kepada kelompok penguji.

## Keamanan (ringkasan untuk laporan 4.4)

- OAuth2: password grant untuk pengguna (client publik), client credentials untuk antarlayanan. JWT RS256, `iss`, `aud`, `exp` diverifikasi; kunci diambil dari JWKS.
- Zero trust antarlayanan: gateway memeriksa token, dan setiap service memeriksanya lagi. Header identitas dari klien tidak dipercaya.
- Least privilege: scope per role; endpoint `/internal` hanya untuk role `service` berscope `inventory:write` dan diblokir di gateway.
- Rate limiting berlapis (IP global, percobaan login gagal per IP, pengguna untuk events/GraphQL/order) dengan Redis agar konsisten antar replika. Jika Redis mati, gateway fail-open demi ketersediaan.
- `/health` publik minimal; detail replika hanya di `/admin/upstreams` (admin). `ENFORCE_SECRETS=true` mencegah secret default dipakai di produksi.
- Grant `password` dipakai untuk client publik demi kesederhanaan tugas; OAuth 2.1 sudah menghapusnya (produksi: Authorization Code + PKCE). Dibahas di laporan 4.4.
- Password di-hash bcrypt; login tidak membocorkan keberadaan akun (pesan sama, waktu konstan).
- Otorisasi tingkat objek: pesanan hanya dapat dibaca pemilik atau admin (pengguna lain mendapat 404).
- Validasi input dengan zod di semua endpoint; query SQL berparameter; error 500 tidak membocorkan detail internal.
- GraphQL: batas kedalaman dan jumlah field, batas ukuran halaman, error tak terduga disamarkan. Introspeksi sengaja dibiarkan aktif agar penguji dapat membaca skema.
- Secret hanya dari environment variable; tidak ada secret di repository.
- Integritas stok: pengurangan atomik `UPDATE ... WHERE available >= qty` dan reservasi berkunci `order_id` (idempoten) sehingga tidak terjadi oversell walau permintaan bersamaan atau diproses ulang.

## Service discovery dan load balancing (minggu 10)

Gateway dan Order Service memakai `UpstreamPool` (`src/lib/upstream.js`): di Docker Compose nama service di-resolve lewat DNS ke semua alamat replika (`DISCOVERY=dns`), disegarkan tiap 5 detik, dipantau lewat `GET /health`, lalu request dibagi round-robin hanya ke replika sehat. Jika koneksi ke satu replika gagal, request idempoten otomatis dicoba ke replika lain. Header respons `X-Instance-Id` menunjukkan replika yang melayani, berguna untuk membuktikan load balancing saat pengujian. `GET /admin/upstreams` (admin) menampilkan replika yang ditemukan beserta status sehatnya.

## Struktur proyek

```
src/gateway.js  src/auth-service.js  src/event-service.js  src/order-service.js
src/lib/        common.js (app, error, log)  db.js  security.js (JWT, scope)  upstream.js (discovery, LB)
docs/           openapi.yaml  schema.graphql  keamanan-dan-protokol.md (bahan laporan 4.3 dan 4.4)
scripts/        smoke.mjs  gen-jwk.mjs
Dockerfile  docker-compose.yml  .env.example  .dockerignore
```

## Rencana berikutnya

- Minggu 11: `POST /orders` menjadi asinkron (`202` + `PENDING`), publish ke message queue, Worker memanggil reservasi stok (sudah idempoten), retry dan dead-letter queue. Fungsi `processOrder` di `order-service.js` sudah dipisahkan untuk disambungkan ke Worker.
- Minggu 12: code freeze, finalisasi dokumentasi dan URL deployment.
