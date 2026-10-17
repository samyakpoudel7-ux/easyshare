// All cryptography happens here, in the browser. Keys never leave the device.
const enc = new TextEncoder();
const dec = new TextDecoder();

export const b64u = {
  enc(buf) {
    const b = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  dec(str) {
    const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  },
};

export const randomKey = () => crypto.getRandomValues(new Uint8Array(32));
export const aesKey = (raw) => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

async function hkdf(master, info) {
  const base = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode(info) },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export const manifestKey = (master) => hkdf(master, 'manifest');
export const fileKey = (master, fileId) => hkdf(master, 'file:' + fileId);

const join = (iv, ct) => { const o = new Uint8Array(iv.length + ct.byteLength); o.set(iv); o.set(new Uint8Array(ct), iv.length); return o; };

export async function encryptJSON(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return b64u.enc(join(iv, await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)))));
}
export async function decryptJSON(key, str) {
  const d = b64u.dec(str);
  return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: d.slice(0, 12) }, key, d.slice(12))));
}

// File chunks: IV || ciphertext || tag. AAD binds each chunk to its file and position,
// so chunks cannot be swapped or reordered by the storage provider.
export async function encryptChunk(key, fileId, index, plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(`${fileId}:${index}`) }, key, plain);
  return join(iv, ct);
}
export async function decryptChunk(key, fileId, index, data) {
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: data.slice(0, 12), additionalData: enc.encode(`${fileId}:${index}`) }, key, data.slice(12));
}

// Password: one slow PBKDF2 run yields a wrapping key (stays local) and an auth token
// (sent to the server, which stores only its bcrypt hash). The server never learns the password or the key.
export async function fromPassword(password, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 600000 }, base, 512));
  return { wrapKey: await aesKey(bits.slice(0, 32)), authToken: b64u.enc(bits.slice(32)) };
}
export async function wrapRaw(wrapKey, raw) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return b64u.enc(join(iv, await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrapKey, raw)));
}
export async function unwrapRaw(wrapKey, str) {
  const d = b64u.dec(str);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: d.slice(0, 12) }, wrapKey, d.slice(12)));
}
