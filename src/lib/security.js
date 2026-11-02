import { createRemoteJWKSet, jwtVerify } from 'jose';
import { HttpError, sendError } from './common.js';

/** Verifikasi JWT RS256 terhadap JWKS milik auth-service (cache + refetch otomatis bila kid baru). */
export function createVerifier({ jwksUrl, issuer, audience }) {
  const jwks = createRemoteJWKSet(new URL(jwksUrl), {
    cooldownDuration: 3000,
    cacheMaxAge: 10 * 60 * 1000,
    timeoutDuration: 4000,
  });
  return async (token) => {
    const { payload } = await jwtVerify(token, jwks, { issuer, audience, algorithms: ['RS256'], clockTolerance: 5 });
    return payload;
  };
}

export function bearerToken(req) {
  const m = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/.exec(req.headers.authorization || '');
  return m ? m[1] : null;
}

function unauthorized(req, res, description, error = 'invalid_token') {
  res.setHeader('WWW-Authenticate', `Bearer realm="ticketing", error="${error}"`);
  sendError(res, req, 401, 'UNAUTHORIZED', description);
}

export function authenticate(verify) {
  return async (req, res, next) => {
    const token = bearerToken(req);
    if (!token) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="ticketing"');
      return sendError(res, req, 401, 'UNAUTHORIZED', 'Token bearer wajib disertakan');
    }
    try {
      const p = await verify(token);
      req.user = {
        id: p.sub,
        role: p.role,
        scopes: String(p.scope || '').split(' ').filter(Boolean),
        clientId: p.client_id,
      };
      next();
    } catch (e) {
      const code = e?.code || '';
      if (code === 'ERR_JWKS_TIMEOUT' || !String(code).startsWith('ERR_J')) {
        return sendError(res, req, 503, 'AUTH_UNAVAILABLE', 'Layanan autentikasi tidak dapat dijangkau');
      }
      return unauthorized(req, res, code === 'ERR_JWT_EXPIRED' ? 'Token sudah kedaluwarsa' : 'Token tidak valid');
    }
  };
}

export const requireScopes = (...needed) => (req, res, next) => {
  if (needed.every((s) => req.user?.scopes.includes(s))) return next();
  res.setHeader('WWW-Authenticate', `Bearer realm="ticketing", error="insufficient_scope", scope="${needed.join(' ')}"`);
  return sendError(res, req, 403, 'FORBIDDEN', 'Hak akses (scope) tidak mencukupi');
};

export const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user?.role) ? next() : sendError(res, req, 403, 'FORBIDDEN', 'Role tidak diizinkan');

/** Token OAuth2 Client Credentials untuk panggilan antarlayanan (di-cache sampai mendekati kedaluwarsa). */
export function createServiceTokenProvider({ authPool, clientId, clientSecret, scope }) {
  let cached = null;
  let inflight = null;
  return async function getToken(forceRefresh = false) {
    if (!forceRefresh && cached && cached.exp - Date.now() > 30000) return cached.token;
    inflight ??= (async () => {
      const r = await authPool.request('POST', '/oauth/token', {
        form: { grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope },
      });
      if (r.status !== 200) throw new HttpError(502, 'SERVICE_TOKEN_FAILED', 'Gagal mengambil token antarlayanan');
      cached = { token: r.body.access_token, exp: Date.now() + r.body.expires_in * 1000 };
      return cached.token;
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  };
}
