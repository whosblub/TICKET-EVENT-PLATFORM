import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { SignJWT, generateKeyPair, exportJWK } from 'jose';
import { freePort } from './helpers.js';

const GATEWAY = fileURLToPath(new URL('../src/gateway.js', import.meta.url));
const children = [];
let jwksServer, jwksUrl, privateKey;

before(async () => {
  const kp = await generateKeyPair('RS256');
  privateKey = kp.privateKey;
  const jwk = { ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  jwksServer = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] })); });
  await new Promise((r) => jwksServer.listen(0, '127.0.0.1', r));
  jwksUrl = `http://127.0.0.1:${jwksServer.address().port}/jwks.json`;
});
after(() => { for (const c of children) c.kill('SIGKILL'); jwksServer.close(); });

const tokenFor = (sub) =>
  new SignJWT({ role: 'user', scope: 'events:read orders:read orders:write' })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setSubject(sub).setIssuer('ticketing-auth').setAudience('ticketing-api')
    .setIssuedAt().setExpirationTime('10m').sign(privateKey);

// Jalankan gateway.js sungguhan dengan batas kecil; service di belakangnya sengaja mati (-> 503)
async function startGateway(limits = {}) {
  const port = await freePort();
  const dead = `http://127.0.0.1:${await freePort()}`;
  const child = spawn(process.execPath, [GATEWAY], {
    env: {
      ...process.env, PORT: String(port), DISCOVERY: 'static', LOG_REQUESTS: 'false',
      AUTH_SERVICE_URLS: dead, EVENT_SERVICE_URLS: dead, ORDER_SERVICE_URLS: dead, AUTH_JWKS_URL: jwksUrl,
      RATE_LIMIT_GLOBAL_PER_MIN: '1000', REDIS_URL: '', ...limits, // REDIS_URL kosong: test selalu pakai memori lokal (tidak bercampur dengan Redis di mesin pengembang)
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  children.push(child);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`gateway berhenti: ${stderr}`);
    try { if ((await fetch(`${base}/health`)).ok) return { base }; } catch { /* belum siap */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`gateway tidak siap: ${stderr}`);
}

const statuses = async (n, fn) => { const out = []; for (let i = 0; i < n; i++) out.push((await fn(i)).status); return out; };

test('limit global: request ke-(N+1) dibalas 429 + Retry-After', async () => {
  const { base } = await startGateway({ RATE_LIMIT_GLOBAL_PER_MIN: '5' });
  assert.deepEqual(await statuses(5, () => fetch(`${base}/internal/x`)), [404, 404, 404, 404, 404]);
  const r = await fetch(`${base}/internal/x`);
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get('retry-after')) >= 1);
  assert.equal((await r.json()).error.code, 'RATE_LIMITED');
});

test('/health tidak ikut dibatasi', async () => {
  const { base } = await startGateway({ RATE_LIMIT_GLOBAL_PER_MIN: '2' });
  assert.ok((await statuses(15, () => fetch(`${base}/health`))).every((s) => s === 200));
});

test('anti brute force: login gagal dihitung, setelah batas -> 429', async () => {
  const { base } = await startGateway({ RATE_LIMIT_AUTH_PER_5MIN: '3' });
  const login = () => fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=password&client_id=ticketing-web&username=a@b.c&password=salah' });
  assert.deepEqual(await statuses(3, login), [503, 503, 503]);
  assert.equal((await login()).status, 429);
});

test('POST /orders dibatasi per PENGGUNA: user A kena 429, user B tetap dilayani', async () => {
  const { base } = await startGateway({ RATE_LIMIT_ORDER_PER_MIN: '3' });
  const [a, b] = [await tokenFor('user-a'), await tokenFor('user-b')];
  const order = (tok) => fetch(`${base}/orders`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: '{}' });
  assert.deepEqual(await statuses(3, () => order(a)), [503, 503, 503]);
  assert.equal((await order(a)).status, 429);
  assert.equal((await order(b)).status, 503);
});