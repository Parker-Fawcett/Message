import { Bytes, aesDecrypt, aesEncrypt, fromB64, fromUtf8, toB64, utf8 } from "./crypto";

/**
 * Optional at-rest encryption of local storage under a user passphrase.
 *
 * Threat model (honest version): protects identity PRIVATE keys and message
 * history whenever the app is not actively running — a stolen laptop /
 * shared machine / copied profile dump yields nothing without the
 * passphrase. It does NOT protect the live unlocked session, and a forgotten
 * passphrase means permanent loss of identity and history.
 *
 * Layout: non-secret metadata (salt/iterations/locked flag) lives in
 * "messaging-vault-meta"; the encrypted entry blob lives in
 * "messaging-vault-v1". The derived key is cached for the session so
 * pagehide can perform a real lock without re-running PBKDF2.
 */

export const VAULT_META_KEY = "messaging-vault-meta";
export const VAULT_BLOB_KEY = "messaging-vault-v1";

/** Everything holding secrets: identity PRIVATE key material and messages.
 *  (user-id / display-name stay plaintext by design — routing metadata the
 *  relay already sees, and code reads them mid-session.) */
const PROTECTED_KEYS = ["messaging-protocol-state-v1", "messaging-history-v1"];

const PBKDF2_ITERATIONS = 310_000;

interface VaultMeta {
  v: 1;
  salt: string;
  iterations: number;
  locked: boolean;
}

interface VaultBlob {
  v: 1;
  entries: Record<string, { iv: string; ct: string }>;
}

let cachedKey: Bytes | null = null;

function readMeta(storage: Storage): VaultMeta | null {
  try {
    const raw = storage.getItem(VAULT_META_KEY);
    return raw ? (JSON.parse(raw) as VaultMeta) : null;
  } catch {
    return null;
  }
}

function writeMeta(storage: Storage, meta: VaultMeta): void {
  storage.setItem(VAULT_META_KEY, JSON.stringify(meta));
}

export function isVaultConfigured(storage: Storage): boolean {
  return readMeta(storage) !== null;
}

export function isLocked(storage: Storage): boolean {
  return readMeta(storage)?.locked === true;
}

async function deriveKeyBytes(passphrase: string, salt: Bytes, iterations: number): Promise<Bytes> {
  const base = await crypto.subtle.importKey(
    "raw",
    utf8(passphrase) as unknown as BufferSource,
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as unknown as BufferSource, iterations },
    base,
    256,
  );
  return new Uint8Array(bits) as Bytes;
}

/**
 * Enables vault protection and immediately locks. Safe to call repeatedly
 * (re-derives against the stored salt on subsequent calls).
 */
export async function enableAndLock(storage: Storage, passphrase: string): Promise<void> {
  let meta = readMeta(storage);
  if (!meta) {
    const salt = crypto.getRandomValues(new Uint8Array(16)) as Bytes;
    meta = { v: 1, salt: toB64(salt), iterations: PBKDF2_ITERATIONS, locked: false };
  }
  writeMeta(storage, meta);

  const keyBytes = await deriveKeyBytes(passphrase, fromB64(meta.salt), meta.iterations);
  cachedKey = keyBytes;

  const entries: Record<string, { iv: string; ct: string }> = {};
  for (const key of PROTECTED_KEYS) {
    const value = storage.getItem(key);
    if (value === null) continue;
    const { iv, ct } = await aesEncrypt(keyBytes, utf8(value), utf8(key));
    entries[key] = { iv, ct };
    storage.removeItem(key);
  }
  const blob: VaultBlob = { v: 1, entries };
  storage.setItem(VAULT_BLOB_KEY, JSON.stringify(blob));
  writeMeta(storage, { ...meta, locked: true });
}

/** Restores plaintext entries from the vault; throws if the passphrase is wrong. */
export async function unlock(storage: Storage, passphrase: string): Promise<void> {
  const raw = storage.getItem(VAULT_BLOB_KEY);
  const meta = readMeta(storage);
  if (!raw || !meta?.locked) throw new Error("vault is not locked");
  const blob = JSON.parse(raw) as VaultBlob;
  const keyBytes = await deriveKeyBytes(passphrase, fromB64(meta.salt), meta.iterations);

  for (const [key, bucket] of Object.entries(blob.entries)) {
    // Any failed decrypt here means wrong passphrase — surface that.
    const pt = await aesDecrypt(keyBytes, bucket.iv, bucket.ct, utf8(key));
    storage.setItem(key, fromUtf8(pt));
  }
  storage.removeItem(VAULT_BLOB_KEY);
  writeMeta(storage, { ...meta, locked: false });
  cachedKey = keyBytes;
}

/**
 * Locks using the cached session key (pagehide or explicit lock button).
 * No-op when the vault is not configured, already locked, or this session
 * never held the key (e.g. server-driven reload before unlock).
 */
export async function performLockIfPossible(storage: Storage): Promise<void> {
  const meta = readMeta(storage);
  if (!meta || meta.locked || !cachedKey) return;

  const entries: Record<string, { iv: string; ct: string }> = {};
  for (const key of PROTECTED_KEYS) {
    const value = storage.getItem(key);
    if (value === null) continue;
    const { iv, ct } = await aesEncrypt(cachedKey, utf8(value), utf8(key));
    entries[key] = { iv, ct };
    storage.removeItem(key);
  }
  storage.setItem(VAULT_BLOB_KEY, JSON.stringify({ v: 1, entries }));
  writeMeta(storage, { ...meta, locked: true });
}
