// Event Service: katalog event (REST + GraphQL) dan pemilik stok tiket.
// Endpoint /internal/reservations hanya menerima token client_credentials (role service, scope inventory:write).
import fs from 'node:fs';
import express from 'express';
import { z } from 'zod';
import { buildSchema, parse, validate as gqlValidate, execute, specifiedRules, GraphQLError, Kind } from 'graphql';
import { setService, createApp, finishApp, listen, env, envInt, log, wrap, validate, HttpError } from './lib/common.js';
import { createPool, waitForDb, migrate, withTx } from './lib/db.js';
import { createVerifier, authenticate, requireScopes, requireRole } from './lib/security.js';
setService('event-service');

const STATUSES = ['UPCOMING', 'ON_SALE', 'ENDED', 'CANCELLED'];
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

// ---- Skema validasi (dipakai REST dan GraphQL) ----
const boolLike = z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]);
const listSchema = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  city: z.string().trim().min(1).max(100).optional(),
  category: z.string().trim().min(1).max(50).optional(),
  status: z.enum(STATUSES).optional(),
  onlyAvailable: boolLike.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
});

const eventInput = z.object({
  name: z.string().trim().min(1).max(200),
  artist: z.string().trim().min(1).max(200),
  venue: z.string().trim().min(1).max(200),
  city: z.string().trim().min(1).max(100),
  category: z.string().trim().min(1).max(50),
  description: z.string().max(2000).nullish(),
  startsAt: z.iso.datetime({ offset: true }),
  status: z.enum(STATUSES).nullish(),
  ticketTypes: z.array(z.object({
    name: z.string().trim().min(1).max(100),
    price: z.number().min(0).max(1_000_000_000),
    total: z.number().int().min(1).max(1_000_000),
  })).min(1).max(10),
}).refine((e) => new Set(e.ticketTypes.map((t) => t.name.toLowerCase())).size === e.ticketTypes.length, {
  message: 'Nama jenis tiket harus unik', path: ['ticketTypes'],
});

const reservationSchema = z.object({
  orderId: z.uuid(),
  ticketTypeId: z.uuid(),
  quantity: z.number().int().min(1).max(100),
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

/**
 * Reservasi stok atomik dan idempoten.
 *  - INSERT reservasi (kunci order_id) + UPDATE ... WHERE available >= qty dalam satu transaksi.
 *  - Permintaan bersamaan pada baris stok yang sama diserialkan oleh row lock PostgreSQL -> tidak ada oversell.
 *  - Order yang sama dikirim ulang (retry/worker) -> hasil sama, stok tidak berkurang lagi.
 */
async function reserve({ orderId, ticketTypeId, quantity }) {
  return withTx(pool, async (c) => {
    const tt = (await c.query('SELECT event_id, price FROM events.ticket_types WHERE id=$1', [ticketTypeId])).rows[0];
    if (!tt) throw new HttpError(404, 'TICKET_TYPE_NOT_FOUND', 'Jenis tiket tidak ditemukan');
    const ins = await c.query(
      'INSERT INTO events.reservations(order_id, ticket_type_id, quantity) VALUES ($1,$2,$3) ON CONFLICT (order_id) DO NOTHING RETURNING order_id',
      [orderId, ticketTypeId, quantity],
    );
    const created = ins.rowCount === 1;
    if (created) {
      const upd = await c.query('UPDATE events.ticket_types SET available = available - $2 WHERE id=$1 AND available >= $2', [ticketTypeId, quantity]);
      if (upd.rowCount === 0) throw new HttpError(409, 'INSUFFICIENT_STOCK', 'Stok tiket tidak mencukupi'); // ROLLBACK membatalkan reservasi
    }
    return { created, body: { orderId, eventId: tt.event_id, ticketTypeId, quantity, unitPrice: Number(tt.price) } };
  });
}

// ---- GraphQL ----
const schema = buildSchema(fs.readFileSync(new URL('../docs/schema.graphql', import.meta.url), 'utf8'));

const gqlError = (message, code, extra = {}) => new GraphQLError(message, { extensions: { code, ...extra } });

/** Membatasi kedalaman dan jumlah field (alias ikut dihitung) agar query mahal ditolak sebelum dieksekusi. */
function limitsRule(context) {
  const LIMIT = Symbol('limit');
  return {
    Document(doc) {
      const frags = new Map();
      for (const d of doc.definitions) if (d.kind === Kind.FRAGMENT_DEFINITION) frags.set(d.name.value, d);
      let fields = 0;
      let maxDepth = 0;
      const walk = (set, depth, stack) => {
        for (const sel of set.selections) {
          if (sel.kind === Kind.FIELD) {
            if (sel.name.value.startsWith('__')) continue; // introspeksi tidak dihitung
            fields += 1;
            maxDepth = Math.max(maxDepth, depth + 1);
            if (fields > MAX_FIELDS || maxDepth > MAX_DEPTH) throw LIMIT;
            if (sel.selectionSet) walk(sel.selectionSet, depth + 1, stack);
          } else if (sel.kind === Kind.INLINE_FRAGMENT) {
            walk(sel.selectionSet, depth, stack);
          } else if (sel.kind === Kind.FRAGMENT_SPREAD) {
            const f = frags.get(sel.name.value);
            if (f && !stack.has(f.name.value)) walk(f.selectionSet, depth, new Set([...stack, f.name.value]));
          }
        }
      };
      try {
        for (const op of doc.definitions) if (op.kind === Kind.OPERATION_DEFINITION) walk(op.selectionSet, 0, new Set());
      } catch (e) {
        if (e !== LIMIT) throw e;
        context.reportError(gqlError(`Query terlalu kompleks (maksimum kedalaman ${MAX_DEPTH}, maksimum ${MAX_FIELDS} field)`, 'QUERY_TOO_COMPLEX'));
      }
      return false;
    },
  };
}

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
  const { created, body } = await reserve(validate(reservationSchema, req.body ?? {}));
  res.status(created ? 201 : 200).json(body);
}));

finishApp(app);
listen(app, 4001);
