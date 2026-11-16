// Antarmuka web Platform Tiket (Kelompok B).
// Hanya memakai API publik lewat gateway (same-origin). Semua teks dari server disisipkan lewat
// textContent/createTextNode (tanpa innerHTML) dan gaya dinamis lewat CSSOM, sehingga patuh pada
// CSP gateway (script-src 'self'; style-src 'self') dan aman dari XSS.
'use strict';
(() => {
  const SESSION_KEY = 'ticketing.session';
  const NAMES_KEY = 'ticketing.names.v2';
  const THEME_KEY = 'ticketing.theme';
  const CLIENT_ID = 'ticketing-web';
  const POLL_MS = 2500;
  const EVENTS_PAGE = 12;
  const ORDERS_PAGE = 10;
  const MAX_QTY = 4; // sama dengan batas server per pesanan

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const rupiah = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 });
  const dateLong = new Intl.DateTimeFormat('id-ID', { dateStyle: 'full', timeStyle: 'short' });
  const dateShort = new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
  const monthShort = new Intl.DateTimeFormat('id-ID', { month: 'short' });
  const timeShort = new Intl.DateTimeFormat('id-ID', { timeStyle: 'short' });

  const REASONS = {
    INSUFFICIENT_STOCK: 'Stok tiket sudah habis saat pesananmu diproses.',
    TICKET_TYPE_NOT_FOUND: 'Jenis tiket tidak ditemukan.',
    EVENT_NOT_ON_SALE: 'Penjualan event ini sedang tidak dibuka.',
    PROCESSING_FAILED: 'Layanan stok sedang tidak tersedia. Coba pesan lagi sebentar lagi.',
  };
  const STATUS_LABEL = { PENDING: 'Menunggu', CONFIRMED: 'Berhasil', REJECTED: 'Ditolak' };
  const EVENT_STATUS = { ON_SALE: 'Dijual', UPCOMING: 'Segera', ENDED: 'Selesai', CANCELLED: 'Dibatalkan' };

  // ---------- util DOM ----------
  function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === false || v == null) continue;
      if (k === 'class') el.className = v;
      else if (k === 'css') for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val); // CSSOM, tidak melanggar CSP
      else if (k === 'value' || k === 'checked') el[k] = v;
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

  function uuid() {
    if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
    return `k-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  }
  const hueOf = (s) => { let n = 0; for (const c of String(s || '')) n = (n * 31 + c.charCodeAt(0)) >>> 0; return n % 6; };
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  function toast(message, type = '') {
    const box = $('#toasts');
    const t = h('div', { class: `toast ${type}` }, message);
    box.append(t);
    setTimeout(() => t.remove(), type === 'err' ? 6500 : 3800);
    while (box.children.length > 3) box.firstChild.remove();
  }

  // ---------- dialog ----------
  const dlg = $('#dlg');
  let dlgCleanup = null;
  function openDialog(node, cleanup) {
    dlgCleanup?.(); // hentikan polling/state dialog sebelumnya bila dialog diganti isinya
    $('#dlg-body').replaceChildren(node);
    dlgCleanup = cleanup || null;
    if (!dlg.open) dlg.showModal();
  }
  function closeDialog() { if (dlg.open) dlg.close(); }
  dlg.addEventListener('close', () => { dlgCleanup?.(); dlgCleanup = null; $('#dlg-body').replaceChildren(); });
  dlg.addEventListener('click', (ev) => { if (ev.target === dlg) closeDialog(); });

  function sheetHead(hue, title, ...sub) {
    return h('div', { class: `sheet-head hue-${hue}` },
      h('button', { type: 'button', class: 'sheet-close', 'aria-label': 'Tutup', onclick: closeDialog }, '\u00d7'),
      h('h2', { id: 'dlg-title' }, title),
      ...sub);
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

  // Nama event/tiket untuk tampilan pesanan (API pesanan hanya mengembalikan id).
  let names = { tickets: {}, events: {} };
  try { names = { tickets: {}, events: {}, ...JSON.parse(localStorage.getItem(NAMES_KEY)) }; } catch { /* abaikan */ }
  function saveNames() { try { localStorage.setItem(NAMES_KEY, JSON.stringify(names)); } catch { /* abaikan */ } }
  function rememberEvent(ev) {
    names.events[ev.id] = ev.name;
    for (const tt of ev.ticketTypes || []) names.tickets[tt.id] = { event: ev.name, ticket: tt.name };
    saveNames();
  }

  // ---------- klien API ----------
  class ApiError extends Error {
    constructor(status, code, message, retryAfter = 0) { super(message); this.status = status; this.code = code; this.retryAfter = retryAfter; }
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
    const wait = Number(headers.get('retry-after')) || 0;
    if (status === 429) message = `Terlalu banyak permintaan${wait ? `, coba lagi dalam ${wait} detik` : ', coba lagi sebentar lagi'}.`;
    return new ApiError(status, code, message, wait);
  }

  async function api(method, path, { json, form, headers = {}, auth = true } = {}) {
    if (auth && session && session.exp <= Date.now()) {
      logout('Sesi berakhir, silakan masuk lagi.');
      throw new ApiError(401, 'SESSION_EXPIRED', 'Sesi berakhir');
    }
    const hd = { ...headers };
    let body;
    if (json !== undefined) { hd['content-type'] = 'application/json'; body = JSON.stringify(json); }
    if (form) { hd['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    if (auth && session) hd.authorization = `Bearer ${session.token}`;

    let res;
    try {
      res = await fetch(path, { method, headers: hd, body });
    } catch {
      throw new ApiError(0, 'NETWORK', 'Tidak dapat menghubungi server. Periksa koneksi internetmu.');
    }
    const inst = res.headers.get('x-instance-id');
    if (inst) $('#served').textContent = `Dilayani replika: ${inst}`;

    let data = null;
    const text = await res.text();
    try { data = text ? JSON.parse(text) : null; } catch { /* bukan JSON */ }

    if (!res.ok) {
      if (res.status === 401 && auth && session) logout('Sesi tidak valid atau sudah berakhir, silakan masuk lagi.');
      throw parseError(res.status, data, res.headers);
    }
    return { status: res.status, data, headers: res.headers };
  }

  // ---------- tema ----------
  function effectiveDark() {
    const t = document.documentElement.dataset.theme;
    return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  }
  $('#theme-toggle').addEventListener('click', () => {
    const next = effectiveDark() ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(THEME_KEY, next); } catch { /* abaikan */ }
  });

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
    } catch { /* role hanya menentukan menu admin */ }
  }

  let warnedExpiry = false;
  function logout(message) {
    closeDialog();
    saveSession(null);
    resetState();
    warnedExpiry = false;
    if (location.hash) history.replaceState(null, '', location.pathname);
    render();
    if (message) toast(message, 'err');
  }

  function fieldErr(form, name, msg) {
    const out = $(`[data-err="${name}"]`, form);
    if (out) out.textContent = msg || '';
    const input = form.elements[name];
    if (input && input.setAttribute) { if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid'); }
  }

  function validateAuth(form, v, isRegister) {
    let ok = true;
    const email = (v.email || '').trim();
    fieldErr(form, 'email', '');
    fieldErr(form, 'password', '');
    if (!/^\S+@\S+\.\S+$/.test(email)) { fieldErr(form, 'email', 'Masukkan alamat email yang valid.'); ok = false; }
    if (!v.password) { fieldErr(form, 'password', 'Password wajib diisi.'); ok = false; }
    else if (isRegister && (v.password.length < 8 || v.password.length > 72)) { fieldErr(form, 'password', 'Password harus 8 sampai 72 karakter.'); ok = false; }
    return ok;
  }

  async function submitAuth(form, isRegister, fn, label) {
    const v = Object.fromEntries(new FormData(form));
    if (!validateAuth(form, v, isRegister)) return;
    const btn = $('button[type="submit"]', form);
    btn.disabled = true;
    btn.textContent = 'Memproses...';
    try {
      await fn(v);
      form.reset();
      afterLogin();
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  $('#form-login').addEventListener('submit', (ev) => {
    ev.preventDefault();
    submitAuth(ev.target, false, (v) => login(v.email.trim(), v.password), 'Masuk');
  });
  $('#form-register').addEventListener('submit', (ev) => {
    ev.preventDefault();
    submitAuth(ev.target, true, async (v) => {
      const body = { email: v.email.trim(), password: v.password };
      if (v.name && v.name.trim()) body.name = v.name.trim();
      await api('POST', '/auth/register', { auth: false, json: body });
      await login(body.email, v.password);
      toast('Akun dibuat, selamat datang!', 'ok');
    }, 'Buat akun dan masuk');
  });
  $$('[data-auth-tab]').forEach((b) => b.addEventListener('click', () => {
    const which = b.dataset.authTab;
    $$('[data-auth-tab]').forEach((x) => { x.classList.toggle('active', x === b); x.setAttribute('aria-selected', String(x === b)); });
    $('#form-login').hidden = which !== 'login';
    $('#form-register').hidden = which !== 'register';
  }));
  $$('.pw-toggle').forEach((b) => b.addEventListener('click', () => {
    const input = b.previousElementSibling;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    b.textContent = show ? 'Sembunyikan' : 'Lihat';
    b.setAttribute('aria-label', show ? 'Sembunyikan password' : 'Tampilkan password');
  }));
  $('#logout').addEventListener('click', () => logout());

  // ---------- tampilan & rute ----------
  const ROUTES = ['events', 'orders', 'admin'];
  let pollTimer;
  let upstreamTimer;

  function render() {
    const loggedIn = !!session;
    $('#view-auth').hidden = loggedIn;
    $('#view-app').hidden = !loggedIn;
    $('#userbox').hidden = !loggedIn;
    $('#main-nav').hidden = !loggedIn;
    $('#nav-admin').hidden = !(loggedIn && session.role === 'admin');
    if (loggedIn) {
      $('#who').textContent = session.email;
      $('#role-badge').hidden = session.role !== 'admin';
    } else {
      $('#pending-badge').hidden = true;
      document.title = 'Tiket Konser';
    }
  }

  function currentRoute() {
    const r = location.hash.replace(/^#\/?/, '').split('?')[0];
    return ROUTES.includes(r) ? r : 'events';
  }

  function route() {
    render();
    if (!session) return;
    let r = currentRoute();
    if (r === 'admin' && session.role !== 'admin') { r = 'events'; history.replaceState(null, '', '#/events'); }
    ROUTES.forEach((name) => { $(`#panel-${name}`).hidden = name !== r; });
    $$('[data-nav]').forEach((a) => { if (a.dataset.nav === r) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    clearTimeout(pollTimer);
    clearInterval(upstreamTimer);
    if (r === 'events') loadEvents();
    if (r === 'orders') loadOrders();
    if (r === 'admin') initAdmin();
    document.title = `${{ events: 'Jelajahi event', orders: 'Pesanan saya', admin: 'Admin' }[r]} | Tiket Konser`;
  }
  window.addEventListener('hashchange', route);

  function afterLogin() {
    if (!location.hash) history.replaceState(null, '', '#/events');
    route();
    refreshBadge();
  }

  // ---------- paginasi ----------
  function renderPager(el, { offset, limit, total }, onPage) {
    el.replaceChildren();
    if (total <= limit) { el.hidden = true; return; }
    el.hidden = false;
    const page = Math.floor(offset / limit) + 1;
    const pages = Math.ceil(total / limit);
    el.append(
      h('button', { type: 'button', class: 'btn small ghost', disabled: offset <= 0, onclick: () => onPage(Math.max(0, offset - limit)) }, 'Sebelumnya'),
      h('span', { class: 'muted' }, `Halaman ${page} dari ${pages}`),
      h('button', { type: 'button', class: 'btn small ghost', disabled: offset + limit >= total, onclick: () => onPage(offset + limit) }, 'Berikutnya'));
  }

  // ---------- katalog event ----------
  const evState = { offset: 0, total: 0, seq: 0 };
  const filterForm = $('#form-filter');

  const reloadEvents = debounce(() => { evState.offset = 0; loadEvents(); }, 350);
  filterForm.addEventListener('submit', (ev) => { ev.preventDefault(); evState.offset = 0; loadEvents(); });
  $$('input[type="search"], input[name="city"]', filterForm).forEach((i) => i.addEventListener('input', reloadEvents));
  $$('select, input[type="checkbox"]', filterForm).forEach((i) => i.addEventListener('change', () => { evState.offset = 0; loadEvents(); }));
  $('#filter-reset').addEventListener('click', () => { filterForm.reset(); evState.offset = 0; loadEvents(); });

  function eventsQuery() {
    const f = Object.fromEntries(new FormData(filterForm));
    const qs = new URLSearchParams({ limit: String(EVENTS_PAGE), offset: String(evState.offset) });
    for (const k of ['q', 'city', 'category', 'status']) if (f[k] && f[k].trim()) qs.set(k, f[k].trim());
    if (f.onlyAvailable) qs.set('onlyAvailable', 'true');
    return { qs, filtered: [...qs.keys()].some((k) => !['limit', 'offset'].includes(k)) };
  }

  async function loadEvents() {
    if (!session) return;
    const seq = ++evState.seq;
    const list = $('#events-list');
    list.replaceChildren(...Array.from({ length: 6 }, () => h('div', { class: 'skel', 'aria-hidden': 'true' })));
    const { qs, filtered } = eventsQuery();
    try {
      const { data } = await api('GET', `/events?${qs}`);
      if (seq !== evState.seq) return; // ada permintaan yang lebih baru
      evState.total = data.page?.total ?? data.data.length;
      $('#events-summary').textContent = filtered
        ? `${evState.total} event cocok dengan filtermu.`
        : `${evState.total} event tersedia. Pilih satu untuk melihat jenis tiket.`;
      if (!data.data.length) {
        list.replaceChildren(h('div', { class: 'empty' },
          h('strong', {}, filtered ? 'Tidak ada event yang cocok' : 'Belum ada event'),
          h('span', {}, filtered ? 'Coba ubah kata kunci atau hapus beberapa filter.' : 'Event baru akan muncul di sini setelah diterbitkan.'),
          filtered ? h('button', { type: 'button', class: 'btn small', onclick: () => { filterForm.reset(); evState.offset = 0; loadEvents(); } }, 'Atur ulang filter') : null));
        renderPager($('#events-pager'), { offset: 0, limit: EVENTS_PAGE, total: 0 });
        return;
      }
      list.replaceChildren(...data.data.map((ev) => eventCard(ev)));
      renderPager($('#events-pager'), { offset: evState.offset, limit: EVENTS_PAGE, total: evState.total }, (o) => { evState.offset = o; loadEvents(); scrollTo({ top: 0 }); });
    } catch (e) {
      if (seq !== evState.seq || !session) return;
      list.replaceChildren(h('div', { class: 'empty' },
        h('strong', {}, 'Event gagal dimuat'), h('span', {}, e.message),
        h('button', { type: 'button', class: 'btn small', onclick: loadEvents }, 'Coba lagi')));
    }
  }

  function eventCard(ev, { preview = false } = {}) {
    const start = new Date(ev.startsAt);
    const valid = !Number.isNaN(start.getTime());
    const sold = ev.totalAvailable === 0;
    const off = ev.status !== 'ON_SALE' || sold;
    const low = ev.status === 'ON_SALE' && !sold && ev.totalAvailable <= 10;
    const stock = ev.status !== 'ON_SALE' ? EVENT_STATUS[ev.status] || ev.status
      : sold ? 'Tiket habis'
        : low ? `Sisa ${ev.totalAvailable} tiket` : `${ev.totalAvailable} tiket tersedia`;
    const body = [
      h('div', { class: 'stub-main' },
        h('h3', {}, ev.name),
        h('div', { class: 'meta' }, `${ev.artist}, ${ev.venue}, ${ev.city}`),
        h('div', { class: 'stub-tags' }, h('span', { class: 'chip' }, ev.category), h('span', { class: `chip ${ev.status}` }, EVENT_STATUS[ev.status] || ev.status)),
        h('div', { class: 'stub-foot' },
          ev.minPrice != null ? h('span', { class: 'price' }, ev.minPrice === 0 ? 'Gratis' : `Mulai ${rupiah.format(ev.minPrice)}`) : null,
          h('span', { class: `stock-line${low ? ' low' : ''}` }, stock))),
      h('div', { class: 'stub-date' },
        h('span', { class: 'day' }, valid ? String(start.getDate()) : '-'),
        h('span', { class: 'mon' }, valid ? monthShort.format(start) : ''),
        h('span', { class: 'time' }, valid ? timeShort.format(start) : '')),
    ];
    const cls = `stub-card hue-${hueOf(ev.name)}${off ? ' off' : ''}`;
    if (preview) return h('div', { class: cls }, ...body);
    return h('button', { type: 'button', class: cls, 'aria-label': `${ev.name}, buka detail dan pesan tiket`, onclick: () => openEvent(ev) }, ...body);
  }

  // ---------- detail event & pemesanan ----------
  let attempt = null; // satu Idempotency-Key dipakai ulang selama percobaan yang sama belum pasti hasilnya
  function keyFor(ticketTypeId, quantity) {
    if (!attempt || attempt.t !== ticketTypeId || attempt.q !== quantity) attempt = { t: ticketTypeId, q: quantity, key: uuid() };
    return attempt.key;
  }

  async function openEvent(summary) {
    const hue = hueOf(summary.name);
    const holder = h('div', {}, sheetHead(hue, summary.name, h('p', {}, 'Memuat detail...')), h('div', { class: 'sheet-body' }, h('div', { class: 'skel' })));
    openDialog(holder);
    await fillEventSheet(holder, summary.id, hue);
  }

  async function fillEventSheet(holder, id, hue) {
    try {
      const { data: ev } = await api('GET', `/events/${id}`); // selalu ambil ulang agar stok terbaru
      rememberEvent(ev);
      holder.replaceChildren(...eventSheet(ev, hue, holder));
    } catch (e) {
      if (!session) return;
      holder.replaceChildren(sheetHead(hue, 'Event gagal dimuat'), h('div', { class: 'sheet-body' },
        h('div', { class: 'alert err' }, e.message),
        h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn', onclick: () => fillEventSheet(holder, id, hue) }, 'Coba lagi'))));
    }
  }

  function eventSheet(ev, hue, holder) {
    const canSell = ev.status === 'ON_SALE';
    const sellable = ev.ticketTypes.filter((t) => t.available > 0);
    let selected = canSell ? sellable[0] || null : null;
    let qty = 1;
    const buyBox = h('div', { class: 'buy-box' });
    const flag = { stopped: false };

    const maxQty = () => (selected ? Math.min(MAX_QTY, selected.available) : 0);

    function renderBuy() {
      if (!selected) { buyBox.hidden = true; return; }
      buyBox.hidden = false;
      qty = Math.min(Math.max(1, qty), maxQty());
      const minus = h('button', { type: 'button', 'aria-label': 'Kurangi jumlah', disabled: qty <= 1, onclick: () => { qty -= 1; renderBuy(); } }, '\u2212');
      const plus = h('button', { type: 'button', 'aria-label': 'Tambah jumlah', disabled: qty >= maxQty(), onclick: () => { qty += 1; renderBuy(); } }, '+');
      const btn = h('button', { type: 'button', class: 'btn block' }, 'Pesan tiket');
      btn.addEventListener('click', () => submit(btn));
      buyBox.replaceChildren(
        h('div', { class: 'total-line' },
          h('div', {}, h('strong', {}, selected.name), h('div', { class: 'muted small' }, `Maksimal ${MAX_QTY} tiket per pesanan`)),
          h('div', { class: 'qty', role: 'group', 'aria-label': 'Jumlah tiket' }, minus, h('output', { 'aria-live': 'polite' }, String(qty)), plus)),
        h('div', { class: 'total-line' }, h('span', { class: 'muted' }, 'Total'), h('span', { class: 'big' }, selected.price === 0 ? 'Gratis' : rupiah.format(selected.price * qty))),
        btn);
    }

    async function submit(btn) {
      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Mengirim...';
      try {
        const r = await api('POST', '/orders', {
          json: { ticketTypeId: selected.id, quantity: qty },
          headers: { 'idempotency-key': keyFor(selected.id, qty) },
        });
        attempt = null;
        names.tickets[selected.id] = { event: ev.name, ticket: selected.name };
        saveNames();
        showResult(r.data, r.status === 200);
        refreshBadge();
      } catch (e) {
        if (e.status >= 400 && e.status < 500 && e.status !== 429) attempt = null; // hasil pasti: percobaan berikutnya memakai kunci baru
        toast(e.message, 'err');
        if (e.status === 429 && e.retryAfter) { cooldown(btn, label, e.retryAfter); return; }
        btn.disabled = false;
        btn.textContent = label;
        if (e.status >= 400 && e.status < 500 && session) fillEventSheet(holder, ev.id, hue); // stok mungkin berubah
      }
    }

    function showResult(order, duplicate) {
      const out = h('div', { class: 'result' });
      $('.sheet-body', holder).replaceChildren(out);
      const paint = (o) => {
        out.replaceChildren(
          h('div', { class: `badge-ico ${o.status}`, 'aria-hidden': 'true' }, o.status === 'CONFIRMED' ? '\u2713' : o.status === 'REJECTED' ? '!' : '\u2026'),
          h('h3', {}, o.status === 'CONFIRMED' ? 'Pesanan berhasil' : o.status === 'REJECTED' ? 'Pesanan ditolak' : duplicate ? 'Pesanan ini sudah pernah dibuat' : 'Pesanan diterima'),
          h('p', { class: 'muted' }, o.status === 'PENDING'
            ? 'Kami sedang memeriksa stok dan memproses pesananmu. Halaman ini akan berubah otomatis.'
            : o.status === 'CONFIRMED' ? `${o.quantity} tiket ${selected.name} untuk ${ev.name}. Total ${rupiah.format(o.totalPrice ?? 0)}.`
              : (REASONS[o.reason] || o.reason || 'Pesanan tidak dapat diproses.')),
          h('span', { class: `status ${o.status}${o.status === 'PENDING' ? ' pulse' : ''}` }, STATUS_LABEL[o.status] || o.status),
          h('div', { class: 'actions' },
            h('button', { type: 'button', class: 'btn', onclick: () => { closeDialog(); location.hash = '#/orders'; } }, 'Lihat pesanan saya'),
            h('button', { type: 'button', class: 'btn ghost', onclick: () => fillEventSheet(holder, ev.id, hue) }, 'Pesan lagi')));
      };
      paint(order);
      if (order.status === 'PENDING') pollOrder(order.id, paint, flag);
    }

    const head = sheetHead(hue, ev.name,
      h('p', {}, `${ev.artist}, ${ev.venue}, ${ev.city}`),
      h('p', {}, dateLong.format(new Date(ev.startsAt))),
      h('span', { class: 'chip' }, EVENT_STATUS[ev.status] || ev.status));

    const options = ev.ticketTypes.map((tt) => {
      const pct = tt.total ? Math.round((tt.available / tt.total) * 100) : 0;
      const low = tt.available > 0 && pct <= 20;
      const input = h('input', { type: 'radio', name: 'tt', value: tt.id, disabled: !canSell || tt.available < 1, checked: selected?.id === tt.id });
      input.addEventListener('change', () => { selected = tt; renderBuy(); });
      return h('label', { class: 'tt-opt' }, input,
        h('div', {},
          h('div', { class: 'tt-name' }, tt.name),
          h('div', { class: `muted small${low ? ' stock-line low' : ''}` }, tt.available < 1 ? 'Habis' : `Tersedia ${tt.available} dari ${tt.total}`),
          h('div', { class: `bar${low ? ' low' : ''}` }, h('i', { css: { width: `${pct}%` } }))),
        h('div', { class: 'tt-price' }, tt.price === 0 ? 'Gratis' : rupiah.format(tt.price)));
    });

    renderBuy();
    const body = h('div', { class: 'sheet-body' },
      ev.description ? h('p', {}, ev.description) : null,
      !canSell ? h('div', { class: 'alert warn' }, ev.status === 'UPCOMING' ? 'Penjualan belum dibuka untuk event ini.' : `Event ini ${(EVENT_STATUS[ev.status] || 'tidak dijual').toLowerCase()}, tiket tidak dapat dipesan.`) : null,
      h('div', { class: 'sheet-title' }, 'Pilih tiket'),
      h('div', { class: 'tt-list', role: 'radiogroup', 'aria-label': 'Jenis tiket' }, ...options),
      canSell && !sellable.length ? h('div', { class: 'alert err' }, 'Semua tiket untuk event ini sudah habis.') : null,
      buyBox);
    dlgCleanup = () => { flag.stopped = true; };
    return [head, body];
  }

  function cooldown(btn, label, secs) {
    let n = secs;
    btn.disabled = true;
    btn.textContent = `Coba lagi (${n} dtk)`;
    const t = setInterval(() => {
      n -= 1;
      if (n <= 0 || !btn.isConnected) { clearInterval(t); btn.disabled = false; btn.textContent = label; return; }
      btn.textContent = `Coba lagi (${n} dtk)`;
    }, 1000);
  }

  async function pollOrder(id, onUpdate, flag, tries = 0) {
    if (flag.stopped || tries > 40 || !session) return;
    await new Promise((r) => setTimeout(r, POLL_MS));
    if (flag.stopped) return;
    try {
      const { data } = await api('GET', `/orders/${id}`);
      if (flag.stopped) return;
      onUpdate(data);
      if (data.status === 'PENDING') pollOrder(id, onUpdate, flag, tries + 1);
      else refreshBadge();
    } catch (e) {
      if (e.status === 429) pollOrder(id, onUpdate, flag, tries + 1);
    }
  }

  // ---------- daftar pesanan ----------
  const orState = { offset: 0, total: 0, items: [], filter: '' };

  $('#refresh-orders').addEventListener('click', () => loadOrders());
  $$('[data-ofilter]').forEach((b) => b.addEventListener('click', () => {
    orState.filter = b.dataset.ofilter;
    $$('[data-ofilter]').forEach((x) => x.classList.toggle('active', x === b));
    renderOrders();
  }));

  async function loadOrders(silent = false) {
    if (!session) return;
    const box = $('#orders-list');
    if (!silent && !orState.items.length) box.replaceChildren(...Array.from({ length: 3 }, () => h('div', { class: 'skel', 'aria-hidden': 'true' })));
    try {
      const { data } = await api('GET', `/orders?limit=${ORDERS_PAGE}&offset=${orState.offset}`);
      orState.items = data.data;
      orState.total = data.page?.total ?? data.data.length;
      renderOrders();
      resolveNames();
      updateBadge(data.data);
    } catch (e) {
      if (!session) return;
      if (!silent) toast(e.message, 'err');
      if (!orState.items.length) box.replaceChildren(h('div', { class: 'empty' }, h('strong', {}, 'Pesanan gagal dimuat'), h('span', {}, e.message),
        h('button', { type: 'button', class: 'btn small', onclick: () => loadOrders() }, 'Coba lagi')));
    }
    clearTimeout(pollTimer);
    if (session && currentRoute() === 'orders' && orState.items.some((o) => o.status === 'PENDING')) {
      pollTimer = setTimeout(() => loadOrders(true), POLL_MS);
    }
  }

  // Cari nama event/tiket untuk pesanan yang sudah dikonfirmasi tetapi namanya belum ada di cache.
  const resolving = new Set();
  async function resolveNames() {
    const missing = [...new Set(orState.items.filter((o) => o.eventId && !names.tickets[o.ticketTypeId] && !resolving.has(o.eventId)).map((o) => o.eventId))].slice(0, 5);
    if (!missing.length) return;
    missing.forEach((id) => resolving.add(id));
    await Promise.all(missing.map(async (id) => {
      try { const { data } = await api('GET', `/events/${id}`); rememberEvent(data); } catch { /* biarkan memakai id */ } finally { resolving.delete(id); }
    }));
    if (currentRoute() === 'orders') renderOrders();
  }

  const orderTitle = (o) => {
    const info = names.tickets[o.ticketTypeId];
    return info ? `${info.event} - ${info.ticket}` : `Tiket ${o.ticketTypeId.slice(0, 8)}`;
  };

  function renderOrders() {
    const box = $('#orders-list');
    const items = orState.items;
    const stats = $('#order-stats');
    if (orState.total) {
      const c = (s) => items.filter((o) => o.status === s).length;
      const spent = items.filter((o) => o.status === 'CONFIRMED').reduce((n, o) => n + (o.totalPrice || 0), 0);
      stats.hidden = false;
      stats.replaceChildren(
        h('div', { class: 'stat' }, h('b', {}, String(orState.total)), h('span', {}, 'Total pesanan')),
        h('div', { class: 'stat' }, h('b', {}, String(c('PENDING'))), h('span', {}, 'Menunggu')),
        h('div', { class: 'stat' }, h('b', {}, String(c('CONFIRMED'))), h('span', {}, 'Berhasil')),
        h('div', { class: 'stat' }, h('b', {}, rupiah.format(spent)), h('span', {}, 'Total belanja')),
        ...(orState.total > ORDERS_PAGE ? [h('p', { class: 'muted small stats-note' }, `Ringkasan status dan belanja dihitung dari ${items.length} pesanan di halaman ini.`)] : []));
    } else stats.hidden = true;

    if (!orState.total) {
      box.replaceChildren(h('div', { class: 'empty' },
        h('strong', {}, 'Belum ada pesanan'), h('span', {}, 'Pilih event, lalu pesan tiket pertamamu.'),
        h('a', { class: 'btn small', href: '#/events' }, 'Jelajahi event')));
      renderPager($('#orders-pager'), { offset: 0, limit: ORDERS_PAGE, total: 0 });
      return;
    }
    const shown = orState.filter ? items.filter((o) => o.status === orState.filter) : items;
    if (!shown.length) {
      box.replaceChildren(h('div', { class: 'empty' }, h('strong', {}, `Tidak ada pesanan "${STATUS_LABEL[orState.filter].toLowerCase()}" di halaman ini`)));
    } else {
      box.replaceChildren(...shown.map((o) => {
        const d = new Date(o.createdAt);
        return h('button', { type: 'button', class: 'order-row', 'aria-label': `Pesanan ${orderTitle(o)}, ${STATUS_LABEL[o.status]}, buka detail`, onclick: () => openOrder(o) },
          h('div', { class: 'order-date' }, h('b', {}, String(d.getDate())), h('span', {}, monthShort.format(d))),
          h('div', { class: 'order-info' },
            h('strong', {}, orderTitle(o)),
            h('span', { class: 'muted small' }, `${o.quantity} tiket, ${timeShort.format(d)}`)),
          h('div', { class: 'order-side' },
            h('span', { class: `status ${o.status}${o.status === 'PENDING' ? ' pulse' : ''}` }, STATUS_LABEL[o.status] || o.status),
            h('span', { class: 'small' }, o.totalPrice != null ? rupiah.format(o.totalPrice) : '')));
      }));
    }
    renderPager($('#orders-pager'), { offset: orState.offset, limit: ORDERS_PAGE, total: orState.total }, (o) => { orState.offset = o; loadOrders(); scrollTo({ top: 0 }); });
  }

  // Lencana jumlah pesanan yang masih menunggu di menu.
  function updateBadge(items) {
    const n = items.filter((o) => o.status === 'PENDING').length;
    const b = $('#pending-badge');
    b.hidden = !n;
    b.textContent = String(n);
  }
  async function refreshBadge() {
    if (!session) return;
    try { const { data } = await api('GET', '/orders?limit=50'); updateBadge(data.data); } catch { /* lencana hanya hiasan */ }
  }

  function openOrder(initial) {
    const flag = { stopped: false };
    const holder = h('div', {});
    const paint = (o) => {
      const i = orState.items.findIndex((x) => x.id === o.id);
      if (i >= 0) orState.items[i] = o;
      const final = o.status !== 'PENDING';
      const info = names.tickets[o.ticketTypeId];
      holder.replaceChildren(
        sheetHead(hueOf(info?.event || 'Pesanan'), info ? info.event : 'Pesanan tiket', h('p', {}, info ? info.ticket : `Tiket ${o.ticketTypeId.slice(0, 8)}`),
          h('span', { class: 'chip' }, STATUS_LABEL[o.status] || o.status)),
        h('div', { class: 'sheet-body' },
          h('div', { class: 'steps', role: 'img', 'aria-label': `Tahap pesanan: ${STATUS_LABEL[o.status] || o.status}` },
            h('div', { class: 'step done' }, h('i'), 'Diterima'),
            h('div', { class: `step${final ? ' done' : ''}` }, h('i'), 'Diproses'),
            h('div', { class: `step${final ? ` done ${o.status}` : ''}` }, h('i'), final ? STATUS_LABEL[o.status] : 'Hasil')),
          o.status === 'REJECTED' ? h('div', { class: 'alert err' }, REASONS[o.reason] || o.reason || 'Pesanan tidak dapat diproses.') : null,
          o.status === 'PENDING' ? h('div', { class: 'alert warn' }, 'Pesananmu sedang diproses. Halaman ini diperbarui otomatis.') : null,
          h('dl', { class: 'kv' },
            h('dt', {}, 'Jumlah'), h('dd', {}, `${o.quantity} tiket`),
            h('dt', {}, 'Harga satuan'), h('dd', {}, o.unitPrice != null ? rupiah.format(o.unitPrice) : '-'),
            h('dt', {}, 'Total'), h('dd', {}, o.totalPrice != null ? rupiah.format(o.totalPrice) : '-'),
            h('dt', {}, 'Dibuat'), h('dd', {}, dateShort.format(new Date(o.createdAt))),
            h('dt', {}, 'Diperbarui'), h('dd', {}, dateShort.format(new Date(o.updatedAt))),
            h('dt', {}, 'ID pesanan'), h('dd', {}, h('code', {}, o.id))),
          h('div', { class: 'actions' },
            h('button', { type: 'button', class: 'btn ghost small', onclick: () => copyText(o.id) }, 'Salin ID pesanan'),
            o.eventId ? h('button', { type: 'button', class: 'btn ghost small', onclick: () => openEvent({ id: o.eventId, name: info?.event || 'Event' }) }, 'Lihat event') : null)));
    };
    paint(initial);
    openDialog(holder, () => { flag.stopped = true; renderOrders(); });
    if (initial.status === 'PENDING') pollOrder(initial.id, paint, flag);
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast('ID pesanan disalin.', 'ok'); } catch { toast('Tidak dapat menyalin otomatis. Pilih dan salin ID secara manual.', 'err'); }
  }

  // ---------- admin ----------
  const eventForm = $('#form-event');
  const ttRows = $('#tt-rows');
  let adminReady = false;

  function defaultStart() {
    const d = new Date(Date.now() + 30 * 864e5);
    d.setHours(19, 0, 0, 0);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function addTtRow(vals = {}) {
    const row = h('div', { class: 'tt-row' },
      h('label', { class: 'field' }, 'Nama tiket', h('input', { 'data-f': 'name', maxlength: '100', placeholder: 'Regular', value: vals.name || '' })),
      h('label', { class: 'field' }, 'Harga (Rp)', h('input', { 'data-f': 'price', type: 'number', min: '0', step: '1000', placeholder: '150000', value: vals.price ?? '' })),
      h('label', { class: 'field' }, 'Stok', h('input', { 'data-f': 'total', type: 'number', min: '1', step: '1', placeholder: '100', value: vals.total ?? '' })),
      h('button', { type: 'button', class: 'btn ghost small', 'aria-label': 'Hapus jenis tiket', onclick: () => { row.remove(); syncTtButtons(); updatePreview(); } }, 'Hapus'));
    ttRows.append(row);
    syncTtButtons();
    return row;
  }
  function syncTtButtons() {
    const n = ttRows.children.length;
    $$('.tt-row > .btn', ttRows).forEach((b) => { b.disabled = n <= 1; });
    $('#add-tt').disabled = n >= 10;
  }
  $('#add-tt').addEventListener('click', () => { addTtRow().querySelector('input').focus(); updatePreview(); });

  function readEventForm() {
    const v = Object.fromEntries(new FormData(eventForm));
    const tickets = $$('.tt-row', ttRows).map((r) => ({
      name: $('[data-f="name"]', r).value.trim(),
      price: $('[data-f="price"]', r).value,
      total: $('[data-f="total"]', r).value,
    }));
    return { v, tickets };
  }

  function updatePreview() {
    const { v, tickets } = readEventForm();
    const prices = tickets.filter((t) => t.price !== '').map((t) => Number(t.price)).filter((n) => Number.isFinite(n) && n >= 0);
    const total = tickets.reduce((n, t) => n + (Number(t.total) > 0 ? Number(t.total) : 0), 0);
    const start = v.startsAt ? new Date(v.startsAt) : new Date(Date.now() + 30 * 864e5);
    $('#event-preview').replaceChildren(eventCard({
      id: 'preview', name: v.name?.trim() || 'Nama event', artist: v.artist?.trim() || 'Artis', venue: v.venue?.trim() || 'Tempat',
      city: v.city?.trim() || 'Kota', category: v.category?.trim() || 'kategori', startsAt: Number.isNaN(start.getTime()) ? new Date().toISOString() : start.toISOString(),
      status: v.status || 'ON_SALE', minPrice: prices.length ? Math.min(...prices) : null, totalAvailable: total,
    }, { preview: true }));
    $('#desc-count').textContent = `${(v.description || '').length}/2000`;
  }
  eventForm.addEventListener('input', (ev) => {
    const t = ev.target;
    if (t.name && $(`[data-err="${t.name}"]`, eventForm)) fieldErr(eventForm, t.name, '');
    if (t.dataset?.f) $('[data-err="ticketTypes"]', eventForm).textContent = '';
    updatePreview();
  });
  eventForm.addEventListener('change', updatePreview);

  function resetEventForm() {
    eventForm.reset();
    eventForm.elements.startsAt.value = defaultStart();
    ttRows.replaceChildren();
    addTtRow({ name: 'Regular' });
    $$('[data-err]', eventForm).forEach((e) => { e.textContent = ''; });
    $$('[aria-invalid]', eventForm).forEach((e) => e.removeAttribute('aria-invalid'));
    $('#event-errors').hidden = true;
    updatePreview();
  }
  $('#event-reset').addEventListener('click', resetEventForm);

  function validateEvent() {
    const { v, tickets } = readEventForm();
    const errs = {};
    const need = { name: 200, artist: 200, venue: 200, city: 100, category: 50 };
    for (const [k, max] of Object.entries(need)) {
      const s = (v[k] || '').trim();
      if (!s) errs[k] = 'Wajib diisi.';
      else if (s.length > max) errs[k] = `Maksimal ${max} karakter.`;
    }
    const when = v.startsAt ? new Date(v.startsAt) : null;
    const whenOk = when && !Number.isNaN(when.getTime());
    if (!whenOk) errs.startsAt = 'Pilih tanggal dan jam mulai.';
    const seen = new Set();
    const tt = [];
    let ttErr = '';
    tickets.forEach((t, i) => {
      const price = Number(t.price);
      const total = Number(t.total);
      if (!t.name) ttErr ||= `Jenis tiket #${i + 1}: nama wajib diisi.`;
      else if (seen.has(t.name.toLowerCase())) ttErr ||= 'Nama jenis tiket harus unik.';
      else if (t.price === '' || !Number.isFinite(price) || price < 0 || price > 1_000_000_000) ttErr ||= `Jenis tiket "${t.name}": harga harus 0 sampai 1.000.000.000.`;
      else if (!Number.isInteger(total) || total < 1 || total > 1_000_000) ttErr ||= `Jenis tiket "${t.name}": stok harus bilangan bulat 1 sampai 1.000.000.`;
      seen.add(t.name.toLowerCase());
      tt.push({ name: t.name, price, total });
    });
    if (ttErr) errs.ticketTypes = ttErr;
    const payload = {
      name: (v.name || '').trim(), artist: (v.artist || '').trim(), venue: (v.venue || '').trim(), city: (v.city || '').trim(),
      category: (v.category || '').trim(), startsAt: whenOk ? when.toISOString() : '',
      status: v.status || 'ON_SALE', ticketTypes: tt,
    };
    if ((v.description || '').trim()) payload.description = v.description.trim();
    return { errs, payload };
  }

  eventForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const { errs, payload } = validateEvent();
    for (const k of ['name', 'artist', 'venue', 'city', 'category', 'startsAt']) fieldErr(eventForm, k, errs[k] || '');
    $('[data-err="ticketTypes"]', eventForm).textContent = errs.ticketTypes || '';
    const box = $('#event-errors');
    box.hidden = true;
    if (Object.keys(errs).length) {
      const first = $('[aria-invalid="true"]', eventForm);
      if (first) first.focus(); else $('[data-f]', ttRows)?.focus();
      return;
    }
    const btn = $('#event-submit');
    btn.disabled = true;
    btn.textContent = 'Menerbitkan...';
    try {
      const { data } = await api('POST', '/events', { json: payload });
      const created = data?.name || payload.name;
      toast(`Event "${created}" diterbitkan.`, 'ok');
      resetEventForm();
      box.className = 'alert ok';
      box.hidden = false;
      box.replaceChildren(`Event "${created}" sudah terbit. `,
        h('button', { type: 'button', class: 'btn small', onclick: () => { filterForm.reset(); filterForm.elements.q.value = created; evState.offset = 0; if (currentRoute() === 'events') loadEvents(); else location.hash = '#/events'; } }, 'Lihat di katalog'));
    } catch (e) {
      box.className = 'alert err';
      box.hidden = false;
      box.textContent = e.status === 403 ? 'Akun ini tidak punya izin admin untuk membuat event.' : e.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Terbitkan event';
    }
  });

  $$('[data-atab]').forEach((b) => b.addEventListener('click', () => showAdminTab(b.dataset.atab)));
  function showAdminTab(name) {
    $$('[data-atab]').forEach((x) => { x.classList.toggle('active', x.dataset.atab === name); x.setAttribute('aria-selected', String(x.dataset.atab === name)); });
    $('#admin-create').hidden = name !== 'create';
    $('#admin-upstreams').hidden = name !== 'upstreams';
    clearInterval(upstreamTimer);
    if (name === 'upstreams') { loadUpstreams(); upstreamTimer = setInterval(() => loadUpstreams(true), 10000); }
  }

  function initAdmin() {
    if (!adminReady) { adminReady = true; resetEventForm(); }
    showAdminTab($('[data-atab].active')?.dataset.atab || 'create');
  }

  $('#refresh-upstreams').addEventListener('click', () => loadUpstreams());
  async function loadUpstreams(silent = false) {
    const list = $('#upstream-list');
    if (!silent) list.replaceChildren(...Array.from({ length: 4 }, () => h('div', { class: 'skel', 'aria-hidden': 'true' })));
    try {
      const { data } = await api('GET', '/admin/upstreams');
      const pools = data.upstreams || [];
      const all = pools.flatMap((p) => p.targets);
      const up = all.filter((t) => t.healthy).length;
      $('#upstream-summary').textContent = `Service discovery: ${data.discovery}. ${up} dari ${all.length} replika sehat. Diperbarui ${timeShort.format(new Date())}.`;
      list.replaceChildren(...pools.map((p) => {
        const healthy = p.targets.filter((t) => t.healthy).length;
        const tone = healthy === p.targets.length && healthy ? 'CONFIRMED' : healthy ? 'PENDING' : 'REJECTED';
        return h('div', { class: 'card upstream' },
          h('h3', {}, p.name, h('span', { class: `status ${tone}` }, `${healthy}/${p.targets.length} sehat`)),
          ...p.targets.map((t) => h('div', { class: 'target' }, h('span', { class: `dot${t.healthy ? ' up' : ''}`, role: 'img', 'aria-label': t.healthy ? 'Sehat' : 'Tidak sehat' }), t.url)));
      }));
    } catch (e) {
      if (!session) return;
      if (!silent) list.replaceChildren(h('div', { class: 'empty' }, h('strong', {}, 'Status layanan gagal dimuat'), h('span', {}, e.message)));
    }
  }

  // ---------- sesi: hitung mundur ----------
  function tickSession() {
    const el = $('#session-left');
    if (!session) { el.textContent = ''; return; }
    const left = Math.max(0, Math.floor((session.exp - Date.now()) / 1000));
    if (left <= 0) { logout('Sesi berakhir (token berlaku 15 menit), silakan masuk lagi.'); return; }
    el.textContent = `Sesi ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    if (left <= 60 && !warnedExpiry) { warnedExpiry = true; toast('Sesimu berakhir kurang dari 1 menit lagi. Selesaikan pesananmu atau masuk kembali.', 'err'); }
  }
  setInterval(tickSession, 1000);

  function resetState() {
    clearTimeout(pollTimer);
    clearInterval(upstreamTimer);
    Object.assign(orState, { offset: 0, total: 0, items: [], filter: '' });
    Object.assign(evState, { offset: 0, total: 0 });
    attempt = null;
    adminReady = false;
    $('#events-list').replaceChildren();
    $('#orders-list').replaceChildren();
    $('#order-stats').hidden = true;
    $$('[data-ofilter]').forEach((x) => x.classList.toggle('active', x.dataset.ofilter === ''));
  }

  // ---------- mulai ----------
  tickSession();
  if (session) afterLogin(); else render();
})();
