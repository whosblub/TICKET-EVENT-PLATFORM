import { z } from 'zod';

export const STATUSES = ['UPCOMING', 'ON_SALE', 'ENDED', 'CANCELLED'];

const boolLike = z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]);

export const listSchema = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  city: z.string().trim().min(1).max(100).optional(),
  category: z.string().trim().min(1).max(50).optional(),
  status: z.enum(STATUSES).optional(),
  onlyAvailable: boolLike.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
});

export const eventInput = z.object({
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

export const reservationSchema = z.object({
  orderId: z.uuid(),
  ticketTypeId: z.uuid(),
  quantity: z.number().int().min(1).max(100),
});

export const createOrderSchema = (maxTickets = 4) => z.object({
  ticketTypeId: z.uuid(),
  quantity: z.number().int().min(1).max(maxTickets),
});

export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  password: z.string().min(8, 'Minimal 8 karakter').max(72, 'Maksimal 72 karakter'),
  name: z.string().trim().min(1).max(100).optional(),
});