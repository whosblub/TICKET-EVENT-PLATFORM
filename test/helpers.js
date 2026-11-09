import net from 'node:net';

export function mockRes() {
  return {
    headers: {}, statusCode: 200, body: undefined,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

export async function run(mw, req = {}) {
  const res = mockRes();
  let nextCalled = false;
  req.headers ??= {};
  await mw(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}