// Event Service: katalog event (REST + GraphQL) dan pemilik stok tiket.
// Endpoint /internal/reservations hanya menerima token client_credentials (role service, scope inventory:write).
import fs from 'node:fs';
import express from 'express';
import { z } from 'zod';
import { buildSchema, parse, validate as gqlValidate, execute, specifiedRules, GraphQLError } from 'graphql';
import { setService, createApp, finishApp, listen, env, envInt, log, wrap, validate, HttpError } from './lib/common.js';
import { createPool, waitForDb, migrate, withTx } from './lib/db.js';
import { createVerifier, authenticate, requireScopes, requireRole } from './lib/security.js';
import { listSchema, eventInput, reservationSchema } from './lib/schemas.js';
import { reserve } from './lib/inventory.js';
import { createLimitsRule, gqlError } from './lib/graphql-limits.js';
setService('event-service');

const MAX_DEPTH = envInt('GRAPHQL_MAX_DEPTH', 5);
const MAX_FIELDS = envInt('GRAPHQL_MAX_FIELDS', 100);

// ---- Database + data awal ----
const pool = createPool(env('DATABASE_URL'));
await waitForDb(pool);

const SEED = [
  { id: 'a0000000-0000-4000-8000-000000000001', name: 'Konser Uji Beban (stok terbatas)', artist: 'Band Uji', venue: 'Istora Senayan', city: 'Jakarta', category: 'konser', startsAt: '2027-03-15T19:00:00+07:00', description: 'Event khusus pengujian pemesanan bersamaan: stok hanya 10 tiket.',
    tickets: [{ id: 'b0000000-0000-4000-8000-000000000001', name: 'Reguler', price: 150000, total: 10 }] },
  { id: 'a0000000-0000-4000-8000-000000000002', name: 'Jakarta Rock Festival', artist: 'Various Artists', venue: 'GBK Madya', city: 'Jakarta', category: 'festival', startsAt: '2027-04-10T16:00:00+07:00', description: 'Festival musik rock sehari penuh.',
    tickets: [{ id: 'b0000000-0000-4000-8000-000000000002', name: 'Festival', price: 350000, total: 500 }, { id: 'b0000000-0000-4000-8000-000000000003', name: 'VIP', price: 900000, total: 100 }] },
  { id: 'a0000000-0000-4000-8000-000000000003', name: 'Malam Jazz Senayan', artist: 'Trio Jazz', venue: 'Plaza Senayan Hall', city: 'Jakarta', category: 'konser', startsAt: '2027-05-02T20:00:00+07:00', description: 'Konser jazz intim.',
    tickets: [{ id: 'b0000000-0000-4000-8000-000000000004', name: 'Reguler', price: 250000, total: 200 }] },
  { id: 'a0000000-0000-4000-8000-000000000004', name: 'Surabaya Pop Night', artist: 'Penyanyi Pop', venue: 'Grand City Convention', city: 'Surabaya', category: 'konser', startsAt: '2027-06-20T19:30:00+07:00', description: 'Malam pop bersama penyanyi favorit.',
    tickets: [{ id: 'b0000000-0000-4000-8000-000000000005', name: 'Reguler', price: 200000, total: 300 }, { id: 'b0000000-0000-4000-8000-000000000006', name: 'VIP', price: 600000, total: 50 }] },
  { id: 'a0000000-0000-4000-8000-000000000005', name: 'Bandung Indie Fest', artist: 'Kolektif Indie', venue: 'Sasana Budaya Ganesha', city: 'Bandung', category: 'festival', startsAt: '2027-08-08T15:00:00+07:00', description: 'Festival musik indie.',
    tickets: [{ id: 'b0000000-0000-4000-8000-000000000007', name: 'Reguler', price: 120000, total: 400 }] },
];

await migrate(pool, 7002, async (c) => {
  await c.query('CREATE SCHEMA IF NOT EXISTS events');
  await c.query(`CREATE TABLE IF NOT EXISTS events.events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL, artist text NOT NULL, venue text NOT NULL, city text NOT NULL, category text NOT NULL,
    description text,
    starts_at timestamptz NOT NULL,
    status text NOT NULL DEFAULT 'ON_SALE' CHECK (status IN ('UPCOMING','ON_SALE','ENDED','CANCELLED')),
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await c.query(`CREATE TABLE IF NOT EXISTS events.ticket_types (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id uuid NOT NULL REFERENCES events.events(id) ON DELETE CASCADE,
    name text NOT NULL,
    price numeric(12,2) NOT NULL CHECK (price >= 0),
    total int NOT NULL CHECK (total >= 0),
    available int NOT NULL CHECK (available >= 0 AND available <= total),
    UNIQUE (event_id, name)
  )`);
  // Reservasi berkunci order_id: memanggil ulang untuk order yang sama tidak mengurangi stok dua kali.
  await c.query(`CREATE TABLE IF NOT EXISTS events.reservations (
    order_id uuid PRIMARY KEY,
    ticket_type_id uuid NOT NULL REFERENCES events.ticket_types(id),
    quantity int NOT NULL CHECK (quantity > 0),
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await c.query('CREATE INDEX IF NOT EXISTS idx_events_city ON events.events(lower(city))');
  await c.query('CREATE INDEX IF NOT EXISTS idx_events_starts ON events.events(starts_at)');
  await c.query('CREATE INDEX IF NOT EXISTS idx_tt_event ON events.ticket_types(event_id)');
  for (const e of SEED) {
    await c.query(
      `INSERT INTO events.events(id, name, artist, venue, city, category, description, starts_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
      [e.id, e.name, e.artist, e.venue, e.city, e.category, e.description, e.startsAt],
    );
    for (const t of e.tickets) {
      await c.query(
        `INSERT INTO events.ticket_types(id, event_id, name, price, total, available) VALUES ($1,$2,$3,$4,$5,$5) ON CONFLICT (id) DO NOTHING`,
        [t.id, e.id, t.name, t.price, t.total],
      );
    }
  }
});

// ---- Akses data ----
const escapeLike = (s) => s.replace(/[\\%_]/g, '\\$&');

const mapTicket = (t) => ({ id: t.id, name: t.name, price: Number(t.price), total: t.total, available: t.available });
function mapEvent(r, tts) {
  const prices = tts.map((t) => Number(t.price));
  return {
    id: r.id, name: r.name, artist: r.artist, venue: r.venue, city: r.city, category: r.category,
    description: r.description, startsAt: r.starts_at.toISOString(), status: r.status,
    minPrice: prices.length ? Math.min(...prices) : null,
    totalAvailable: tts.reduce((n, t) => n + t.available, 0),
    ticketTypes: tts.map(mapTicket),
  };
}

async function listEvents(f, db = pool) {
  const where = [];
  const params = [];
  if (f.q) { params.push(`%${escapeLike(f.q)}%`); where.push(`(e.name ILIKE $${params.length} OR e.artist ILIKE $${params.length})`); }
  if (f.city) { params.push(f.city); where.push(`lower(e.city) = lower($${params.length})`); }
  if (f.category) { params.push(f.category); where.push(`lower(e.category) = lower($${params.length})`); }
  if (f.status) { params.push(f.status); where.push(`e.status = $${params.length}`); }
  if (f.onlyAvailable) where.push('EXISTS (SELECT 1 FROM events.ticket_types t WHERE t.event_id = e.id AND t.available > 0)');
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await db.query(`SELECT count(*)::int AS n FROM events.events e ${w}`, params)).rows[0].n;
  const rows = (await db.query(
    `SELECT e.* FROM events.events e ${w} ORDER BY e.starts_at, e.id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, f.limit, f.offset],
  )).rows;
  const tts = rows.length
    ? (await db.query('SELECT * FROM events.ticket_types WHERE event_id = ANY($1::uuid[]) ORDER BY price, name', [rows.map((r) => r.id)])).rows
    : [];
  const items = rows.map((r) => mapEvent(r, tts.filter((t) => t.event_id === r.id)));
  return { items, total, limit: f.limit, offset: f.offset };
}

async function getEvent(id, db = pool) {
  const r = (await db.query('SELECT * FROM events.events WHERE id=$1', [id])).rows[0];
  if (!r) return null;
  const tts = (await db.query('SELECT * FROM events.ticket_types WHERE event_id=$1 ORDER BY price, name', [id])).rows;
  return mapEvent(r, tts);
}

async function createEvent(input) {
  return withTx(pool, async (c) => {
    const e = (await c.query(
      `INSERT INTO events.events(name, artist, venue, city, category, description, starts_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [input.name, input.artist, input.venue, input.city, input.category, input.description ?? null, input.startsAt, input.status ?? 'ON_SALE'],
    )).rows[0];
    for (const t of input.ticketTypes) {
      await c.query('INSERT INTO events.ticket_types(event_id, name, price, total, available) VALUES ($1,$2,$3,$4,$4)', [e.id, t.name, t.price, t.total]);
    }
    return getEvent(e.id, c);
  });
}

// ---- GraphQL ----
const schema = buildSchema(fs.readFileSync(new URL('../docs/schema.graphql', import.meta.url), 'utf8'));

/** Membatasi kedalaman dan jumlah field (alias ikut dihitung) agar query mahal ditolak sebelum dieksekusi. */
const limitsRule = createLimitsRule({ maxDepth: MAX_DEPTH, maxFields: MAX_FIELDS });

const cleanArgs = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));

const rootValue = {
  events: ({ filter, limit, offset }) => listEvents(validate(listSchema, cleanArgs({ ...(filter ?? {}), limit, offset }))),
  event: async ({ id }) => {
    const uuid = validate(z.uuid(), id);
    return getEvent(uuid);
  },
  createEvent: async ({ input }, ctx) => {
    if (ctx.user?.role !== 'admin' || !ctx.user.scopes.includes('events:write')) {
      throw gqlError('Hanya admin yang dapat membuat event', 'FORBIDDEN');
    }
    return createEvent(validate(eventInput, JSON.parse(JSON.stringify(input)))); // salin: argumen GraphQL berprototipe null
  },
};

/** Pesan error yang aman: error tak terduga disamarkan, error yang kita lempar dipertahankan. */
function maskError(e) {
  const o = e.originalError;
  if (!o) return e; // error validasi/parse milik GraphQL sendiri
  if (o instanceof GraphQLError) return new GraphQLError(o.message, { path: e.path, extensions: o.extensions });
  if (o instanceof HttpError) {
    const code = o.code === 'VALIDATION_ERROR' ? 'BAD_USER_INPUT' : o.code;
    return new GraphQLError(o.message, { path: e.path, extensions: { code, details: o.details } });
  }
  log('error', 'graphql resolver error', { error: o.message });
  return new GraphQLError('Terjadi kesalahan internal', { path: e.path, extensions: { code: 'INTERNAL_ERROR' } });
}

// ---- App ----
const app = createApp('event-service');
const verify = createVerifier({
  jwksUrl: env('AUTH_JWKS_URL', 'http://auth-service:4000/.well-known/jwks.json'),
  issuer: env('AUTH_ISSUER', 'ticketing-auth'),
  audience: env('AUTH_AUDIENCE', 'ticketing-api'),
});
const auth = authenticate(verify);

app.get('/health', wrap(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok', service: 'event-service' });
}));

app.get('/events', auth, requireScopes('events:read'), wrap(async (req, res) => {
  const q = validate(listSchema, req.query);
  const { items, total, limit, offset } = await listEvents(q);
  res.json({ data: items.map(({ ticketTypes, ...summary }) => summary), page: { limit, offset, total } });
}));

app.get('/events/:id', auth, requireScopes('events:read'), wrap(async (req, res) => {
  const id = validate(z.uuid(), req.params.id);
  const e = await getEvent(id);
  if (!e) throw new HttpError(404, 'EVENT_NOT_FOUND', 'Event tidak ditemukan');
  res.json(e);
}));

app.post('/events', auth, requireRole('admin'), requireScopes('events:write'), express.json({ limit: '50kb' }), wrap(async (req, res) => {
  const e = await createEvent(validate(eventInput, req.body ?? {}));
  res.status(201).location(`/events/${e.id}`).json(e);
}));

app.post('/graphql', auth, requireScopes('events:read'), express.json({ limit: '50kb' }), wrap(async (req, res) => {
  const { query, variables, operationName } = req.body ?? {};
  const bad = (status, message, code) => res.status(status).json({ errors: [{ message, extensions: { code } }] });
  if (typeof query !== 'string' || !query.trim()) return bad(400, 'Field "query" wajib berupa string', 'BAD_REQUEST');
  if (variables != null && (typeof variables !== 'object' || Array.isArray(variables))) return bad(400, '"variables" harus berupa objek', 'BAD_REQUEST');
  let document;
  try {
    document = parse(query);
  } catch (e) {
    return res.status(400).json({ errors: [{ message: e.message, extensions: { code: 'GRAPHQL_PARSE_FAILED' } }] });
  }
  const errors = gqlValidate(schema, document, [...specifiedRules, limitsRule]);
  if (errors.length) return res.status(400).json({ errors: errors.map((e) => e.toJSON()) });
  const result = await execute({ schema, document, rootValue, contextValue: { user: req.user }, variableValues: variables ?? undefined, operationName });
  if (result.errors) result.errors = result.errors.map((e) => maskError(e).toJSON());
  res.status(200).json(result);
}));

app.post('/internal/reservations', auth, requireRole('service'), requireScopes('inventory:write'), express.json({ limit: '5kb' }), wrap(async (req, res) => {
  const { created, body } = await reserve(pool, validate(reservationSchema, req.body ?? {}));
  res.status(created ? 201 : 200).json(body);
}));

finishApp(app);
listen(app, 4001);