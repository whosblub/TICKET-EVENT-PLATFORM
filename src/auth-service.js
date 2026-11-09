// Auth Service: Authorization Server OAuth2.
//  - grant password (client publik "ticketing-web") untuk pengguna
//  - grant client_credentials (client rahasia "order-service") untuk panggilan antarlayanan
//  - JWT RS256 + JWKS, registrasi, /auth/me
import express from 'express';
import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify, importJWK, exportJWK, generateKeyPair, calculateJwkThumbprint } from 'jose';
import crypto from 'node:crypto';
import { setService, createApp, finishApp, listen, env, envInt, log, wrap, validate, sendError, assertSecrets } from './lib/common.js';
import { createPool, waitForDb, migrate } from './lib/db.js';
import { authenticate } from './lib/security.js';
import { ROLE_SCOPES, SERVICE_SCOPES, narrowScopes, clientCredentialsFrom } from './lib/oauth.js';
import { registerSchema } from './lib/schemas.js';
setService('auth-service');

const ISSUER = env('AUTH_ISSUER', 'ticketing-auth');
const AUDIENCE = env('AUTH_AUDIENCE', 'ticketing-api');
const TTL = envInt('ACCESS_TOKEN_TTL_SECONDS', 900);
const ADMIN_EMAIL = env('ADMIN_EMAIL', 'admin@example.com').toLowerCase();
const ADMIN_PASSWORD = env('ADMIN_PASSWORD', 'ChangeMe123!');
const ORDER_SECRET = env('ORDER_SERVICE_CLIENT_SECRET', '');

assertSecrets({ ORDER_SERVICE_CLIENT_SECRET: ORDER_SECRET, ADMIN_PASSWORD, JWT_PRIVATE_JWK_B64: env('JWT_PRIVATE_JWK_B64') });
if (!ORDER_SECRET) throw new Error('ORDER_SERVICE_CLIENT_SECRET wajib diatur');

const COST = 10;
const DUMMY_HASH = bcrypt.hashSync('dummy-password-untuk-waktu-konstan', COST);

// ---- Kunci penandatangan ----
async function loadKeys() {
  const b64 = env('JWT_PRIVATE_JWK_B64');
  let jwk;
  if (b64) {
    jwk = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } else {
    log('warn', 'JWT_PRIVATE_JWK_B64 kosong: memakai kunci sementara (token tidak valid setelah restart; jangan dipakai di produksi)');
    const { privateKey } = await generateKeyPair('RS256', { extractable: true, modulusLength: 2048 });
    jwk = await exportJWK(privateKey);
  }
  jwk.kid ??= await calculateJwkThumbprint(jwk);
  const { d, p, q, dp, dq, qi, oth, ...pub } = jwk;
  const publicJwk = { ...pub, alg: 'RS256', use: 'sig', kid: jwk.kid };
  return {
    kid: jwk.kid,
    privateKey: await importJWK({ ...jwk, alg: 'RS256' }, 'RS256'),
    publicKey: await importJWK(publicJwk, 'RS256'),
    publicJwk,
  };
}
const keys = await loadKeys();

// ---- Database ----
const pool = createPool(env('DATABASE_URL'));
await waitForDb(pool);
await migrate(pool, 7001, async (c) => {
  await c.query('CREATE SCHEMA IF NOT EXISTS auth');
  await c.query(`CREATE TABLE IF NOT EXISTS auth.users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL UNIQUE,
    name text,
    password_hash text NOT NULL,
    role text NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await c.query(`CREATE TABLE IF NOT EXISTS auth.clients (
    id text PRIMARY KEY,
    secret_hash text,
    confidential boolean NOT NULL,
    grant_types text[] NOT NULL,
    scopes text[] NOT NULL,
    role text NOT NULL
  )`);
  // Client publik untuk pengguna (tanpa secret).
  await c.query(
    `INSERT INTO auth.clients(id, secret_hash, confidential, grant_types, scopes, role)
     VALUES ('ticketing-web', NULL, false, '{password}', $1, 'user') ON CONFLICT (id) DO NOTHING`,
    [ROLE_SCOPES.admin],
  );
  // Client rahasia antarlayanan; hash diperbarui tiap start agar rotasi secret lewat env langsung berlaku.
  await c.query(
    `INSERT INTO auth.clients(id, secret_hash, confidential, grant_types, scopes, role)
     VALUES ('order-service', $1, true, '{client_credentials}', $2, 'service')
     ON CONFLICT (id) DO UPDATE SET secret_hash = EXCLUDED.secret_hash`,
    [await bcrypt.hash(ORDER_SECRET, COST), SERVICE_SCOPES],
  );
  await c.query(
    `INSERT INTO auth.users(email, name, password_hash, role) VALUES ($1, 'Admin', $2, 'admin') ON CONFLICT (email) DO NOTHING`,
    [ADMIN_EMAIL, await bcrypt.hash(ADMIN_PASSWORD, COST)],
  );
});

// ---- Token ----
async function issueToken({ sub, role, scopes, clientId }) {
  const token = await new SignJWT({ role, scope: scopes.join(' '), client_id: clientId })
    .setProtectedHeader({ alg: 'RS256', kid: keys.kid, typ: 'JWT' })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${TTL}s`)
    .sign(keys.privateKey);
  return { access_token: token, token_type: 'Bearer', expires_in: TTL, scope: scopes.join(' ') };
}

const oauthError = (res, status, error, description) => {
  res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
  if (status === 401) res.set('WWW-Authenticate', 'Basic realm="ticketing"');
  return res.status(status).json({ error, error_description: description });
};

// ---- App ----
const app = createApp('auth-service');
app.get('/health', wrap(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok', service: 'auth-service' });
}));

app.get('/.well-known/jwks.json', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ keys: [keys.publicJwk] });
});

app.post('/auth/register', express.json({ limit: '10kb' }), wrap(async (req, res) => {
  const body = validate(registerSchema, req.body ?? {});
  const hash = await bcrypt.hash(body.password, COST);
  const r = await pool.query(
    `INSERT INTO auth.users(email, name, password_hash) VALUES ($1,$2,$3) ON CONFLICT (email) DO NOTHING RETURNING id, email, name, role`,
    [body.email, body.name ?? null, hash],
  );
  if (r.rowCount === 0) return sendError(res, req, 409, 'EMAIL_TAKEN', 'Email sudah terdaftar');
  res.status(201).json(r.rows[0]);
}));

app.post('/oauth/token', express.urlencoded({ extended: false, limit: '10kb' }), wrap(async (req, res) => {
  const body = req.body ?? {};
  const grant = body.grant_type;

  if (grant === 'password') {
    const client = (await pool.query('SELECT * FROM auth.clients WHERE id=$1', [body.client_id])).rows[0];
    if (!client || client.confidential || !client.grant_types.includes('password')) {
      return oauthError(res, 401, 'invalid_client', 'Client tidak dikenal');
    }
    if (typeof body.username !== 'string' || typeof body.password !== 'string') {
      return oauthError(res, 400, 'invalid_request', 'username dan password wajib');
    }
    const user = (await pool.query('SELECT * FROM auth.users WHERE email=$1', [body.username.trim().toLowerCase()])).rows[0];
    // Selalu menjalankan bcrypt agar waktu respons sama, baik akun ada maupun tidak.
    const okPw = await bcrypt.compare(body.password.slice(0, 200), user?.password_hash ?? DUMMY_HASH);
    if (!user || !okPw) return oauthError(res, 400, 'invalid_grant', 'Email atau password salah');
    const scopes = narrowScopes(ROLE_SCOPES[user.role], body.scope);
    if (!scopes.length) return oauthError(res, 400, 'invalid_scope', 'Scope tidak diizinkan');
    res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
    return res.json(await issueToken({ sub: user.id, role: user.role, scopes, clientId: client.id }));
  }

  if (grant === 'client_credentials') {
    const { id, secret } = clientCredentialsFrom(req);
    const client = typeof id === 'string' ? (await pool.query('SELECT * FROM auth.clients WHERE id=$1', [id])).rows[0] : null;
    const okSecret = await bcrypt.compare(String(secret ?? '').slice(0, 200), client?.secret_hash ?? DUMMY_HASH);
    if (!client || !client.confidential || !okSecret || !client.grant_types.includes('client_credentials')) {
      return oauthError(res, 401, 'invalid_client', 'Autentikasi client gagal');
    }
    const scopes = narrowScopes(client.scopes, body.scope);
    if (!scopes.length) return oauthError(res, 400, 'invalid_scope', 'Scope tidak diizinkan');
    res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
    return res.json(await issueToken({ sub: client.id, role: client.role, scopes, clientId: client.id }));
  }

  return oauthError(res, 400, 'unsupported_grant_type', 'grant_type harus password atau client_credentials');
}));

const verifyLocal = async (token) =>
  (await jwtVerify(token, keys.publicKey, { issuer: ISSUER, audience: AUDIENCE, algorithms: ['RS256'], clockTolerance: 5 })).payload;

app.get('/auth/me', authenticate(verifyLocal), (req, res) => res.json(req.user));

finishApp(app);
listen(app, 4000);