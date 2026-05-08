// Signed cookie helpers using HMAC-SHA256.
// Format: <value>.<base64url-signature>
// The value is opaque (e.g., a random session ID) — we sign it so a
// stolen-but-not-known cookie cannot be forged.

import { config } from '../config.ts';

const encoder = new TextEncoder();

let cachedKey: Promise<CryptoKey> | null = null;
function getKey(): Promise<CryptoKey> {
  if (!cachedKey) {
    cachedKey = crypto.subtle.importKey(
      'raw',
      encoder.encode(config.sessionSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    );
  }
  return cachedKey;
}

function toBase64Url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): ArrayBuffer {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(padded);
  const buf = new ArrayBuffer(bin.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
  return buf;
}

export async function sign(value: string): Promise<string> {
  const key = await getKey();
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return `${value}.${toBase64Url(sig)}`;
}

export async function verify(signed: string): Promise<string | null> {
  const dot = signed.lastIndexOf('.');
  if (dot < 1) return null;
  const value = signed.slice(0, dot);
  const sig = signed.slice(dot + 1);
  const key = await getKey();
  const ok = await crypto.subtle.verify(
    'HMAC',
    key,
    fromBase64Url(sig),
    encoder.encode(value),
  );
  return ok ? value : null;
}

export const SESSION_COOKIE = 'rm_session';
export const STATE_COOKIE = 'rm_oauth_state';
