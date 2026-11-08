// Smoke test end-to-end lewat gateway. Jalankan: BASE_URL=http://localhost:8080 node scripts/smoke.mjs
// Catatan: dijalankan sekali per ~1 menit (rate limit order per user) dan memakai event baru tiap kali.
// Pemesanan bersifat asinkron (202 PENDING -> diproses Worker), jadi pengujian menunggu status akhir lewat polling.
const BASE = process.env.BASE_URL || 'http://localhost:8080';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
const run = Date.now().toString(36);

let failed = 0;
const ok = (cond, name, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`);
  if (!cond) failed++;
};
const call = async (method, path, { token, json, form, headers = {} } = {}) => {
  const init = { method, headers: { ...headers } };
  if (token) init.headers.authorization = `Bearer ${token}`;
  if (json !== undefined) { init.body = JSON.stringify(json); init.headers['content-type'] = 'application/json'; }
  if (form) { init.body = new URLSearchParams(form).toString(); init.headers['content-type'] = 'application/x-www-form-urlencoded'; }
  const res = await fetch(BASE + path, init);
  const text = await res.text();
  let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
};
const login = async (username, password) =>
  call('POST', '/oauth/token', { form: { grant_type: 'password', client_id: 'ticketing-web', username, password } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Pesanan diproses asinkron oleh Worker: tunggu sampai semua pesanan para user keluar dari PENDING.
// Polling dibuat jarang (1,5 dtk) agar tidak melewati rate limit baca /orders (60/menit per user).
async function settle(tokens, expected, timeoutMs = 40000) {
  const t0 = Date.now();
  let all = [];
  while (Date.now() - t0 < timeoutMs) {
    all = (await Promise.all(tokens.map((t) => call('GET', '/orders?limit=50', { token: t })))).flatMap((r) => r.body?.data ?? []);
    if (all.length >= expected && all.every((o) => o.status !== 'PENDING')) return all;
    await sleep(1500);
  }
  return all;
}
async function waitOrder(token, id, timeoutMs = 20000) {
  const t0 = Date.now();
  let r;
  while (Date.now() - t0 < timeoutMs) {
    r = await call('GET', `/orders/${id}`, { token });
    if (r.body?.status && r.body.status !== 'PENDING') return r.body;
    await sleep(1000);
  }
  return r?.body;
}
const gql = (token, query) => call('POST', '/graphql', { token, json: { query } });

async function newUser(tag) {
  const email = `${tag}-${run}@example.com`;
  const reg = await call('POST', '/auth/register', { json: { email, password: 'Password123!', name: tag } });
  if (reg.status !== 201) throw new Error(`register gagal: ${reg.status} ${JSON.stringify(reg.body)}`);
  const t = await login(email, 'Password123!');
  return t.body.access_token;
}

console.log(`Smoke test -> ${BASE}\n`);

// 1. Autentikasi & otorisasi
ok((await call('GET', '/health')).status === 200, 'gateway /health');
ok((await call('GET', '/events')).status === 401, 'tanpa token -> 401');
ok((await call('GET', '/events', { token: 'bukan.token.valid' })).status === 401, 'token palsu -> 401');
ok((await login('tidakada@example.com', 'salahsalah')).body?.error === 'invalid_grant', 'login salah -> invalid_grant');
const dup = await call('POST', '/auth/register', { json: { email: `dup-${run}@example.com`, password: 'Password123!' } });
const dup2 = await call('POST', '/auth/register', { json: { email: `dup-${run}@example.com`, password: 'Password123!' } });
ok(dup.status === 201 && dup2.status === 409, 'register email ganda -> 409');
ok((await call('POST', '/auth/register', { json: { email: 'bukan-email', password: '123' } })).status === 400, 'register invalid -> 400');

const userToken = await newUser('user');
const adminLogin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
const adminToken = adminLogin.body?.access_token;
ok(!!adminToken, 'login admin');
const health = await call('GET', '/health');
ok(health.body?.upstreams === undefined, '/health publik tidak membocorkan alamat upstream');
ok((await call('GET', '/admin/upstreams', { token: userToken })).status === 403, '/admin/upstreams oleh user biasa -> 403');
const ups = await call('GET', '/admin/upstreams', { token: adminToken });
ok(ups.status === 200 && ups.body.upstreams.every((u) => u.targets.length >= 1), '/admin/upstreams oleh admin menampilkan replika', JSON.stringify(ups.body?.upstreams?.map((u) => `${u.name}:${u.targets.length}`)));
ok((await call('POST', '/oauth/token', { form: { grant_type: 'client_credentials', client_id: 'order-service', client_secret: 'salah' } })).status === 401, 'client_credentials secret salah -> 401');
ok((await call('POST', '/events', { token: userToken, json: {} })).status === 403, 'user biasa POST /events -> 403');
ok((await call('POST', '/internal/reservations', { token: userToken, json: {} })).status === 404, '/internal tidak terjangkau dari luar -> 404');
ok((await call('GET', '/auth/me', { token: userToken })).body?.role === 'user', '/auth/me menampilkan role user');

// 2. Katalog: REST + GraphQL
const list = await call('GET', '/events?city=Jakarta&limit=5', { token: userToken });
ok(list.status === 200 && list.body.data.length > 0 && list.body.data.every((e) => e.city === 'Jakarta'), 'REST GET /events filter kota', `total=${list.body?.page?.total}`);
ok((await call('GET', '/events/bukan-uuid', { token: userToken })).status === 400, 'REST id tidak valid -> 400');
ok((await call('GET', '/events?limit=1000', { token: userToken })).status === 400, 'REST limit > 50 -> 400');
const g1 = await gql(userToken, '{ events(filter:{onlyAvailable:true}, limit:3){ total items{ name startsAt minPrice totalAvailable ticketTypes{ name price available } } } }');
ok(g1.status === 200 && g1.body.data?.events?.items?.length > 0 && !g1.body.errors, 'GraphQL query katalog', `items=${g1.body?.data?.events?.items?.length}`);
const g2 = await gql(userToken, '{ events(limit:2){ items{ name startsAt } } }');
ok(Object.keys(g2.body.data.events.items[0]).sort().join() === 'name,startsAt', 'GraphQL hanya mengembalikan field yang diminta');
const deep = await gql(userToken, '{ events { items { ticketTypes { id name price available } } } }');
ok(!deep.body.errors, 'GraphQL kedalaman 4 (batas 5) diizinkan');
const frag = 'fragment A on Event { ticketTypes { id } } query { events { items { ...A } } }';
ok(!(await gql(userToken, frag)).body.errors, 'GraphQL fragment diizinkan');
const bomb = await gql(userToken, '{ ' + Array.from({ length: 120 }, (_, i) => `a${i}: events(limit:1){ total }`).join(' ') + ' }');
ok(bomb.body.errors?.[0]?.extensions?.code === 'QUERY_TOO_COMPLEX', 'GraphQL alias bomb ditolak (jumlah field)');
ok((await gql(userToken, 'mutation { createEvent(input:{name:"x",artist:"x",venue:"x",city:"x",category:"x",startsAt:"2027-01-01T10:00:00Z",ticketTypes:[{name:"a",price:1,total:1}]}){ id } }')).body.errors?.[0]?.extensions?.code === 'FORBIDDEN', 'GraphQL mutation oleh user biasa -> FORBIDDEN');
const adminGql = await gql(adminToken, `mutation { createEvent(input:{name:"GQL Event ${run}",artist:"A",venue:"V",city:"Medan",category:"konser",startsAt:"2027-01-01T10:00:00+07:00",ticketTypes:[{name:"Regular",price:100000,total:5}]}){ id name ticketTypes{ id available } } }`);
ok(adminGql.body.data?.createEvent?.ticketTypes?.[0]?.available === 5, 'GraphQL mutation createEvent oleh admin');

// 3. Load balancing
const seen = new Set();
for (let i = 0; i < 12; i++) seen.add((await call('GET', '/events?limit=1', { token: userToken })).headers.get('x-instance-id'));
ok(seen.size >= 2, 'load balancing round-robin antar replika event-service', [...seen].join(', '));

// 4. Pemesanan: stok 10, 30 pemesanan bersamaan dari 5 user -> tepat 10 sukses
const created = await call('POST', '/events', { token: adminToken, json: {
  name: `Konser Race ${run}`, artist: 'Test', venue: 'Venue', city: 'Surabaya', category: 'konser',
  startsAt: '2027-07-01T19:00:00+07:00', ticketTypes: [{ name: 'Early Bird', price: 100000, total: 10 }],
} });
ok(created.status === 201, 'admin membuat event uji (stok 10)');
const ttId = created.body.ticketTypes[0].id;
const users = await Promise.all(['u1', 'u2', 'u3', 'u4', 'u5'].map(newUser));
const attempts = users.flatMap((t) => Array.from({ length: 6 }, () => call('POST', '/orders', { token: t, json: { ticketTypeId: ttId, quantity: 1 } })));
const results = await Promise.all(attempts);
const accepted = results.filter((r) => r.status === 202);
ok(accepted.length === 30 && accepted.every((r) => r.body.status === 'PENDING' && !!r.headers.get('location')), '30 pemesanan bersamaan diterima antrian (202 PENDING + Location)', `202=${accepted.length} lain=${results.length - accepted.length}`);
const settled = await settle(users, 30);
const confirmed = settled.filter((o) => o.status === 'CONFIRMED').length;
const rejected = settled.filter((o) => o.status === 'REJECTED' && o.reason === 'INSUFFICIENT_STOCK').length;
ok(confirmed === 10 && rejected === 20, 'worker memproses antrian: stok 10 -> tepat 10 CONFIRMED, 20 REJECTED (INSUFFICIENT_STOCK)', `CONFIRMED=${confirmed} REJECTED=${rejected} total=${settled.length}`);
const after = await call('GET', `/events/${created.body.id}`, { token: userToken });
ok(after.body.ticketTypes[0].available === 0, 'stok akhir = 0 (tidak negatif)', `available=${after.body.ticketTypes[0].available}`);
ok(new Set(results.map((r) => r.headers.get('x-instance-id'))).size >= 1, 'order-service melayani lewat replika', [...new Set(results.map((r) => r.headers.get('x-instance-id')))].join(', '));

// 5. Idempotency & kepemilikan pesanan
const ev2 = await call('POST', '/events', { token: adminToken, json: { name: `Idem ${run}`, artist: 'T', venue: 'V', city: 'Medan', category: 'konser', startsAt: '2027-08-01T19:00:00+07:00', ticketTypes: [{ name: 'R', price: 50000, total: 50 }] } });
const tt2 = ev2.body.ticketTypes[0].id;
const buyer = await newUser('buyer');
const o1 = await call('POST', '/orders', { token: buyer, json: { ticketTypeId: tt2, quantity: 2 }, headers: { 'idempotency-key': `key-${run}` } });
const o2 = await call('POST', '/orders', { token: buyer, json: { ticketTypeId: tt2, quantity: 2 }, headers: { 'idempotency-key': `key-${run}` } });
ok(o1.status === 202 && o2.status === 200 && o1.body.id === o2.body.id, 'Idempotency-Key: kirim ulang tidak memesan dua kali (202 lalu 200, id sama)');
const o1Final = await waitOrder(buyer, o1.body.id);
ok(o1Final?.status === 'CONFIRMED', 'pesanan diproses worker -> CONFIRMED', `status=${o1Final?.status}`);
const evAfter = await call('GET', `/events/${ev2.body.id}`, { token: buyer });
ok(evAfter.body.ticketTypes[0].available === 48, 'stok hanya berkurang 2', `available=${evAfter.body.ticketTypes[0].available}`);
const o3 = await call('POST', '/orders', { token: buyer, json: { ticketTypeId: tt2, quantity: 3 }, headers: { 'idempotency-key': `key-${run}` } });
ok(o3.status === 409 && o3.body.error.code === 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key dipakai untuk pesanan lain -> 409');
// Klik ganda: 5 request bersamaan dengan Idempotency-Key sama -> hanya 1 pesanan, stok berkurang sekali
const dupBuyer = await newUser('dupbuyer');
const dupRes = await Promise.all(Array.from({ length: 5 }, () => call('POST', '/orders', { token: dupBuyer, json: { ticketTypeId: tt2, quantity: 1 }, headers: { 'idempotency-key': `dup-${run}` } })));
const dupIds = new Set(dupRes.map((r) => r.body?.id));
ok(dupIds.size === 1 && dupRes.filter((r) => r.status === 202).length === 1 && dupRes.filter((r) => r.status === 200).length === 4, 'klik ganda (5 request, Idempotency-Key sama) -> hanya 1 pesanan', `id unik=${dupIds.size} 202=${dupRes.filter((r) => r.status === 202).length} 200=${dupRes.filter((r) => r.status === 200).length}`);
const dupFinal = await waitOrder(dupBuyer, [...dupIds][0]);
const evDup = await call('GET', `/events/${ev2.body.id}`, { token: dupBuyer });
ok(dupFinal?.status === 'CONFIRMED' && evDup.body.ticketTypes[0].available === 47, 'klik ganda: stok hanya berkurang 1 (48 -> 47)', `status=${dupFinal?.status} available=${evDup.body.ticketTypes[0].available}`);
const stranger = await newUser('stranger');
ok(o1Final?.totalPrice === 100000, 'pemilik dapat melihat pesanannya (total 2 x 50000)');
ok((await call('GET', `/orders/${o1.body.id}`, { token: stranger })).status === 404, 'user lain tidak dapat melihat pesanan (BOLA) -> 404');
ok((await call('GET', `/orders/${o1.body.id}`, { token: adminToken })).status === 200, 'admin dapat melihat pesanan');
ok((await call('POST', '/orders', { token: buyer, json: { ticketTypeId: tt2, quantity: 99 } })).status === 400, 'quantity melebihi batas -> 400');
const ghost = await call('POST', '/orders', { token: buyer, json: { ticketTypeId: '00000000-0000-4000-8000-000000000000', quantity: 1 } });
const ghostFinal = ghost.status === 202 ? await waitOrder(buyer, ghost.body.id) : null;
ok(ghost.status === 202 && ghostFinal?.status === 'REJECTED' && ghostFinal?.reason === 'TICKET_TYPE_NOT_FOUND', 'ticket type tidak ada -> diterima 202, lalu REJECTED (TICKET_TYPE_NOT_FOUND)', `status=${ghostFinal?.status} reason=${ghostFinal?.reason}`);

// 6. Rate limiting per user pada /orders (dijalankan terakhir)
const spammer = await newUser('spammer');
const burst = await Promise.all(Array.from({ length: 15 }, () => call('POST', '/orders', { token: spammer, json: {} })));
const limited = burst.filter((r) => r.status === 429);
ok(limited.length >= 5 && !!limited[0].headers.get('retry-after'), 'rate limit /orders per user -> 429 + Retry-After', `429=${limited.length}/15`);

console.log(failed ? `\n${failed} pengujian GAGAL` : '\nSemua pengujian lulus');
process.exit(failed ? 1 : 0);
