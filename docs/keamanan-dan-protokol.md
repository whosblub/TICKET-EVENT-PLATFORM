# Catatan untuk laporan: ancaman -> kontrol (4.4) dan justifikasi protokol (4.3)

## Pemetaan ancaman ke kontrol

| Ancaman | Kontrol di sistem | Lokasi |
|---|---|---|
| Lonjakan request saat penjualan dibuka / bot | Rate limit berlapis (IP global, per pengguna untuk order/GraphQL/events), Redis agar konsisten antar replika, `429` + `Retry-After` | `gateway.js` |
| Brute force login / credential stuffing | Rate limit khusus `/oauth/token` yang hanya menghitung percobaan gagal; bcrypt; waktu respons konstan; pesan error sama | `gateway.js`, `auth-service.js` |
| Token palsu / kedaluwarsa | JWT RS256 diverifikasi lewat JWKS (`iss`, `aud`, `exp`), TTL 15 menit | `lib/security.js` |
| Akses ke pesanan orang lain (BOLA/IDOR) | Kepemilikan dicek di query; selain pemilik/admin mendapat `404` | `order-service.js` |
| Eskalasi hak | Scope per role (least privilege); `/events` POST hanya admin; mutation GraphQL hanya admin | semua service |
| Akses langsung ke endpoint internal | `/internal/*` diblokir gateway (404) dan hanya menerima role `service` + scope `inventory:write` | `gateway.js`, `event-service.js` |
| Service palsu memanggil service lain | OAuth2 Client Credentials; secret dari environment variable | `auth-service.js`, `lib/security.js` |
| Header identitas dipalsukan klien | Gateway membuang header `x-user-*`; identitas hanya dari JWT yang diverifikasi ulang tiap service | `gateway.js` |
| Oversell / double order | `UPDATE ... WHERE available >= qty` atomik, reservasi berkunci `order_id`, `Idempotency-Key`, CHECK constraint stok >= 0 | `event-service.js`, `order-service.js`, `worker.js` |
| Query GraphQL mahal / alias bomb | Batas kedalaman 5, maksimum 100 field, limit halaman 50, limiter khusus `/graphql` | `event-service.js`, `gateway.js` |
| Injeksi | Validasi zod di setiap endpoint, SQL berparameter | semua service |
| Kebocoran informasi | `/health` publik minimal; detail upstream hanya `/admin/upstreams` (admin); error 500 disamarkan | `gateway.js`, `lib/common.js` |
| Secret default terpakai di produksi | `ENFORCE_SECRETS=true` membuat service menolak start bila secret kosong/default | `lib/common.js` |

Keputusan yang perlu dibahas jujur di laporan:
- Rate limiter *fail-open* bila Redis mati (ketersediaan didahulukan).
- Pemesanan asinkron: `202` berarti diterima, bukan terjual. Konsekuensinya klien harus polling status; sebagai gantinya server tahan lonjakan karena beban dipindah ke antrian dan Worker.
- Pesanan yang gagal permanen (`PROCESSING_FAILED`) dapat meninggalkan reservasi stok yang tertahan; dipilih karena kesalahan "kurang jual" lebih aman daripada oversell.
- Grant `password` dipakai untuk client publik karena sederhana untuk tugas ini. OAuth 2.1 sudah menghapusnya; untuk produksi gunakan Authorization Code + PKCE.
- Komunikasi antar service di Docker Compose memakai HTTP biasa; di Render lewat HTTPS publik.

## Kerangka justifikasi GraphQL (sesi 7)

1. **Konsumen API**: klien web dan mobile butuh bentuk data berbeda (daftar ringkas vs detail dengan jenis tiket); satu query menggantikan beberapa panggilan REST.
2. **Variasi data**: katalog event punya banyak atribut opsional dan relasi (event -> jenis tiket); klien memilih field sendiri, mengurangi over-fetching.
3. **Kebutuhan performa**: kurang payload di jaringan seluler; risikonya query mahal, ditangani batas kedalaman/field dan rate limit. Caching HTTP lebih sulit dibanding REST.
4. **Sistem legacy**: tidak ada sistem lama yang harus diintegrasikan, jadi tidak ada hambatan adopsi.
5. **Mengapa bukan gRPC**: konsumen utama adalah klien web/penguji lewat HTTP, bukan komunikasi service-ke-service berlatensi rendah; gRPC butuh tooling tambahan bagi penguji.
6. **Mengapa pemesanan tetap REST**: operasi tulis dengan hasil sederhana, mudah diberi `Idempotency-Key`, rate limit per metode, dan status code yang jelas.
