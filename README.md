# Platform Tiket Event/Konser (Kelompok B)

Sistem tiket berbasis microservices untuk proyek lintas mata kuliah **Web Service x Software Testing**.

Status: **progress sampai minggu 10** (keamanan OAuth2, API Gateway, service discovery, load balancing).
Message queue + worker dikerjakan di minggu 11.

## Daftar isi

1. [Arsitektur](#arsitektur)
2. [Teknologi](#teknologi)
3. [Menjalankan dengan Docker](#menjalankan-dengan-docker)
4. [Cara autentikasi](#cara-autentikasi)
5. [Daftar endpoint](#daftar-endpoint)
6. [Data awal untuk pengujian](#data-awal-untuk-pengujian)
7. [Memeriksa database](#memeriksa-database)
8. [Daftar environment variable](#daftar-environment-variable)
9. [Deployment](#deployment-render--neon--upstash)
10. [Keamanan](#keamanan-ringkasan-untuk-laporan-44)
11. [Service discovery dan load balancing](#service-discovery-dan-load-balancing-minggu-10)
12. [Pemecahan masalah](#pemecahan-masalah)
13. [Struktur proyek](#struktur-proyek)
14. [Rencana berikutnya](#rencana-berikutnya)

## Arsitektur

![Diagram arsitektur](docs/arsitektur.png)

*Versi vektor: [`docs/arsitektur.svg`](docs/arsitektur.svg). Garis putus-putus adalah rencana minggu 11.*

| Service | Port | Instance | Tugas |
|---|---|---|---|
| gateway | 8080 | 1 | Satu-satunya pintu masuk publik. Verifikasi JWT, rate limit, routing, load balancing, blokir `/internal` |
| auth-service | 4000 | 1 | Authorization Server OAuth2 (password dan client credentials), JWKS, registrasi |
| event-service | 4001 | 2 replika | Katalog event (REST dan GraphQL), pemilik stok tiket, endpoint reservasi internal |
| order-service | 4002 | 2 replika | Pemesanan, idempotensi, riwayat pesanan |
| postgres | 5432 | 1 | Database (schema `auth`, `events`, `orders`), tidak dibuka ke luar |
| redis | 6379 | 1 | Penyimpanan hitungan rate limit gateway, tidak dibuka ke luar |

Semua service memakai satu codebase dan satu image Docker; service dipilih lewat perintah start (`node src/<service>.js`).

### Alur pemesanan tiket (kondisi minggu 10)

```mermaid
sequenceDiagram
    participant K as Klien
    participant G as Gateway
    participant O as Order Service
    participant E as Event Service
    participant D as PostgreSQL
    K->>G: POST /orders (Bearer token, Idempotency-Key)
    G->>G: Verifikasi JWT, cek rate limit
    G->>O: Teruskan ke replika sehat (round-robin)
    O->>O: Verifikasi ulang token, validasi input
    O->>E: POST /internal/... (token client credentials)
    E->>D: UPDATE stok WHERE available >= qty (atomik)
    E-->>O: Reservasi berhasil / stok habis
    O->>D: Simpan pesanan
    O-->>K: 201 Created / 409 stok habis
```

Pada minggu 11, langkah Order -> Event diganti: Order Service mengirim pesan ke message queue, membalas `202 PENDING`, dan Worker yang memanggil reservasi stok.

## Teknologi

| Komponen | Teknologi |
|---|---|
| Bahasa / runtime | JavaScript, Node.js 22 (ES Modules) |
| Framework HTTP | Express 4 |
| Database | PostgreSQL 16 (schema: `auth`, `events`, `orders`) |
| Cache / penyimpanan rate limit | Redis 7 |
| Autentikasi | OAuth2, JWT RS256 (library `jose`), hashing `bcryptjs` |
| Validasi input | `zod` |
| Protokol | REST dan GraphQL (`graphql`) |
| Keamanan HTTP | `helmet`, `cors`, `express-rate-limit` + `rate-limit-redis` |
| Kontainerisasi | Docker dan Docker Compose |
| Deployment | Render (service), Neon (Postgres), Upstash (Redis) |
| Message queue | Diisi pada minggu 11 |

## Menjalankan dengan Docker

Prasyarat: Docker Desktop (Compose v2) yang sudah berstatus **Engine running**. Node.js 20+ hanya dibutuhkan untuk smoke test dan `npm run gen:jwk`. Port **8080** harus kosong.

```bash
docker compose up --build        # gateway di http://localhost:8080
docker compose ps                # event-service dan order-service masing-masing 2 replika
docker compose down -v           # hentikan dan hapus data
```

Tunggu sekitar 30-60 detik sampai `auth-service` dan `gateway` berstatus `healthy`. Tabel dan data contoh dibuat otomatis; database tidak perlu dibuat manual.

Tanpa file `.env`, nilai default pengembangan dipakai (lihat `.env.example`). **Ganti semua secret sebelum deployment.**

Untuk hasil yang bersih sebelum pengujian, jalankan `docker compose down -v` lalu `docker compose up --build`. Smoke test meninggalkan user dan event baru, sehingga mengulanginya tanpa `down -v` dapat mengubah hasil beberapa pemeriksaan.

### Smoke test end-to-end

Butuh Node 20+ di mesin host.

```bash
node scripts/smoke.mjs                       # melawan http://localhost:8080
BASE_URL=https://url-deploy node scripts/smoke.mjs
```

Smoke test memeriksa autentikasi, otorisasi, GraphQL, load balancing, 30 pemesanan bersamaan terhadap stok 10, idempotensi, dan rate limit.

### Tanpa Docker (pengembangan)

Jalankan Postgres dan Redis sendiri, isi variabel dari `.env.example` (dengan `DISCOVERY=static`), lalu `npm ci` dan jalankan `node src/auth-service.js`, `event-service.js`, `order-service.js`, `gateway.js` (masing-masing proses terpisah, `PORT` berbeda).

### Catatan Windows / PowerShell

Contoh `curl` di dokumen ini memakai sintaks bash. Di PowerShell, gunakan `curl.exe` (bukan `curl`), `Invoke-RestMethod`, atau Postman.

## Cara autentikasi

Akun admin awal dibuat dari `ADMIN_EMAIL` dan `ADMIN_PASSWORD` (default lokal: `admin@example.com` / `ChangeMe123!`). Pengguna biasa mendaftar sendiri.

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

Versi PowerShell:

```powershell
$body = @{ email="budi@example.com"; password="Password123!"; name="Budi" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:8080/auth/register -ContentType "application/json" -Body $body

$tok = Invoke-RestMethod -Method Post -Uri http://localhost:8080/oauth/token `
  -Body @{ grant_type="password"; client_id="ticketing-web"; username="budi@example.com"; password="Password123!" }
$H = @{ Authorization = "Bearer $($tok.access_token)" }
Invoke-RestMethod http://localhost:8080/events -Headers $H
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

**Batas yang berlaku** (default, dapat diubah lewat env; respons `429` selalu disertai header `Retry-After`):

| Target | Batas |
|---|---|
| Global | 300/menit per IP |
| `/oauth/token` | 20 percobaan **gagal** per 5 menit per IP |
| `/auth/register` | 20 per 5 menit per IP |
| `/events` | 120/menit per pengguna |
| `/graphql` | 60/menit per pengguna |
| `POST /orders` | 10/menit per pengguna |
| `GET /orders` | 60/menit per pengguna |

Batas lain: maksimum 4 tiket per pesanan; GraphQL kedalaman maksimum 5 dan field maksimum 100 (alias dihitung); `limit` halaman maksimum 50; body maksimum 100 KB di gateway.

## Data awal untuk pengujian

Event Service mengisi 5 event contoh saat pertama kali jalan, termasuk **"Konser Uji Beban (stok terbatas)"** dengan stok 10 tiket untuk menguji pemesanan bersamaan. Penguji dapat membuat event baru lewat akun admin (`POST /events`) untuk skenario lain.

## Memeriksa database

Postgres tidak dibuka ke luar Docker. Periksa lewat container:

```bash
docker compose exec postgres psql -U ticketing -d ticketing
```

| Schema | Tabel |
|---|---|
| `auth` | `users`, `clients` |
| `events` | `events`, `ticket_types`, `reservations` |
| `orders` | `orders` |

```sql
\dt auth.*
\dt events.*
\dt orders.*
SELECT * FROM events.ticket_types;
SELECT * FROM orders.orders ORDER BY created_at DESC LIMIT 10;
\q
```

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

1. Neon: buat database Postgres, salin connection string ke `DATABASE_URL` (tambahkan `?sslmode=require`; tabel dibuat otomatis saat service pertama kali start).
2. Upstash (atau Redis lain): salin URL `rediss://...` ke `REDIS_URL` gateway.
3. Render: buat 4 Web Service dari repo yang sama (build `npm install`, start `node src/<service>.js`). Isi `DISCOVERY=static` dan URL publik antarlayanan (mis. `EVENT_SERVICE_URLS=https://event-service-xxxx.onrender.com`). Isi `TRUST_PROXY=1` pada gateway, `ENFORCE_SECRETS=true` di semua service, dan `JWT_PRIVATE_JWK_B64` (hasil `npm run gen:jwk`) di auth-service. Ganti `ADMIN_PASSWORD` dan `ORDER_SERVICE_CLIENT_SECRET`.
4. Hanya URL gateway yang diberikan kepada kelompok penguji.

**Catatan untuk penguji:** pada tier gratis Render, service tidur setelah tidak aktif sehingga request pertama bisa lambat (cold start). Panggil `GET /health` beberapa kali sebelum pengujian performa.

## Keamanan (ringkasan untuk laporan 4.4)

- OAuth2: password grant untuk pengguna (client publik), client credentials untuk antarlayanan. JWT RS256, `iss`, `aud`, `exp` diverifikasi; kunci diambil dari JWKS.
- Zero trust antarlayanan: gateway memeriksa token, dan setiap service memeriksanya lagi. Header identitas dari klien tidak dipercaya.
- Least privilege: scope per role; endpoint `/internal` hanya untuk role `service` berscope `inventory:write` dan diblokir di gateway.
- Rate limiting berlapis (IP global, percobaan login gagal per IP, pengguna untuk events/GraphQL/order) dengan Redis agar konsisten antar replika. Jika Redis mati, gateway fail-open demi ketersediaan.
- `/health` publik minimal; detail replika hanya di `/admin/upstreams` (admin). `ENFORCE_SECRETS=true` mencegah secret default dipakai di produksi.
- Grant `password` dipakai untuk client publik demi kesederhanaan; OAuth 2.1 sudah menghapusnya (produksi: Authorization Code + PKCE). Dibahas di laporan 4.4.
- Password di-hash bcrypt; login tidak membocorkan keberadaan akun (pesan sama, waktu konstan).
- Otorisasi tingkat objek: pesanan hanya dapat dibaca pemilik atau admin (pengguna lain mendapat 404).
- Validasi input dengan zod di semua endpoint; query SQL berparameter; error 500 tidak membocorkan detail internal.
- GraphQL: batas kedalaman dan jumlah field, batas ukuran halaman, error tak terduga disamarkan. Introspeksi sengaja dibiarkan aktif agar penguji dapat membaca skema.
- Secret hanya dari environment variable; tidak ada secret di repository.
- Integritas stok: pengurangan atomik `UPDATE ... WHERE available >= qty` dan reservasi berkunci `order_id` (idempoten) sehingga tidak terjadi oversell walau permintaan bersamaan atau diproses ulang.

Pemetaan ancaman ke kontrol yang lebih lengkap ada di [`docs/keamanan-dan-protokol.md`](docs/keamanan-dan-protokol.md).

## Service discovery dan load balancing (minggu 10)

Gateway dan Order Service memakai `UpstreamPool` (`src/lib/upstream.js`): di Docker Compose nama service di-resolve lewat DNS ke semua alamat replika (`DISCOVERY=dns`), disegarkan tiap 5 detik, dipantau lewat `GET /health`, lalu request dibagi round-robin hanya ke replika sehat. Jika koneksi ke satu replika gagal, request idempoten otomatis dicoba ke replika lain. Header respons `X-Instance-Id` menunjukkan replika yang melayani, berguna untuk membuktikan load balancing saat pengujian. `GET /admin/upstreams` (admin) menampilkan replika yang ditemukan beserta status sehatnya.

## Pemecahan masalah

| Gejala | Penyebab dan solusi |
|---|---|
| `failed to connect to the docker API` | Docker Desktop belum berjalan. Buka dan tunggu *Engine running*. |
| Popup "WSL integration ... Ubuntu unexpectedly stopped" | Tidak memengaruhi proyek. Pilih *Skip WSL distro integration* atau matikan di Settings > Resources > WSL Integration. |
| `auth-service` `unhealthy`, port 8080 tidak bisa dihubungi | Healthcheck di `docker-compose.yml` harus memakai `127.0.0.1`, bukan `localhost` (server mendengarkan IPv4). Sudah diperbaiki di repo ini. |
| Port 8080 sudah dipakai | Hentikan program lain, atau ubah mapping `ports` gateway di `docker-compose.yml`. |
| Hasil smoke test berubah pada percobaan kedua | Jalankan `docker compose down -v` lalu naikkan ulang untuk data bersih. |
| Token tidak valid setelah restart | `JWT_PRIVATE_JWK_B64` kosong sehingga kunci sementara dipakai. Wajar di lokal; isi untuk deployment. |
| Status 429 | Rate limit. Tunggu sesuai header `Retry-After`. |

Melihat log: `docker compose logs <nama-service>` (mis. `gateway`, `order-service`).

## Struktur proyek

```
src/gateway.js  src/auth-service.js  src/event-service.js  src/order-service.js
src/lib/        common.js (app, error, log)  db.js  security.js (JWT, scope)  upstream.js (discovery, LB)
docs/           openapi.yaml  schema.graphql  arsitektur.png  arsitektur.svg  keamanan-dan-protokol.md
scripts/        smoke.mjs  gen-jwk.mjs
Dockerfile  docker-compose.yml  .env.example  .dockerignore
```

## Rencana berikutnya

- Minggu 11: `POST /orders` menjadi asinkron (`202` + `PENDING`), publish ke message queue, Worker memanggil reservasi stok (sudah idempoten), retry dan dead-letter queue. Fungsi `processOrder` di `order-service.js` sudah dipisahkan untuk disambungkan ke Worker.
- Minggu 12: code freeze, finalisasi dokumentasi dan URL deployment.
