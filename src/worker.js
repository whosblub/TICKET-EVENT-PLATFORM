// Worker: mengonsumsi antrian order, memproses reservasi stok ke Event Service, dan memulihkan order
// PENDING yang terlewat (sweeper). Dijalankan sebagai proses terpisah dari Order Service.
import { Worker, Queue } from 'bullmq';
import { setService, createApp, finishApp, env, envInt, envList, log, assertSecrets } from './lib/common.js';
import { createPool, waitForDb } from './lib/db.js';
import { createServiceTokenProvider } from './lib/security.js';
import { UpstreamPool } from './lib/upstream.js';
import { migrateOrders, createOrderProcessor } from './lib/orders.js';
import { ORDER_QUEUE, redisConnection, defaultJobOptions } from './lib/queue.js';
setService('worker');

const DISCOVERY = env('DISCOVERY', 'static');
const CONCURRENCY = envInt('WORKER_CONCURRENCY', 1); // 1 = order diproses satu per satu
const SWEEP_INTERVAL_MS = envInt('ORDER_SWEEP_INTERVAL_MS', 30_000);
const STALE_SECONDS = envInt('ORDER_STALE_SECONDS', 60);

assertSecrets({ ORDER_SERVICE_CLIENT_SECRET: env('ORDER_SERVICE_CLIENT_SECRET') });

const pool = createPool(env('DATABASE_URL'));
await waitForDb(pool);
await migrateOrders(pool); // aman dijalankan bersamaan dengan Order Service (advisory lock)

const eventPool = await new UpstreamPool('event-service', envList('EVENT_SERVICE_URLS', ['http://event-service:4001']), { discovery: DISCOVERY }).start();
const authPool = await new UpstreamPool('auth-service', envList('AUTH_SERVICE_URLS', ['http://auth-service:4000']), { discovery: DISCOVERY }).start();
const getServiceToken = createServiceTokenProvider({
  authPool,
  clientId: 'order-service',
  clientSecret: env('ORDER_SERVICE_CLIENT_SECRET', ''),
  scope: 'inventory:write',
});
const processOrder = createOrderProcessor({ pool, eventPool, getServiceToken });

// ---- Consumer ----
async function handleJob(job) {
  const { orderId } = job.data;
  const order = (await pool.query('SELECT * FROM orders.orders WHERE id=$1', [orderId])).rows[0];
  if (!order) return { skipped: 'ORDER_NOT_FOUND' };
  if (order.status !== 'PENDING') return { skipped: order.status }; // sudah diproses (job ganda / retry)
  const done = await processOrder(order); // melempar error bila stok belum dapat dipastikan -> retry
  log('info', 'order diproses', { orderId, status: done.status, reason: done.reason, attempt: job.attemptsMade + 1 });
  return { status: done.status };
}

const worker = new Worker(ORDER_QUEUE, handleJob, {
  connection: redisConnection(env('REDIS_URL'), { maxRetriesPerRequest: null }),
  concurrency: CONCURRENCY,
});
worker.on('error', (e) => log('warn', 'worker error', { error: e.message }));
worker.on('failed', async (job, err) => {
  if (!job) return;
  const attempts = job.opts.attempts ?? 1;
  const exhausted = job.attemptsMade >= attempts;
  log(exhausted ? 'error' : 'warn', exhausted ? 'job gagal permanen (dead-letter)' : 'job gagal, akan dicoba ulang', {
    orderId: job.data.orderId, attempt: job.attemptsMade, of: attempts, error: err?.message,
  });
  if (exhausted) {
    // Job tetap tersimpan di set "failed" BullMQ (dead-letter queue) untuk diperiksa; pesanan tidak dibiarkan PENDING selamanya.
    await pool.query(
      `UPDATE orders.orders SET status='REJECTED', reason='PROCESSING_FAILED', updated_at=now() WHERE id=$1 AND status='PENDING'`,
      [job.data.orderId],
    ).catch((e) => log('error', 'gagal menandai order', { error: e.message }));
  }
});

// ---- Sweeper: antrikan ulang order PENDING yang lama tidak diproses (mis. Redis sempat mati saat publish) ----
const producer = new Queue(ORDER_QUEUE, { connection: redisConnection(env('REDIS_URL')), defaultJobOptions: defaultJobOptions() });
producer.on('error', (e) => log('warn', 'queue error', { error: e.message }));
let sweeping = false;
async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    const rows = (await pool.query(
      `SELECT id FROM orders.orders WHERE status='PENDING' AND updated_at < now() - make_interval(secs => $1) ORDER BY created_at LIMIT 200`,
      [STALE_SECONDS],
    )).rows;
    for (const r of rows) await producer.add('process-order', { orderId: r.id }, { jobId: r.id }); // jobId sama -> tidak ganda
    if (rows.length) log('info', 'sweeper mengantrikan ulang order PENDING', { count: rows.length });
  } catch (e) {
    log('warn', 'sweeper gagal', { error: e.message });
  } finally {
    sweeping = false;
  }
}
const sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
sweepTimer.unref();

// ---- /health opsional: aktif bila PORT diatur (mis. Render Web Service). Di Docker Compose tidak dipakai. ----
if (process.env.PORT) {
  const app = createApp('worker');
  app.get('/health', (req, res) => res.json({ status: 'ok', service: 'worker', running: worker.isRunning() }));
  finishApp(app);
  app.listen(envInt('PORT', 4003), '0.0.0.0', () => log('info', 'health endpoint aktif', { port: envInt('PORT', 4003) }));
}

async function shutdown() {
  log('info', 'worker berhenti: menyelesaikan job yang berjalan');
  clearInterval(sweepTimer);
  await worker.close();
  await producer.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
log('info', 'worker berjalan', { queue: ORDER_QUEUE, concurrency: CONCURRENCY });
