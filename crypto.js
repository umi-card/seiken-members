// AES-GCM + PBKDF2 helpers shared by the site and tools/encrypt.mjs
const te = new TextEncoder();
const td = new TextDecoder();

export const ITER = 600000;

export function b64(buf) {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
export const unb64 = (s) => Uint8Array.from(atob(s.replace(/\s/g, '')), (c) => c.charCodeAt(0));
export const utf8 = (s) => te.encode(s);
export const fromUtf8 = (u) => td.decode(u);

export function randomId(len = 10) {
  const a = 'abcdefghijkmnpqrstuvwxyz23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(len)), (x) => a[x % a.length]).join('');
}

export const importDataKey = (rawB64) =>
  crypto.subtle.importKey('raw', unb64(rawB64), 'AES-GCM', false, ['encrypt', 'decrypt']);

export function newDataKey() {
  return b64(crypto.getRandomValues(new Uint8Array(32)));
}

export async function seal(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(JSON.stringify(obj)));
  return { iv: b64(iv), ct: b64(ct) };
}

export async function unseal(key, box) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.ct));
  return JSON.parse(td.decode(pt));
}

// Binary files: 12-byte IV followed by the ciphertext
export async function sealBytes(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return out;
}

export async function unsealBytes(key, buf) {
  const u = new Uint8Array(buf);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: u.subarray(0, 12) }, key, u.subarray(12));
}

// Password-only login: one PBKDF2 run gives both a lookup id (which user) and that user's key,
// so passwords must be unique across users.
export const normName = (s) => String(s).replace(/[\s　]/g, '');
export async function pwLookup(pw, saltB64, iter) {
  const base = await crypto.subtle.importKey('raw', te.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: unb64(saltB64), iterations: iter, hash: 'SHA-256' }, base, 512));
  const ek = b64(bits.slice(0, 32));
  const id = Array.from(bits.slice(32, 44), (x) => x.toString(16).padStart(2, '0')).join('');
  return { id, ek, key: await importDataKey(ek) };
}

// Entry stored at keys.users[id]; the data key, name and DM private key are inside the ciphertext.
// `ek` (the entry key) is kept in the session so the entry can be re-sealed later without the password.
export async function makeUserEntry(pw, rawK, { uid, name, role, priv = null }, keys) {
  const { id, ek, key } = await pwLookup(pw, keys.salt, keys.iter);
  return { id, ek, entry: { ...(await seal(key, { k: rawK, name, priv })), kid: randomId(8), uid, role } };
}

export async function resealUserEntry(ek, entry, payload) {
  return { ...entry, ...(await seal(await importDataKey(ek), payload)) };
}

export async function openUserEntry(pw, keys) {
  const { id, ek, key } = await pwLookup(pw, keys.salt, keys.iter);
  const entry = keys.users?.[id];
  if (!entry) return null;
  try {
    const { k, name, priv = null } = await unseal(key, entry);
    return { id, ek, entry, k, name, priv };
  } catch {
    return null;
  }
}

// DMs: each user has an ECDH key pair; two users derive the same AES key from it
export async function newDmKeyPair() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
  return {
    priv: await crypto.subtle.exportKey('jwk', kp.privateKey),
    pub: await crypto.subtle.exportKey('jwk', kp.publicKey),
  };
}

export async function dmKey(privJwk, pubJwk) {
  const priv = await crypto.subtle.importKey('jwk', privJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']);
  const pub = await crypto.subtle.importKey('jwk', pubJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  return crypto.subtle.deriveKey({ name: 'ECDH', public: pub }, priv, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
