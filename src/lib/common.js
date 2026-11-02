// Utilitas bersama: konfigurasi, log, error seragam, pembuatan app Express.
import os from 'node:os';
import crypto from 'node:crypto';
import express from 'express';
import helmet from 'helmet';

let SERVICE = 'app';
const INSTANCE = os.hostname();

export function setService(name) {
  SERVICE = name;
  process.on('unhandledRejection', (e) => {
    log('error', 'unhandledRejection', { error: e?.message ?? String(e) });
  });
  process.on('uncaughtException', (e) => {
    log('error', 'uncaughtException', { error: e?.message ?? String(e) });
    process.exit(1);
  });
}

// ---- Konfigurasi dari environment variable ----
export function env(key, def = '') {
  const v = process.env[key];
  return v === undefined || v === '' ? def : v;
}
export function envInt(key, def) {
  const n = Number.parseInt(process.env[key] ?? '', 10);
  return Number.isFinite(n) ? n : def;
}
export function envList(key, def = []) {
  const v = process.env[key];
  if (!v) return def;
  const list = v.split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : def;
}

/**
 * Menolak start bila secret masih default/lemah. Aktif hanya jika ENFORCE_SECRETS=true
 * (wajib diaktifkan pada deployment publik; dimatikan untuk pengembangan lokal).
 */
export function assertSecrets(map) {
  if (env('ENFORCE_SECRETS') !== 'true') return;
  const weak = Object.entries(map)
    .filter(([, v]) => !v || String(v).length < 12 || /change|example|password|dev-|secret123/i.test(String(v)))
    .map(([k]) => k);
  if (weak.length) throw new Error(`ENFORCE_SECRETS aktif, tetapi nilai berikut kosong/lemah/default: ${weak.join(', ')}`);
}

// ---- Log JSON satu baris ----
export function log(level, msg, extra = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, service: SERVICE, instance: INSTANCE, msg, ...extra });
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
}

// ---- Error ----
export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function sendError(res, req, status, code, message, details) {
  const error = { code, message };
  if (details !== undefined) error.details = details;
  error.requestId = req?.id;
  res.status(status).json({ error });
}

export const wrap = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

/** Validasi dengan skema zod; gagal -> 400 VALIDATION_ERROR dengan rincian per field. */
export function validate(schema, data) {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  throw new HttpError(
    400,
    'VALIDATION_ERROR',
    'Input tidak valid',
    r.error.issues.map((i) => ({ field: i.path.join('.') || '(root)', message: i.message })),
  );
}

// ---- App Express ----
export function createApp(name) {
  const app = express();
  app.disable('x-powered-by');
  const tp = env('TRUST_PROXY');
  if (tp) app.set('trust proxy', /^\d+$/.test(tp) ? Number(tp) : tp === 'true' ? true : tp);
  app.use(helmet());
  app.use((req, res, next) => {
    const incoming = req.get('x-request-id');
    req.id = incoming && /^[\w.-]{1,64}$/.test(incoming) ? incoming : crypto.randomUUID();
    res.setHeader('X-Request-Id', req.id);
    res.setHeader('X-Instance-Id', INSTANCE);
    if (env('LOG_REQUESTS', 'true') !== 'false' && req.path !== '/health') {
      const t0 = process.hrtime.bigint();
      res.on('finish', () => {
        log('info', 'request', {
          requestId: req.id, method: req.method, path: req.originalUrl.split('?')[0],
          status: res.statusCode, ms: Number((process.hrtime.bigint() - t0) / 1_000_000n), service_name: name,
        });
      });
    }
    next();
  });
  return app;
}

/** Pasang 404 dan penangan error terakhir. Panggil setelah semua route. */
export function finishApp(app) {
  app.use((req, res) => sendError(res, req, 404, 'NOT_FOUND', 'Resource tidak ditemukan'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) return res.destroy();
    if (err instanceof HttpError) return sendError(res, req, err.status, err.code, err.message, err.details);
    if (err?.type === 'entity.too.large') return sendError(res, req, 413, 'PAYLOAD_TOO_LARGE', 'Body terlalu besar');
    if (err?.type === 'entity.parse.failed') return sendError(res, req, 400, 'BAD_REQUEST', 'Body tidak dapat dibaca');
    log('error', 'error tak terduga', { requestId: req.id, error: err?.message, stack: err?.stack });
    sendError(res, req, 500, 'INTERNAL_ERROR', 'Terjadi kesalahan internal');
  });
}

export function listen(app, defaultPort) {
  const port = envInt('PORT', defaultPort);
  const server = app.listen(port, '0.0.0.0', () => log('info', 'service berjalan', { port }));
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  const stop = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return server;
}
