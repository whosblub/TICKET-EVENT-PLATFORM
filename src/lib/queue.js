// Message queue: BullMQ di atas Redis. Dipakai Order Service (producer) dan Worker (consumer + sweeper).
import { Queue } from 'bullmq';
import { env, envInt, log } from './common.js';

export const ORDER_QUEUE = 'order-processing';

/** Ubah REDIS_URL (redis:// atau rediss://) menjadi opsi koneksi BullMQ. */
export function redisConnection(url, extra = {}) {
  if (!url) throw new Error('REDIS_URL belum diatur (wajib untuk message queue)');
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: u.pathname.length > 1 ? Number(u.pathname.slice(1)) : undefined,
    tls: u.protocol === 'rediss:' ? {} : undefined,
    ...extra,
  };
}

/**
 * Opsi default tiap job. Retry dengan exponential backoff (2s, 4s, 8s, 16s untuk 5 percobaan).
 * Job yang gagal setelah semua percobaan disimpan di Redis sebagai dead-letter (set "failed" BullMQ).
 */
export function defaultJobOptions() {
  return {
    attempts: envInt('ORDER_JOB_ATTEMPTS', 5),
    backoff: { type: 'exponential', delay: envInt('ORDER_JOB_BACKOFF_MS', 2000) },
    removeOnComplete: true,
    removeOnFail: { count: 1000 },
  };
}

/** Producer. jobId = orderId sehingga order yang sama tidak pernah antre dua kali. */
export function createOrderQueue(extraConnection = {}) {
  const queue = new Queue(ORDER_QUEUE, {
    connection: redisConnection(env('REDIS_URL'), extraConnection),
    defaultJobOptions: defaultJobOptions(),
  });
  queue.on('error', (e) => log('warn', 'queue error', { error: e.message }));
  return queue;
}

/**
 * Masukkan order ke antrian. Mengembalikan false (bukan melempar error) bila Redis bermasalah:
 * order sudah tersimpan PENDING di database dan akan diantrikan ulang oleh sweeper Worker.
 */
export async function enqueueOrder(queue, orderId, timeoutMs = 3000) {
  try {
    await Promise.race([
      queue.add('process-order', { orderId }, { jobId: orderId }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('enqueue timeout')), timeoutMs)),
    ]);
    return true;
  } catch (e) {
    log('warn', 'gagal memasukkan order ke antrian (akan dipulihkan sweeper)', { orderId, error: e.message });
    return false;
  }
}
