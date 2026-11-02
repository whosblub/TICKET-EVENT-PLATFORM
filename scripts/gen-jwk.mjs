// Membuat kunci RS256 untuk auth-service. Jalankan: npm run gen:jwk
// Salin keluaran (satu baris base64) ke variabel JWT_PRIVATE_JWK_B64 di auth-service. JANGAN di-commit.
import { generateKeyPair, exportJWK, calculateJwkThumbprint } from 'jose';
const { privateKey } = await generateKeyPair('RS256', { extractable: true, modulusLength: 2048 });
const jwk = await exportJWK(privateKey);
jwk.kid = await calculateJwkThumbprint(jwk);
jwk.alg = 'RS256';
jwk.use = 'sig';
console.log(Buffer.from(JSON.stringify(jwk)).toString('base64'));
