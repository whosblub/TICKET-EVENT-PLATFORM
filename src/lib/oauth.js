export const ROLE_SCOPES = {
  user: ['events:read', 'orders:read', 'orders:write'],
  admin: ['events:read', 'events:write', 'orders:read', 'orders:write'],
};
export const SERVICE_SCOPES = ['inventory:write', 'inventory:read'];

export function narrowScopes(allowed, requested) {
  if (!requested) return allowed;
  const want = String(requested).split(' ').filter(Boolean);
  return allowed.filter((s) => want.includes(s));
}

export function clientCredentialsFrom(req) {
  const basic = /^Basic ([A-Za-z0-9+/=]+)$/.exec(req.headers.authorization || '');
  if (basic) {
    const raw = Buffer.from(basic[1], 'base64').toString('utf8');
    const i = raw.indexOf(':');
    if (i > 0) return { id: decodeURIComponent(raw.slice(0, i)), secret: decodeURIComponent(raw.slice(i + 1)) };
  }
  return { id: req.body.client_id, secret: req.body.client_secret };
}