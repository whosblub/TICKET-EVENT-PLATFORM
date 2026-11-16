// Dipasang di <head> supaya tema tersimpan langsung terpakai sebelum halaman digambar (tanpa kedip).
// Harus berupa file terpisah karena CSP gateway hanya mengizinkan script dari origin sendiri.
try {
  const t = localStorage.getItem('ticketing.theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch { /* localStorage bisa dinonaktifkan; ikuti pengaturan sistem */ }
