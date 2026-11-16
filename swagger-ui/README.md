# Swagger UI (situs statis, untuk Vercel)

Dokumentasi interaktif untuk `docs/openapi.yaml`. Murni file statis (tanpa server, tanpa build); tidak mengubah sistem yang di-freeze.

## Deploy di Vercel
Opsi A (tanpa Git): vercel.com/new > pilih **folder** > pilih folder `swagger-ui` > Deploy.
Opsi B (Git): import repo, Root Directory = `swagger-ui`, Framework = Other, tanpa build. Pastikan branch produksi di Settings menunjuk ke branch yang berisi folder ini.

Lalu:
1. Salin domain Vercel (mis. `https://ticketing-docs.vercel.app`).
2. Di service **gateway** Railway tambahkan env var `CORS_ORIGINS=https://<domain-vercel>` (tanpa garis miring di akhir; beberapa domain dipisah koma), lalu redeploy gateway. Tanpa ini tombol "Try it out" diblokir browser (dokumentasi tetap terbaca).
3. Cara memakai: jalankan `POST /oauth/token` (`grant_type=password`, `client_id=ticketing-web`, username, password), salin `access_token`, klik **Authorize**, tempel token.

## Menyamakan spesifikasi
`openapi.yaml` di folder ini adalah salinan `docs/openapi.yaml`. Bila spesifikasi berubah, salin ulang filenya lalu deploy ulang.

## Lokal
`python3 -m http.server 8081` di folder ini, buka http://localhost:8081
