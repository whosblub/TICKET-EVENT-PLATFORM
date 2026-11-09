// Antarmuka web sederhana untuk Platform Tiket (Kelompok B).
// Hanya memakai API publik lewat gateway (same-origin). Semua teks dari server disisipkan lewat
// textContent (tanpa innerHTML) sehingga aman dari XSS.
'use strict';
(() => {
  const SESSION_KEY = 'ticketing.session';
  const TICKET_INFO_KEY = 'ticketing.tickets';
  const CLIENT_ID = 'ticketing-web';
  const POLL_MS = 2500;

  const $ = (sel) => document.querySelector(sel);
  const rupiah = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 });
  const dateFmt = new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short' });

  const REASONS = {
    INSUFFICIENT_STOCK: 'Stok tiket habis',
    TICKET_TYPE_NOT_FOUND: 'Jenis tiket tidak ditemukan',
    PROCESSING_FAILED: 'Gagal diproses (layanan stok tidak tersedia)',
  };
  const STATUS_LABEL = { PENDING: 'Menunggu', CONFIRMED: 'Berhasil', REJECTED: 'Ditolak' };

  // ---------- util DOM ----------
  function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === false || v == null) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  let toastTimer;
  function toast(message, type = '') {
    const t = $('#toast');
    t.textContent = message;
    t.className = `show ${type}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = ''; }, type === 'err' ? 6000 : 3500);
  }

  // ---------- sesi ----------
  let session = loadSession();
  function loadSession() {
    try {
      const s = JSON.parse(sessionStorage.getItem(SESSION_KEY));
      if (s && s.token && s.exp > Date.now()) return s;
    } catch { /* abaikan */ }
    return null;
  }
  function saveSession(s) {
    session = s;
    try {
      if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
      else sessionStorage.removeItem(SESSION_KEY);
    } catch { /* abaikan */ }
  }

  // nama event/tiket untuk tampilan "Pesanan saya" (API pesanan hanya mengembalikan id)
  let ticketInfo = {};
  try { ticketInfo = JSON.parse(sessionStorage.getItem(TICKET_INFO_KEY)) || {}; } catch { ticketInfo = {}; }
  function rememberTicket(id, info) {
    ticketInfo[id] = info;
    try { sessionStorage.setItem(TICKET_INFO_KEY, JSON.stringify(ticketInfo)); } catch { /* abaikan */ }
  }

  // ---------- klien API ----------
  class ApiError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
  }

  function parseError(status, data, headers) {
    let code = `HTTP_${status}`;
    let message = `Permintaan gagal (HTTP ${status})`;
    if (data && typeof data.error === 'string') { // format OAuth2 (RFC 6749)
      code = data.error;
      message = data.error === 'invalid_grant' ? 'Email atau password salah' : (data.error_description || data.error);
    } else if (data?.error?.message) {
      code = data.error.code || code;
      message = data.error.message;
      const d = data.error.details;
      if (Array.isArray(d) && d.length) message += `: ${d.map((x) => [x.field, x.message].filter(Boolean).join(' ')).join('; ')}`;
    }
    if (status === 429) {
      const wait = Number(headers.get('retry-after'));
      message = `Terlalu banyak permintaan${wait ? `, coba lagi dalam ${wait} detik` : ', coba lagi sebentar lagi'}.`;
    }
    return new ApiError(status, code, message);
  }

  async function api(method, path, { json, form, headers = {}, auth = true } = {}) {
    if (auth && session && session.exp <= Date.now()) {
      logout('Sesi berakhir, silakan masuk lagi.');
      throw new ApiError(401, 'SESSION_EXPIRED', 'Sesi berakhir');
    }
    const h2 = { ...headers };
    let body;
    if (json !== undefined) { h2['content-type'] = 'application/json'; body = JSON.stringify(json); }
    if (form) { h2['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    if (auth && session) h2.authorization = `Bearer ${session.token}`;

    let res;
    try {
      res = await fetch(path, { method, headers: h2, body });
    } catch {
      throw new ApiError(0, 'NETWORK', 'Tidak dapat menghubungi server');
    }
    const inst = res.headers.get('x-instance-id');
    if (inst) $('#served').textContent = `Dilayani replika: ${inst}`;

    let data = null;
    const text = await res.text();
    try { data = text ? JSON.parse(text) : null; } catch { /* bukan JSON */ }

    if (!res.ok) {
      if (res.status === 401 && auth && session) {
        logout('Sesi tidak valid atau sudah berakhir, silakan masuk lagi.');
      }
      throw parseError(res.status, data, res.headers);
    }
    return { status: res.status, data, headers: res.headers };
  }

  // ---------- autentikasi ----------
  async function login(email, password) {
    const { data } = await api('POST', '/oauth/token', {
      auth: false,
      form: { grant_type: 'password', client_id: CLIENT_ID, username: email, password },
    });
    const s = { token: data.access_token, exp: Date.now() + (data.expires_in || 900) * 1000 - 5000, email, role: 'user' };
    saveSession(s);
    try {
      const me = await api('GET', '/auth/me');
      s.role = me.data.role || 'user';
      saveSession(s);
    } catch { /* role hanya hiasan */ }
  }

  function logout(message) {
    saveSession(null);
    orders = [];
    clearTimeout(pollTimer);
    render();
    if (message) toast(message, 'err');
  }

  async function submitAuth(form, fn, btnLabel) {
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = 'Memproses...';
    try {
      await fn(Object.fromEntries(new FormData(form)));
      form.reset();
      render();
      loadEvents();
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = btnLabel;
    }
  }

  $('#form-login').addEventListener('submit', (ev) => {
    ev.preventDefault();
    submitAuth(ev.target, (v) => login(v.email.trim(), v.password), 'Masuk');
  });
  $('#form-register').addEventListener('submit', (ev) => {
    ev.preventDefault();
    submitAuth(ev.target, async (v) => {
      const body = { email: v.email.trim(), password: v.password };
      if (v.name && v.name.trim()) body.name = v.name.trim();
      await api('POST', '/auth/register', { auth: false, json: body });
      await login(body.email, v.password);
      toast('Akun dibuat, selamat datang!', 'ok');
    }, 'Daftar dan masuk');
  });
  document.querySelectorAll('[data-auth-tab]').forEach((b) => b.addEventListener('click', () => {
    const which = b.dataset.authTab;
    document.querySelectorAll('[data-auth-tab]').forEach((x) => x.classList.toggle('active', x === b));
    $('#form-login').hidden = which !== 'login';
    $('#form-register').hidden = which !== 'register';
  }));
  $('#logout').addEventListener('click', () => logout());

  // ---------- tampilan utama ----------
  let currentTab = 'events';
  function render() {
    const loggedIn = !!session;
    $('#view-auth').hidden = loggedIn;
    $('#view-app').hidden = !loggedIn;
    $('#userbox').hidden = !loggedIn;
    if (loggedIn) {
      const who = $('#who');
      who.textContent = session.email;
      if (session.role === 'admin') who.append(h('span', { class: 'badge-role' }, 'admin'));
    }
  }

  function showTab(name) {
    currentTab = name;
    document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $('#panel-events').hidden = name !== 'events';
    $('#panel-orders').hidden = name !== 'orders';
    clearTimeout(pollTimer);
    if (name === 'orders') loadOrders();
    if (name === 'events') loadEvents(); // muat ulang agar stok yang tampil selalu terbaru
  }
  document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  // ---------- event ----------
  $('#form-filter').addEventListener('submit', (ev) => { ev.preventDefault(); loadEvents(); });

  async function loadEvents() {
    if (!session) return;
    const list = $('#events-list');
    list.replaceChildren(h('p', { class: 'muted' }, 'Memuat event...'));
    const f = Object.fromEntries(new FormData($('#form-filter')));
    const qs = new URLSearchParams({ limit: '50' });
    if (f.q && f.q.trim()) qs.set('q', f.q.trim());
    if (f.city && f.city.trim()) qs.set('city', f.city.trim());
    if (f.onlyAvailable) qs.set('onlyAvailable', 'true');
    try {
      const { data } = await api('GET', `/events?${qs}`);
      if (!data.data.length) {
        list.replaceChildren(h('p', { class: 'muted' }, 'Tidak ada event yang cocok.'));
        return;
      }
      list.replaceChildren(...data.data.map(eventCard));
    } catch (e) {
      if (session) list.replaceChildren(h('p', { class: 'muted' }, `Gagal memuat event: ${e.message}`));
    }
  }

  function eventCard(ev) {
    const ticketsBox = h('div', { class: 'tickets', hidden: true });
    const toggle = h('button', { type: 'button', class: 'btn small' }, 'Lihat tiket');
    let loaded = false;
    toggle.addEventListener('click', async () => {
      const open = ticketsBox.hidden;
      ticketsBox.hidden = !open;
      toggle.textContent = open ? 'Tutup' : 'Lihat tiket';
      if (open) await showTickets(ev.id, ev.name, ticketsBox, !loaded).then(() => { loaded = true; });
    });
    return h('article', { class: 'card event' },
      h('h3', {}, ev.name),
      h('div', { class: 'meta' }, `${ev.artist} - ${ev.venue}, ${ev.city}`, h('br'), dateFmt.format(new Date(ev.startsAt))),
      h('div', {},
        h('span', { class: 'chip' }, ev.category),
        h('span', { class: 'chip' }, ev.status)),
      h('p', {},
        ev.minPrice != null ? h('span', { class: 'price' }, `Mulai ${rupiah.format(ev.minPrice)}`) : null,
        h('br'),
        h('span', { class: 'muted' }, `${ev.totalAvailable} tiket tersedia`)),
      toggle,
      ticketsBox);
  }

  async function showTickets(eventId, eventName, box, firstLoad) {
    if (firstLoad) box.replaceChildren(h('span', { class: 'muted' }, 'Memuat tiket...'));
    try {
      // selalu ambil ulang agar stok terbaru yang tampil
      const { data } = await api('GET', `/events/${eventId}`);
      box.replaceChildren(...data.ticketTypes.map((tt) => {
        rememberTicket(tt.id, { event: eventName, ticket: tt.name });
        return ticketRow(tt, eventId, eventName, box);
      }));
    } catch (e) {
      if (session) box.replaceChildren(h('span', { class: 'muted' }, `Gagal memuat tiket: ${e.message}`));
    }
  }

  function ticketRow(tt, eventId, eventName, box) {
    const max = Math.min(4, tt.available);
    const qty = h('select', { 'aria-label': `Jumlah tiket ${tt.name}`, disabled: max < 1 },
      ...Array.from({ length: Math.max(max, 1) }, (_, i) => h('option', { value: String(i + 1) }, String(i + 1))));
    const buy = h('button', { type: 'button', class: 'btn small', disabled: max < 1 }, max < 1 ? 'Habis' : 'Pesan');
    buy.addEventListener('click', () => placeOrder(tt, Number(qty.value), buy, () => showTickets(eventId, eventName, box, false)));
    return h('div', { class: 'ticket' },
      h('div', { class: 'line' }, h('strong', {}, tt.name), h('span', {}, rupiah.format(tt.price))),
      h('div', { class: 'line muted' }, `Tersedia ${tt.available} dari ${tt.total}`),
      h('div', { class: 'buy' }, qty, buy));
  }

  // ---------- pemesanan ----------
  function newIdempotencyKey() {
    if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
    return `k-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  }

  async function placeOrder(tt, quantity, btn, refresh) {
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'Mengirim...';
    try {
      // Satu Idempotency-Key per klik: kalau request terkirim ulang (jaringan, klik ganda) pesanan tidak dobel.
      const r = await api('POST', '/orders', {
        json: { ticketTypeId: tt.id, quantity },
        headers: { 'idempotency-key': newIdempotencyKey() },
      });
      toast(r.status === 202 ? 'Pesanan diterima dan sedang diproses (Menunggu).' : 'Pesanan sudah pernah dibuat.', 'ok');
      showTab('orders');
    } catch (e) {
      toast(e.message, 'err');
      refresh?.();
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  // ---------- daftar pesanan ----------
  let orders = [];
  let pollTimer;
  $('#refresh-orders').addEventListener('click', () => loadOrders());

  async function loadOrders(silent = false) {
    if (!session) return;
    const box = $('#orders-list');
    if (!silent && !orders.length) box.replaceChildren(h('div', { class: 'empty' }, 'Memuat pesanan...'));
    try {
      const { data } = await api('GET', '/orders?limit=50');
      orders = data.data;
      renderOrders();
    } catch (e) {
      if (!session) return;
      if (!silent) toast(e.message, 'err');
    }
    clearTimeout(pollTimer);
    if (session && currentTab === 'orders' && orders.some((o) => o.status === 'PENDING')) {
      pollTimer = setTimeout(() => loadOrders(true), POLL_MS);
    }
  }

  function renderOrders() {
    const box = $('#orders-list');
    if (!orders.length) {
      box.replaceChildren(h('div', { class: 'empty' }, 'Belum ada pesanan. Pilih event lalu klik "Pesan".'));
      return;
    }
    const rows = orders.map((o) => {
      const info = ticketInfo[o.ticketTypeId];
      return h('tr', {},
        h('td', {}, dateFmt.format(new Date(o.createdAt))),
        h('td', { class: 'wrap' }, info ? `${info.event} - ${info.ticket}` : `Tiket ${o.ticketTypeId.slice(0, 8)}`),
        h('td', {}, String(o.quantity)),
        h('td', {}, o.totalPrice != null ? rupiah.format(o.totalPrice) : '-'),
        h('td', {}, h('span', { class: `status ${o.status}` }, STATUS_LABEL[o.status] || o.status)),
        h('td', { class: 'wrap' }, o.reason ? (REASONS[o.reason] || o.reason) : ''),
        h('td', {}, h('code', { title: o.id }, o.id.slice(0, 8))));
    });
    box.replaceChildren(h('table', {},
      h('thead', {}, h('tr', {}, ...['Waktu', 'Event / Tiket', 'Jml', 'Total', 'Status', 'Keterangan', 'ID'].map((t) => h('th', {}, t)))),
      h('tbody', {}, ...rows)));
  }

  // ---------- mulai ----------
  setInterval(() => {
    if (session && session.exp <= Date.now()) logout('Sesi berakhir (token berlaku 15 menit), silakan masuk lagi.');
  }, 15000);

  render();
  if (session) loadEvents();
})();
