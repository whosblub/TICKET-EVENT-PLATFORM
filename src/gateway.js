// API Gateway / reverse proxy: HTTPS (di depan oleh platform), verifikasi token OAuth2, rate limiting,
// routing, service discovery + load balancing, dan pemblokiran endpoint internal.
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { Redis } from 'ioredis';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { setService, createApp, finishApp, listen, env, envInt, envList, log, wrap, sendError, HttpError } from './lib/common.js';
import { UpstreamPool } from './lib/upstream.js';
import { createVerifier, authenticate, requireScopes, requireRole } from './lib/security.js';
setService('gateway');

const DISCOVERY = env('DISCOVERY', 'static');
const BODY_LIMIT = envInt('GATEWAY_BODY_LIMIT_BYTES', 100 * 1024);
const UPSTREAM_TIMEOUT_MS = envInt('UPSTREAM_TIMEOUT_MS', 10000);

const pools = {
  auth: new UpstreamPool('auth-service', envList('AUTH_SERVICE_URLS', ['http://auth-service:4000']), { discovery: DISCOVERY }),
  event: new UpstreamPool('event-service', envList('EVENT_SERVICE_URLS', ['http://event-service:4001']), { discovery: DISCOVERY }),
  order: new UpstreamPool('order-service', envList('ORDER_SERVICE_URLS', ['http://order-service:4002']), { discovery: DISCOVERY }),
};
await Promise.all(Object.values(pools).map((p) => p.start()));

// ---- Rate limiting (Redis bila REDIS_URL diatur, supaya hitungan sama di semua replika gateway) ----
let redis = null;
if (env('REDIS_URL')) {
  const r = new Redis(env('REDIS_URL'), { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: true });
  r.on('error', (e) => log('warn', 'redis error', { error: e.message }));
  try {
    await Promise.race([r.connect(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))]);
    redis = r;
  } catch (e) {
    log('warn', 'Redis tidak tersedia, rate limit memakai memori lokal (tidak konsisten antar replika)', { error: e.message });
    r.disconnect();
  }
}
function limiter(name, { windowMs, limit, byUser = false, onlyFailures = false }) {
  return rateLimit({
    windowMs,
    limit,
    skipSuccessfulRequests: onlyFailures, // dipakai untuk login: hanya percobaan gagal yang dihitung (anti brute force)
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    passOnStoreError: true, // fail-open: jika Redis mati, layanan tetap melayani (keputusan desain: ketersediaan > pembatasan)
    keyGenerator: (req) => (byUser && req.user ? `u:${req.user.id}` : `ip:${ipKeyGenerator(req.ip)}`),
    store: redis ? new RedisStore({ sendCommand: (...args) => redis.call(...args), prefix: `rl:${name}:` }) : undefined,
    handler: (req, res) => {
      const retry = Math.ceil((req.rateLimit.resetTime.getTime() - Date.now()) / 1000);
      res.setHeader('Retry-After', String(Math.max(retry, 1)));
      sendError(res, req, 429, 'RATE_LIMITED', 'Terlalu banyak permintaan, coba lagi nanti');
    },
  });
}
const globalLimiter = limiter('global', { windowMs: 60_000, limit: envInt('RATE_LIMIT_GLOBAL_PER_MIN', 300) });
const tokenLimiter = limiter('token', { windowMs: 5 * 60_000, limit: envInt('RATE_LIMIT_AUTH_PER_5MIN', 20), onlyFailures: true });
const registerLimiter = limiter('register', { windowMs: 5 * 60_000, limit: envInt('RATE_LIMIT_AUTH_PER_5MIN', 20) });
const eventsLimiter = limiter('events', { windowMs: 60_000, limit: envInt('RATE_LIMIT_EVENTS_PER_MIN', 120), byUser: true });
const graphqlLimiter = limiter('graphql', { windowMs: 60_000, limit: envInt('RATE_LIMIT_GRAPHQL_PER_MIN', 60), byUser: true });
const orderWriteLimiter = limiter('order-write', { windowMs: 60_000, limit: envInt('RATE_LIMIT_ORDER_PER_MIN', 10), byUser: true });
const orderReadLimiter = limiter('order-read', { windowMs: 60_000, limit: envInt('RATE_LIMIT_ORDER_READ_PER_MIN', 60), byUser: true });

// ---- Reverse proxy sederhana dengan load balancing + failover ----
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length']);

async function readBody(req) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > BODY_LIMIT) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Body terlalu besar');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

function forward(pool) {
  return wrap(async (req, res) => {
    const body = await readBody(req);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && !k.startsWith('x-user-')) headers[k] = v;
    headers['x-request-id'] = req.id;
    headers['x-forwarded-for'] = [req.headers['x-forwarded-for'], req.socket.remoteAddress].filter(Boolean).join(', ');
    headers['x-forwarded-proto'] = req.protocol;
    if (body.length) headers['content-length'] = String(body.length);

    const idempotent = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    const tried = new Set();
    const maxAttempts = Math.max(1, Math.min(pool.size(), 3));

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const target = pool.pick(tried);
      if (!target) break;
      tried.add(target.url);
      try {
        await new Promise((resolve, reject) => {
          const url = new URL(req.originalUrl, target.url);
          const lib = url.protocol === 'https:' ? https : http;
          const up = lib.request(url, { method: req.method, headers, timeout: UPSTREAM_TIMEOUT_MS }, (upRes) => {
            const out = { ...upRes.headers };
            for (const h of HOP) delete out[h];
            res.writeHead(upRes.statusCode, out);
            upRes.pipe(res);
            upRes.on('end', resolve);
            upRes.on('error', reject);
          });
          up.on('timeout', () => up.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
          up.on('error', reject);
          up.end(body);
        });
        return;
      } catch (e) {
        pool.markFailed(target);
        log('warn', 'upstream error', { requestId: req.id, upstream: pool.name, target: target.url, error: e.code || e.message });
        if (res.headersSent) return res.destroy();
        // Hanya ulangi jika aman: request idempoten, atau koneksi memang tidak pernah terbentuk.
        const safeToRetry = idempotent || ['ECONNREFUSED', 'EHOSTUNREACH', 'ENOTFOUND'].includes(e.code);
        if (!safeToRetry) return sendError(res, req, 504, 'UPSTREAM_ERROR', 'Layanan tidak merespons tepat waktu');
      }
    }
    sendError(res, req, 503, 'SERVICE_UNAVAILABLE', `Layanan ${pool.name} tidak tersedia`);
  });
}

// ---- Aplikasi ----
const app = createApp('gateway');
app.use(cors({ origin: envList('CORS_ORIGINS', []).length ? envList('CORS_ORIGINS') : false, exposedHeaders: ['X-Request-Id', 'X-Instance-Id', 'Retry-After', 'RateLimit', 'RateLimit-Policy'] }));

// Publik: sengaja minimal (tanpa alamat internal replika). Detail upstream ada di /admin/upstreams (khusus admin).
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'gateway' }));

// Antarmuka web sederhana (folder public/). Disajikan sebelum rate limit global agar aset statis tidak
// menghabiskan kuota API. CSP khusus halaman ini: hanya skrip dan gaya dari origin sendiri; tanpa
// upgrade-insecure-requests (default helmet) supaya tetap berjalan di http://localhost.
const UI_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; "
  + "base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'";
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url)), {
  index: 'index.html',
  maxAge: 0,
  setHeaders: (res) => {
    res.setHeader('Content-Security-Policy', UI_CSP);
    res.setHeader('Cache-Control', 'no-cache');
  },
}));

app.use(globalLimiter);

// Endpoint internal tidak pernah dapat dijangkau dari luar.
app.use('/internal', (req, res) => sendError(res, req, 404, 'NOT_FOUND', 'Resource tidak ditemukan'));

const verify = createVerifier({
  jwksUrl: env('AUTH_JWKS_URL', 'http://auth-service:4000/.well-known/jwks.json'),
  issuer: env('AUTH_ISSUER', 'ticketing-auth'),
  audience: env('AUTH_AUDIENCE', 'ticketing-api'),
});
const auth = authenticate(verify);

// Publik (tanpa token): pendaftaran, penerbitan token, JWKS. Dibatasi lebih ketat untuk mencegah brute force.
app.use('/auth/register', registerLimiter, forward(pools.auth));
app.use('/oauth/token', tokenLimiter, forward(pools.auth));
app.use('/.well-known', forward(pools.auth));
// Perlu token: /auth/me juga diperiksa di gateway.
app.use('/auth/me', auth, forward(pools.auth));

// Terlindungi: token diperiksa di gateway (dan diperiksa ulang oleh tiap service, zero trust).
app.use('/events', auth, requireScopes('events:read'), eventsLimiter, forward(pools.event));
app.use('/graphql', auth, requireScopes('events:read'), graphqlLimiter, forward(pools.event));
app.use('/orders', auth, (req, res, next) => (req.method === 'POST' ? orderWriteLimiter : orderReadLimiter)(req, res, next), forward(pools.order));

// Diagnostik service discovery / load balancing (khusus admin).
app.get('/admin/upstreams', auth, requireRole('admin'), (req, res) => res.json({ discovery: DISCOVERY, upstreams: Object.values(pools).map((p) => p.snapshot()) }));

finishApp(app);
listen(app, 8080);
