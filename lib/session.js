// Stateless, encrypted session stored in an httpOnly cookie.
// AES-256-GCM: confidentiality + integrity. The browser holds an opaque blob;
// Strava tokens are never readable by client-side JavaScript.
import crypto from 'node:crypto';
import { parseCookies, setCookie, clearCookie } from './http.js';

const COOKIE = 'tai_session';
const MAX_AGE = 60 * 60 * 24 * 60; // 60 days; the refresh token keeps access alive

function key() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw Object.assign(new Error('SESSION_SECRET must be ≥ 32 chars'), { status: 500 });
  return crypto.createHash('sha256').update(secret).digest();
}

export function seal(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
}

export function unseal(token) {
  try {
    const buf = Buffer.from(token, 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    const out = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
    return JSON.parse(out.toString('utf8'));
  } catch {
    return null; // tampered, expired key, or malformed → treated as logged out
  }
}

export function readSession(req) {
  const raw = parseCookies(req)[COOKIE];
  return raw ? unseal(raw) : null;
}

export function writeSession(res, session) {
  setCookie(res, COOKIE, seal(session), { maxAge: MAX_AGE });
}

export function destroySession(res) {
  clearCookie(res, COOKIE);
}
