/**
 * Byte-oriented WebCrypto primitives for X3DH + Double Ratchet.
 *
 * Design notes:
 * - All symmetric key material (root / chain / message keys) lives as raw
 *   bytes and is imported into AES-GCM/HMAC only at use time. This keeps
 *   protocol state plain bytes, which serialize without CryptoKey tricks.
 * - Asymmetric keys: ECDH P-256 for Diffie-Hellman (X3DH + DH ratchet),
 *   ECDSA P-256/SHA-256 for identity signing. WebCrypto cannot do XEdDSA,
 *   so one identity uses two keypairs bound together by a signature.
 */

const DH_ALG = { name: "ECDH", namedCurve: "P-256" } as const;
const ECDSA_ALG = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;

/** Bytes backed by a plain ArrayBuffer — directly usable as BufferSource. */
export type Bytes = Uint8Array<ArrayBuffer>;

export const HKDF_SALT_ZERO: Bytes = new Uint8Array(32);

// ---------------------------------------------------------------------------
// base64 <-> bytes
// ---------------------------------------------------------------------------

export function toB64(bytes: Bytes): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function fromB64(b64: string): Bytes {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function utf8(s: string): Bytes {
  return new TextEncoder().encode(s) as Bytes;
}

export function fromUtf8(bytes: Bytes): string {
  return new TextDecoder().decode(bytes);
}

export function concatBytes(...parts: Bytes[]): Bytes {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// asymmetric key generation / serialization
// ---------------------------------------------------------------------------

export interface DhKeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

export interface SerializedDhKeyPair {
  pub: string;
  priv: string;
}

export async function generateDhKeyPair(): Promise<DhKeyPair> {
  return (await crypto.subtle.generateKey(DH_ALG, true, ["deriveBits"])) as DhKeyPair;
}

export async function generateSigningKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(ECDSA_ALG, true, ["sign", "verify"]);
}

export async function exportDhPublicKey(key: CryptoKey): Promise<string> {
  return toB64(new Uint8Array(await crypto.subtle.exportKey("raw", key)));
}

export function importDhPublicKey(b64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromB64(b64), DH_ALG, true, []);
}

export function importSigningPublicKey(b64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromB64(b64), ECDSA_ALG, true, ["verify"]);
}

export async function serializeDhKeyPair(pair: DhKeyPair): Promise<SerializedDhKeyPair> {
  const [pub, priv] = await Promise.all([
    exportDhPublicKey(pair.publicKey),
    crypto.subtle.exportKey("pkcs8", pair.privateKey),
  ]);
  return { pub, priv: toB64(new Uint8Array(priv)) };
}

export async function deserializeDhKeyPair(s: SerializedDhKeyPair): Promise<DhKeyPair> {
  const [pub, priv] = await Promise.all([
    importDhPublicKey(s.pub),
    crypto.subtle.importKey("pkcs8", fromB64(s.priv), DH_ALG, true, ["deriveBits"]),
  ]);
  return { publicKey: pub, privateKey: priv };
}

export interface SerializedSigningKeyPair {
  pub: string;
  priv: string;
}

export async function serializeSigningKeyPair(pair: CryptoKeyPair): Promise<SerializedSigningKeyPair> {
  const [pub, priv] = await Promise.all([
    crypto.subtle.exportKey("raw", pair.publicKey),
    crypto.subtle.exportKey("pkcs8", pair.privateKey),
  ]);
  return { pub: toB64(new Uint8Array(pub)), priv: toB64(new Uint8Array(priv)) };
}

export async function deserializeSigningKeyPair(s: SerializedSigningKeyPair): Promise<CryptoKeyPair> {
  const [pub, priv] = await Promise.all([
    importSigningPublicKey(s.pub),
    crypto.subtle.importKey("pkcs8", fromB64(s.priv), ECDSA_ALG, true, ["sign"]),
  ]);
  return { publicKey: pub, privateKey: priv };
}

// ---------------------------------------------------------------------------
// ECDH + signatures
// ---------------------------------------------------------------------------

/** P-256 ECDH shared secret (32 bytes). */
export async function ecdh(privateKey: CryptoKey, theirPublicKeyB64: string): Promise<Bytes> {
  const theirPub = await importDhPublicKey(theirPublicKeyB64);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: theirPub }, privateKey, 256));
}

export async function signBytes(privateKey: CryptoKey, data: Bytes): Promise<string> {
  return toB64(new Uint8Array(await crypto.subtle.sign(ECDSA_ALG, privateKey, data)));
}

export async function verifyBytes(publicKey: CryptoKey, data: Bytes, signatureB64: string): Promise<boolean> {
  try {
    return await crypto.subtle.verify(ECDSA_ALG, publicKey, fromB64(signatureB64), data);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// HKDF + HMAC chain KDFs
// ---------------------------------------------------------------------------

/** HKDF-SHA256 -> `length` bytes. */
export async function hkdf(ikm: Bytes, salt: Bytes, info: string, length = 32): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: utf8(info) }, key, length * 8),
  );
}

async function hmacSha256(keyBytes: Bytes, data: Bytes): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
}

/** KDF_RK per Double Ratchet spec: HKDF(salt=rk, ikm=dhOut) -> [rootKey, chainKey]. */
export async function kdfRootKey(rootKey: Bytes, dhOutput: Bytes): Promise<[Bytes, Bytes]> {
  const okm = await hkdf(dhOutput, rootKey, "dr-root-v1", 64);
  return [okm.slice(0, 32) as Bytes, okm.slice(32, 64) as Bytes];
}

/** KDF_CK per spec: mk = HMAC(ck, 0x01), nextCk = HMAC(ck, 0x02). */
export async function kdfChainKey(chainKey: Bytes): Promise<[Bytes, Bytes]> {
  const messageKey = await hmacSha256(chainKey, Uint8Array.of(0x01));
  const nextChainKey = await hmacSha256(chainKey, Uint8Array.of(0x02));
  return [messageKey, nextChainKey];
}

// ---------------------------------------------------------------------------
// AES-GCM
// ---------------------------------------------------------------------------

export interface AesResult {
  iv: string;
  ct: string;
}

export async function aesEncrypt(keyBytes: Bytes, plaintext: Bytes, ad: Bytes): Promise<AesResult> {
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: ad }, key, plaintext);
  return { iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
}

export async function aesDecrypt(keyBytes: Bytes, ivB64: string, ctB64: string, ad: Bytes): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(ivB64), additionalData: ad }, key, fromB64(ctB64)),
  );
}

export async function sha256(data: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}
