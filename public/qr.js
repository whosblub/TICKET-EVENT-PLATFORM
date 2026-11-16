// Pembuat kode QR kecil tanpa pustaka luar (CSP halaman ini melarang skrip dari luar).
// Mode byte (UTF-8), koreksi galat level M, versi 1-5 (maks. 84 byte), cukup untuk kode e-tiket.
// Pemakaian: QR.encode('TKT-ABCD-EFGH-JKMN') -> { size, modules: boolean[][] } (true = modul gelap)
(function (root) {
  'use strict';

  // Level M per versi: [jumlah blok, kodeword data per blok, kodeword koreksi per blok]
  const VERSIONS = [null,
    { blocks: 1, data: 16, ec: 10, align: [] },
    { blocks: 1, data: 28, ec: 16, align: [6, 18] },
    { blocks: 1, data: 44, ec: 26, align: [6, 22] },
    { blocks: 2, data: 32, ec: 18, align: [6, 26] },
    { blocks: 2, data: 43, ec: 24, align: [6, 30] },
  ];

  // ---- aritmetika GF(256) dan Reed-Solomon ----
  const EXP = new Array(512);
  const LOG = new Array(256);
  for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

  function rsGenerator(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= mul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  function rsRemainder(data, degree) {
    const gen = rsGenerator(degree);
    const rem = new Array(degree).fill(0);
    for (const b of data) {
      const factor = b ^ rem.shift();
      rem.push(0);
      for (let i = 0; i < degree; i++) rem[i] ^= mul(gen[i + 1], factor);
    }
    return rem;
  }

  function utf8(text) {
    return Array.from(new TextEncoder().encode(text));
  }

  // ---- data -> kodeword (data + koreksi, disisipkan antarblok) ----
  function buildCodewords(bytes, v) {
    const info = VERSIONS[v];
    const capacity = info.blocks * info.data;
    const bits = [];
    const push = (value, len) => { for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
    push(0b0100, 4); // mode byte
    push(bytes.length, 8); // jumlah karakter (8 bit untuk versi 1-9)
    for (const b of bytes) push(b, 8);
    push(0, Math.min(4, capacity * 8 - bits.length)); // terminator
    while (bits.length % 8) bits.push(0);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
    for (let pad = 0xec; data.length < capacity; pad ^= 0xec ^ 0x11) data.push(pad);

    const blocks = [];
    for (let i = 0; i < info.blocks; i++) {
      const part = data.slice(i * info.data, (i + 1) * info.data);
      blocks.push({ part, ec: rsRemainder(part, info.ec) });
    }
    const out = [];
    for (let i = 0; i < info.data; i++) for (const b of blocks) out.push(b.part[i]);
    for (let i = 0; i < info.ec; i++) for (const b of blocks) out.push(b.ec[i]);
    return out;
  }

  // ---- matriks ----
  function makeGrid(v) {
    const size = 17 + 4 * v;
    const modules = Array.from({ length: size }, () => new Array(size).fill(false));
    const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (r, c, dark) => { modules[r][c] = dark; reserved[r][c] = true; };

    const finder = (r0, c0) => {
      for (let dr = -1; dr <= 7; dr++) {
        for (let dc = -1; dc <= 7; dc++) {
          const r = r0 + dr; const c = c0 + dc;
          if (r < 0 || c < 0 || r >= size || c >= size) continue;
          const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
          const dark = inOuter && (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
          set(r, c, dark);
        }
      }
    };
    finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

    for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); } // pola waktu

    const pos = VERSIONS[v].align;
    for (const r of pos) {
      for (const c of pos) {
        if (reserved[r][c]) continue; // bertumpuk dengan finder
        for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
          set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }

    // area informasi format (diisi nanti) dan modul gelap tetap
    for (let i = 0; i < 9; i++) { reserved[8][i] = true; reserved[i][8] = true; }
    for (let i = 0; i < 8; i++) { reserved[8][size - 1 - i] = true; reserved[size - 1 - i][8] = true; }
    set(size - 8, 8, true);
    return { size, modules, reserved };
  }

  function placeData(grid, codewords) {
    const { size, modules, reserved } = grid;
    const bits = [];
    for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >>> i) & 1);
    let k = 0;
    let up = true;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // lewati kolom pola waktu
      for (let i = 0; i < size; i++) {
        const r = up ? size - 1 - i : i;
        for (let j = 0; j < 2; j++) {
          const c = right - j;
          if (reserved[r][c]) continue;
          modules[r][c] = k < bits.length ? bits[k] === 1 : false;
          k++;
        }
      }
      up = !up;
    }
  }

  const MASKS = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];

  function applyMask(grid, mask) {
    const { size, modules, reserved } = grid;
    const out = modules.map((row) => row.slice());
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (!reserved[r][c] && MASKS[mask](r, c)) out[r][c] = !out[r][c];
    return out;
  }

  // Informasi format: level M (bit 00) + nomor mask, BCH(15,5), XOR 0x5412.
  function formatBits(mask) {
    const data = (0b00 << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((data << 10) | rem) ^ 0x5412;
  }

  function drawFormat(modules, size, mask) {
    const f = formatBits(mask);
    const bit = (i) => ((f >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) modules[i][8] = bit(i);
    modules[7][8] = bit(6);
    modules[8][8] = bit(7);
    modules[8][7] = bit(8);
    for (let i = 9; i < 15; i++) modules[8][14 - i] = bit(i);
    for (let i = 0; i < 8; i++) modules[8][size - 1 - i] = bit(i);
    for (let i = 8; i < 15; i++) modules[size - 15 + i][8] = bit(i);
    modules[size - 8][8] = true;
  }

  // Penalti pemilihan mask (4 aturan standar).
  function penalty(m, size) {
    let score = 0;
    const run = (get) => {
      for (let a = 0; a < size; a++) {
        let len = 1;
        for (let b = 1; b <= size; b++) {
          if (b < size && get(a, b) === get(a, b - 1)) len++;
          else { if (len >= 5) score += 3 + (len - 5); len = 1; }
        }
      }
    };
    run((r, c) => m[r][c]);
    run((c, r) => m[r][c]);
    for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
      if (m[r][c] === m[r][c + 1] && m[r][c] === m[r + 1][c] && m[r][c] === m[r + 1][c + 1]) score += 3;
    }
    const pat = [true, false, true, true, true, false, true, false, false, false, false];
    const rev = pat.slice().reverse();
    const match = (get, p) => p.every((v, i) => get(i) === v);
    for (let a = 0; a < size; a++) for (let b = 0; b <= size - 11; b++) {
      for (const p of [pat, rev]) {
        if (match((i) => m[a][b + i], p)) score += 40;
        if (match((i) => m[b + i][a], p)) score += 40;
      }
    }
    let dark = 0;
    for (const row of m) for (const v of row) if (v) dark++;
    score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
    return score;
  }

  function encode(text) {
    const bytes = utf8(String(text));
    let v = 1;
    while (v < VERSIONS.length && 4 + 8 + bytes.length * 8 > VERSIONS[v].blocks * VERSIONS[v].data * 8) v++;
    if (v >= VERSIONS.length) throw new RangeError('Teks terlalu panjang untuk kode QR (maks. 84 byte)');
    const grid = makeGrid(v);
    placeData(grid, buildCodewords(bytes, v));
    let best = null;
    for (let mask = 0; mask < 8; mask++) {
      const m = applyMask(grid, mask);
      drawFormat(m, grid.size, mask);
      const score = penalty(m, grid.size);
      if (!best || score < best.score) best = { score, m, mask };
    }
    return { size: grid.size, version: v, mask: best.mask, modules: best.m };
  }

  root.QR = { encode };
})(typeof window !== 'undefined' ? window : globalThis);
