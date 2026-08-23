/**
 * Signal-style end-to-end encryption for the chat client.
 *
 * Implements:
 * - X3DH (Extended Triple Diffie-Hellman) session establishment from a
 *   prekey bundle, following the Signal X3DH specification
 *   (DH1 = IK_A x SPK_B, DH2 = EK_A x IK_B, DH3 = EK_A x SPK_B,
 *    DH4 = EK_A x OTK_B; SK = HKDF(DH1||DH2||DH3||DH4)).
 * - Double Ratchet with per-message forward secrecy, DH ratchet steps,
 *   and a bounded skipped-message-key cache for out-of-order delivery.
 *
 * Wire format per envelope:
 *   { to, message: RatchetMessage, x3dh?: {...} }  — x3dh present only while
 *   the session is unconfirmed (first flight from the initiator).
 *
 * Known P0-scope caveats:
 * - Private keys persist unencrypted in localStorage (browser-profile trust
 *   domain). At-rest encryption is a P2 item.
 * - Consumed one-time prekeys stay listed on the relay's copy of the bundle
 *   until republish; bundle rotation is a P1 item.
 */

import {
  Bytes,
  DhKeyPair,
  HKDF_SALT_ZERO,
  aesDecrypt,
  aesEncrypt,
  concatBytes,
  deserializeDhKeyPair,
  deserializeSigningKeyPair,
  ecdh,
  exportDhPublicKey,
  fromB64,
  fromUtf8,
  generateDhKeyPair,
  generateSigningKeyPair,
  hkdf,
  importSigningPublicKey,
  kdfChainKey,
  kdfRootKey,
  serializeDhKeyPair,
  serializeSigningKeyPair,
  sha256,
  signBytes,
  toB64,
  utf8,
  verifyBytes,
} from "./crypto";

// ---------------------------------------------------------------------------
// wire types (all strings b64)
// ---------------------------------------------------------------------------

export interface PreKeyBundle {
  userId: string;
  /** Optional human-readable profile name; cosmetic only, never trusted. */
  displayName?: string;
  /** ECDH identity public key — IK in X3DH. */
  dhIdentityKey: string;
  /** ECDSA signing public key — authenticates identity binding + prekeys. */
  signingKey: string;
  /** signature of dhIdentityKey bytes by signingKey. */
  identityBindingSig: string;
  signedPreKeyId: number;
  signedPreKey: string;
  signedPreKeySig: string;
  oneTimePreKeys: { id: number; key: string }[];
}

/** Header carried by every Double Ratchet message; also feeds AES-GCM AD. */
export interface RatchetMessage {
  /** sender's current ratchet public key */
  dh: string;
  /** number of messages in the sender's PREVIOUS sending chain */
  pn: number;
  /** index of this message within the sender's current chain */
  n: number;
  iv: string;
  ct: string;
}

/** X3DH material attached to an initiator's unconfirmed first flight. */
export interface X3dhMaterial {
  identityKey: string; // IK_A
  ephemeralKey: string; // EK_A
  signedPreKeyId: number;
  oneTimePreKeyId: number | null;
}

export interface SealedEnvelope {
  to: string;
  message: RatchetMessage;
  x3dh?: X3dhMaterial;
}

const MAX_SKIP = 200;
const BUNDLE_OTK_COUNT = 20;
const OTK_LOW_WATER = 5;
const STORAGE_KEY = "messaging-protocol-state-v1";
const X3DH_INFO = "x3dh-sk-v1";

function headerAd(header: { dh: string; pn: number; n: number }): Bytes {
  // Canonical field order must match between encrypt and decrypt sides.
  return utf8(JSON.stringify({ dh: header.dh, pn: header.pn, n: header.n }));
}

interface SessionState {
  rootKey: string;
  sendChainKey: string | null;
  recvChainKey: string | null;
  sendRatchetPriv: string; // pkcs8 b64
  sendRatchetPub: string; // raw b64
  recvRatchetPub: string | null;
  sendN: number;
  recvN: number;
  prevSendN: number;
  skipped: Record<string, { mk: string }>;
  /** OTK id we consumed at establishment; sent until peer confirms. */
  pendingOtkId: number | null;
  /** True once we successfully decrypted a peer message on this session. */
  confirmed: boolean;
}

interface ProtocolState {
  userId: string;
  dhIdentityPriv: string; // JSON SerializedDhKeyPair
  signingPriv: string; // JSON SerializedSigningKeyPair
  signedPreKeyId: number;
  signedPreKeyPriv: string; // JSON SerializedDhKeyPair (pub kept inside)
  oneTimePreKeys: { id: number; priv: string }[];
  sessions: Record<string, SessionState>;
}

export class MessagingProtocol {
  private state: ProtocolState | null = null;

  /**
   * Fired when the one-time prekey pool drops below the low-water mark after
   * a consumption. The host app should republish getBundle() to the relay.
   */
  onPrekeysLow: (() => Promise<void> | void) | null = null;

  constructor(private readonly storage: Storage) {}

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  async initialize(userId: string): Promise<void> {
    const stored = this.storage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as ProtocolState;
      if (parsed.userId === userId && parsed.signedPreKeyPriv) {
        this.state = parsed;
        return;
      }
    }
    await this.freshState(userId);
  }

  private async freshState(userId: string): Promise<void> {
    const [dhIdentity, signing] = await Promise.all([generateDhKeyPair(), generateSigningKeyPair()]);
    const dhIdentitySer = await serializeDhKeyPair(dhIdentity);
    const signingSer = await serializeSigningKeyPair(signing);

    const spk = await generateDhKeyPair();
    const spkSer = await serializeDhKeyPair(spk);

    const otkPairs = await Promise.all(Array.from({ length: BUNDLE_OTK_COUNT }, () => generateDhKeyPair()));
    const oneTimePreKeys = await Promise.all(
      otkPairs.map(async (pair, i) => ({ id: i + 1, priv: JSON.stringify(await serializeDhKeyPair(pair)) })),
    );

    this.state = {
      userId,
      dhIdentityPriv: JSON.stringify(dhIdentitySer),
      signingPriv: JSON.stringify(signingSer),
      signedPreKeyId: 1,
      signedPreKeyPriv: JSON.stringify(spkSer),
      oneTimePreKeys,
      sessions: {},
    };
    this.save();
  }

  private save(): void {
    if (!this.state) throw new Error("Protocol not initialized");
    this.storage.setItem(STORAGE_KEY, JSON.stringify(this.state));
  }

  private require(): ProtocolState {
    if (!this.state) throw new Error("Protocol not initialized");
    return this.state;
  }

  /** Public bundle to publish to the relay so peers can start sessions with us. */
  async getBundle(): Promise<PreKeyBundle> {
    const state = this.require();
    const signing = await deserializeSigningKeyPair(JSON.parse(state.signingPriv));
    const dhIdentity = await deserializeDhKeyPair(JSON.parse(state.dhIdentityPriv));
    const spkSer = JSON.parse(state.signedPreKeyPriv) as { pub: string };
    const identityPubB64 = await exportDhPublicKey(dhIdentity.publicKey);
    return {
      userId: state.userId,
      dhIdentityKey: identityPubB64,
      signingKey: (JSON.parse(state.signingPriv) as { pub: string }).pub,
      identityBindingSig: await signBytes(signing.privateKey, fromB64(identityPubB64)),
      signedPreKeyId: state.signedPreKeyId,
      signedPreKey: spkSer.pub,
      signedPreKeySig: await signBytes(signing.privateKey, fromB64(spkSer.pub)),
      oneTimePreKeys: state.oneTimePreKeys.map((otk) => ({
        id: otk.id,
        key: (JSON.parse(otk.priv) as { pub: string }).pub,
      })),
    };
  }

  hasSession(peerId: string): boolean {
    return Boolean(this.require().sessions[peerId]);
  }

  remainingOneTimePrekeys(): number {
    return this.require().oneTimePreKeys.length;
  }

  /**
   * Key for encrypting locally stored chat history. Derived from the identity
   * private key, which lives in the same storage — this protects against
   * casual inspection and cross-profile reads, not against a fully
   * compromised browser profile. A passphrase-derived key is the P3 upgrade.
   */
  async exportLocalHistoryKey(): Promise<Bytes> {
    const state = this.require();
    const ikm = fromB64((JSON.parse(state.dhIdentityPriv) as { priv: string }).priv);
    return hkdf(ikm, utf8(`local-history:${state.userId}`), "local-history-v1", 32);
  }

  /** Tops the pool back up to BUNDLE_OTK_COUNT with fresh keys; caller republishes. */
  async topUpOneTimePrekeys(): Promise<void> {
    const state = this.require();
    const deficit = BUNDLE_OTK_COUNT - state.oneTimePreKeys.length;
    if (deficit <= 0) return;
    const nextId = state.oneTimePreKeys.reduce((max, otk) => Math.max(max, otk.id), 0);
    const fresh = await Promise.all(
      Array.from({ length: deficit }, (_, i) => generateDhKeyPair().then(async (pair) => ({
        id: nextId + i + 1,
        priv: JSON.stringify(await serializeDhKeyPair(pair)),
      }))),
    );
    state.oneTimePreKeys.push(...fresh);
    this.save();
  }

  /**
   * Safety-number style fingerprint, deterministic over both identity keys.
   * Compare out-of-band with your peer before trusting the channel.
   */
  async fingerprint(theirDhIdentityKey: string): Promise<string> {
    const state = this.require();
    const mine = (JSON.parse(state.dhIdentityPriv) as { pub: string }).pub;
    const [a, b] = [mine, theirDhIdentityKey].sort();
    const digest = await sha256(concatBytes(utf8("fp-v1"), fromB64(a), fromB64(b)));
    const digits = Array.from(digest.slice(0, 15))
      .map((byte) => byte.toString().padStart(3, "0"))
      .join("");
    return (digits.match(/.{1,5}/g) ?? []).join(" ");
  }

  // -------------------------------------------------------------------------
  // X3DH initiation
  // -------------------------------------------------------------------------

  /**
   * Establish an outbound session from a verified peer bundle.
   * Keeps any existing session with this peer.
   */
  async establishSessionAsInitiator(peerId: string, bundle: PreKeyBundle): Promise<void> {
    const state = this.require();
    if (state.sessions[peerId]) return;

    const signingPub = await importSigningPublicKey(bundle.signingKey);
    const identityOk = await verifyBytes(signingPub, fromB64(bundle.dhIdentityKey), bundle.identityBindingSig);
    const spkOk = await verifyBytes(signingPub, fromB64(bundle.signedPreKey), bundle.signedPreKeySig);
    if (!identityOk || !spkOk) throw new Error(`Bundle signature verification failed for ${peerId}`);

    const myIdentity = await deserializeDhKeyPair(JSON.parse(state.dhIdentityPriv));
    const ephemeral = await generateDhKeyPair();

    const otk = bundle.oneTimePreKeys.length > 0 ? bundle.oneTimePreKeys[0] : null;

    const dh1 = await ecdh(myIdentity.privateKey, bundle.signedPreKey); // IK_A x SPK_B
    const dh2 = await ecdh(ephemeral.privateKey, bundle.dhIdentityKey); // EK_A x IK_B
    const dh3 = await ecdh(ephemeral.privateKey, bundle.signedPreKey); // EK_A x SPK_B
    const dh4 = otk ? await ecdh(ephemeral.privateKey, otk.key) : new Uint8Array(0); // EK_A x OTK_B

    const sk = await hkdf(concatBytes(dh1, dh2, dh3, dh4), HKDF_SALT_ZERO, X3DH_INFO, 32);

    // Double Ratchet init (initiator):
    //   RK0 = SK; CKs0 = KDF_RK(SK, DH(EK_A, SPK_B))
    const [, sendChain] = await kdfRootKey(sk, dh3);
    const ephemeralSer = await serializeDhKeyPair(ephemeral);

    state.sessions[peerId] = {
      rootKey: toB64(sk),
      sendChainKey: toB64(sendChain),
      recvChainKey: null,
      sendRatchetPriv: ephemeralSer.priv,
      sendRatchetPub: ephemeralSer.pub,
      recvRatchetPub: bundle.signedPreKey,
      sendN: 0,
      recvN: 0,
      prevSendN: 0,
      skipped: {},
      pendingOtkId: otk ? otk.id : null,
      confirmed: false,
    };
    this.save();
  }

  // -------------------------------------------------------------------------
  // encryption / decryption
  // -------------------------------------------------------------------------

  async encrypt(peerId: string, plaintext: string): Promise<SealedEnvelope> {
    const state = this.require();
    const session = state.sessions[peerId];
    if (!session) throw new Error(`No session with ${peerId} — call establishSessionAsInitiator first`);

    if (!session.sendChainKey) {
      // Responder's first send: take the DH ratchet step now.
      await this.ratchetStep(session);
    }

    const [messageKey, nextChain] = await kdfChainKey(fromB64(session.sendChainKey!));
    session.sendChainKey = toB64(nextChain);

    const header = { dh: session.sendRatchetPub, pn: session.prevSendN, n: session.sendN };
    const { iv, ct } = await aesEncrypt(messageKey, utf8(plaintext), headerAd(header));
    session.sendN += 1;

    const envelope: SealedEnvelope = { to: peerId, message: { ...header, iv, ct } };

    if (!session.confirmed) {
      envelope.x3dh = {
        identityKey: (JSON.parse(state.dhIdentityPriv) as { pub: string }).pub,
        ephemeralKey: session.sendRatchetPub,
        signedPreKeyId: state.signedPreKeyId,
        oneTimePreKeyId: session.pendingOtkId,
      };
    }
    this.save();
    return envelope;
  }

  async decryptFrom(peerId: string, envelope: SealedEnvelope): Promise<string> {
    const state = this.require();
    let session = state.sessions[peerId];

    if (envelope.x3dh && (!session || !session.confirmed)) {
      session = await this.initAsResponder(peerId, envelope.x3dh);
    }
    if (!session) throw new Error(`No session with ${peerId} and no X3DH material`);
    if (!envelope.message) throw new Error("Envelope has no message");

    const plaintext = await this.ratchetDecrypt(session, envelope.message);
    session.confirmed = true;
    session.pendingOtkId = null;
    this.save();
    return fromUtf8(plaintext);
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /** Responder-side X3DH: derive SK from our prekeys + initiator material. */
  private async initAsResponder(peerId: string, x3dh: X3dhMaterial): Promise<SessionState> {
    const state = this.require();

    const myIdentity = await deserializeDhKeyPair(JSON.parse(state.dhIdentityPriv));
    const mySpk = await deserializeDhKeyPair(JSON.parse(state.signedPreKeyPriv));
    if (x3dh.signedPreKeyId !== state.signedPreKeyId) {
      throw new Error(`Unknown signed prekey id ${x3dh.signedPreKeyId}`);
    }

    let otkPrivKey: CryptoKey | null = null;
    if (x3dh.oneTimePreKeyId !== null) {
      const found = state.oneTimePreKeys.find((o) => o.id === x3dh.oneTimePreKeyId);
      if (!found) throw new Error(`Unknown one-time prekey id ${x3dh.oneTimePreKeyId}`);
      otkPrivKey = (await deserializeDhKeyPair(JSON.parse(found.priv))).privateKey;
      // Consume: remove from our available set.
      state.oneTimePreKeys = state.oneTimePreKeys.filter((o) => o.id !== x3dh.oneTimePreKeyId);
    }

    const dh1 = await ecdh(mySpk.privateKey, x3dh.identityKey); // SPK_B x IK_A
    const dh2 = await ecdh(myIdentity.privateKey, x3dh.ephemeralKey); // IK_B x EK_A
    const dh3 = await ecdh(mySpk.privateKey, x3dh.ephemeralKey); // SPK_B x EK_A
    const dh4 = otkPrivKey ? await ecdh(otkPrivKey, x3dh.ephemeralKey) : new Uint8Array(0); // OTK_B x EK_A

    const sk = await hkdf(concatBytes(dh1, dh2, dh3, dh4), HKDF_SALT_ZERO, X3DH_INFO, 32);

    // Double Ratchet init (responder):
    //   RK0 = SK; CKr0 = KDF_RK(SK, DH(SPK_B, EK_A)) — mirrors initiator's CKs0.
    const [, recvChain] = await kdfRootKey(sk, dh3);

    const spkSer = JSON.parse(state.signedPreKeyPriv) as { pub: string; priv: string };

    const session: SessionState = {
      rootKey: toB64(sk),
      sendChainKey: null, // ratchet step happens on our first send
      recvChainKey: toB64(recvChain),
      sendRatchetPriv: spkSer.priv,
      sendRatchetPub: spkSer.pub,
      recvRatchetPub: x3dh.ephemeralKey,
      sendN: 0,
      recvN: 0,
      prevSendN: 0,
      skipped: {},
      pendingOtkId: null,
      confirmed: false,
    };
    state.sessions[peerId] = session;
    this.save();

    if (state.oneTimePreKeys.length < OTK_LOW_WATER && this.onPrekeysLow) {
      await this.topUpOneTimePrekeys();
      await this.onPrekeysLow();
    }
    return session;
  }

  /** DH ratchet step: fresh sending ratchet pair derived against peer's current ratchet key. */
  private async ratchetStep(session: SessionState): Promise<DhKeyPair> {
    const newPair = await generateDhKeyPair();
    const newSer = await serializeDhKeyPair(newPair);
    const dhOut = await ecdh(newPair.privateKey, session.recvRatchetPub!);
    const [newRoot, sendChain] = await kdfRootKey(fromB64(session.rootKey), dhOut);

    session.prevSendN = session.sendN; // receiver skips this many under our previous chain
    session.rootKey = toB64(newRoot);
    session.sendChainKey = toB64(sendChain);
    session.sendRatchetPriv = newSer.priv;
    session.sendRatchetPub = newSer.pub;
    session.sendN = 0;
    this.save();
    return newPair;
  }

  /** Core Double Ratchet decrypt with skipped-message-key handling. */
  private async ratchetDecrypt(session: SessionState, msg: RatchetMessage): Promise<Bytes> {
    const cached = session.skipped[`${msg.dh}:${msg.n}`];
    if (cached) {
      delete session.skipped[`${msg.dh}:${msg.n}`];
      return aesDecrypt(fromB64(cached.mk), msg.iv, msg.ct, headerAd(msg));
    }

    if (msg.dh !== session.recvRatchetPub) {
      // Peer turned the ratchet: cache remaining keys of the old receiving
      // chain (they cover messages sent under the previous chain length pn),
      // then derive the new receiving chain from our CURRENT sending private.
      if (session.recvChainKey) {
        await this.skipMessageKeys(session, msg.pn);
      }
      const sendPriv = await deserializeDhKeyPair({ pub: session.sendRatchetPub, priv: session.sendRatchetPriv });
      const dhOut = await ecdh(sendPriv.privateKey, msg.dh);
      const [newRoot, recvChain] = await kdfRootKey(fromB64(session.rootKey), dhOut);
      session.rootKey = toB64(newRoot);
      session.recvChainKey = toB64(recvChain);
      session.recvRatchetPub = msg.dh;
      session.recvN = 0;
    }

    if (!session.recvChainKey) throw new Error("No receiving chain established");
    await this.skipMessageKeys(session, msg.n);

    const [messageKey, nextChain] = await kdfChainKey(fromB64(session.recvChainKey));
    session.recvChainKey = toB64(nextChain);
    session.recvN += 1;
    return aesDecrypt(messageKey, msg.iv, msg.ct, headerAd(msg));
  }

  /** Advance the receiving chain to `until`, caching intermediate keys for late arrivals. */
  private async skipMessageKeys(session: SessionState, until: number): Promise<void> {
    if (!session.recvChainKey) return;
    if (session.recvN + MAX_SKIP < until) throw new Error("Too many skipped messages");

    while (session.recvN < until) {
      const [messageKey, nextChain] = await kdfChainKey(fromB64(session.recvChainKey));
      session.recvChainKey = toB64(nextChain);
      session.recvN += 1;
      if (session.recvRatchetPub) {
        const entries = Object.keys(session.skipped);
        if (entries.length >= MAX_SKIP) delete session.skipped[entries[0]];
        session.skipped[`${session.recvRatchetPub}:${session.recvN - 1}`] = { mk: toB64(messageKey) };
      }
    }
  }
}

export function createMessagingProtocol(storage: Storage): MessagingProtocol {
  return new MessagingProtocol(storage);
}
