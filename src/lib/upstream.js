import dns from 'node:dns/promises';
import { HttpError, log } from './common.js';

/**
 * Service discovery + client-side load balancing.
 *  - discovery 'static': daftar URL apa adanya (mis. URL publik di Render).
 *  - discovery 'dns'   : nama host di-resolve ke SEMUA alamat A (Docker/Compose memberi satu
 *                        alamat per replika), di-refresh berkala sehingga replika baru
 *                        otomatis ditemukan dan replika yang mati dikeluarkan.
 *  - Algoritma round-robin di antara target yang sehat (health check aktif + pasif).
 */
export class UpstreamPool {
  constructor(name, baseUrls, { discovery = 'static', refreshMs = 5000, healthPath = '/health' } = {}) {
    if (!baseUrls.length) throw new Error(`Upstream ${name}: URL belum diatur`);
    this.name = name;
    this.bases = baseUrls.map((u) => u.replace(/\/+$/, ''));
    this.discovery = discovery;
    this.refreshMs = refreshMs;
    this.healthPath = healthPath;
    this.targets = new Map();
    this.cursor = 0;
    if (discovery !== 'dns') for (const b of this.bases) this.targets.set(b, { url: b, healthy: true });
  }

  async start() {
    await this.refresh();
    setInterval(() => this.refresh().catch(() => {}), this.refreshMs).unref();
    return this;
  }

  async refresh() {
    if (this.discovery === 'dns') {
      const found = new Set();
      for (const base of this.bases) {
        const u = new URL(base);
        try {
          const addrs = await dns.lookup(u.hostname, { all: true, family: 4 });
          for (const a of addrs) found.add(`${u.protocol}//${a.address}:${u.port || (u.protocol === 'https:' ? 443 : 80)}`);
        } catch (e) {
          log('warn', 'dns lookup gagal', { upstream: this.name, host: u.hostname, error: e.code || e.message });
        }
      }
      if (found.size) {
        for (const url of found) {
          if (!this.targets.has(url)) {
            this.targets.set(url, { url, healthy: false });
            log('info', 'replika ditemukan', { upstream: this.name, target: url });
          }
        }
        for (const url of [...this.targets.keys()]) {
          if (!found.has(url)) {
            this.targets.delete(url);
            log('info', 'replika dihapus', { upstream: this.name, target: url });
          }
        }
      }
    }
    await Promise.all(
      [...this.targets.values()].map(async (t) => {
        try {
          const r = await fetch(t.url + this.healthPath, { signal: AbortSignal.timeout(1500) });
          t.healthy = r.ok;
        } catch {
          t.healthy = false;
        }
      }),
    );
  }

  /** Round-robin di antara target sehat; jika semua dianggap mati, tetap coba semuanya. */
  pick(exclude = new Set()) {
    const all = [...this.targets.values()].filter((t) => !exclude.has(t.url));
    if (!all.length) return null;
    const healthy = all.filter((t) => t.healthy);
    const list = healthy.length ? healthy : all;
    return list[this.cursor++ % list.length];
  }

  markFailed(target) {
    if (target) target.healthy = false;
  }

  size() {
    return this.targets.size;
  }

  snapshot() {
    return { name: this.name, discovery: this.discovery, targets: [...this.targets.values()].map((t) => ({ url: t.url, healthy: t.healthy })) };
  }

  /** Request service-ke-service dengan failover ke replika lain saat koneksi gagal. */
  async request(method, path, { json, form, headers = {}, timeoutMs = 4000, attempts = 3 } = {}) {
    const tried = new Set();
    let lastError;
    for (let i = 0; i < attempts; i++) {
      const target = this.pick(tried);
      if (!target) break;
      tried.add(target.url);
      try {
        const init = { method, headers: { ...headers }, signal: AbortSignal.timeout(timeoutMs) };
        if (json !== undefined) {
          init.body = JSON.stringify(json);
          init.headers['content-type'] = 'application/json';
        } else if (form) {
          init.body = new URLSearchParams(form).toString();
          init.headers['content-type'] = 'application/x-www-form-urlencoded';
        }
        const res = await fetch(target.url + path, init);
        const text = await res.text();
        let body = null;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          body = text;
        }
        return { status: res.status, body, headers: res.headers, target: target.url };
      } catch (e) {
        lastError = e;
        this.markFailed(target);
        log('warn', 'upstream gagal, coba replika lain', { upstream: this.name, target: target.url, error: e.code || e.name });
      }
    }
    throw new HttpError(503, 'UPSTREAM_UNAVAILABLE', `Layanan ${this.name} tidak tersedia`, lastError ? { reason: lastError.name } : undefined);
  }
}

export function poolFromEnv(name, urlList, discovery) {
  return new UpstreamPool(name, urlList, { discovery });
}
