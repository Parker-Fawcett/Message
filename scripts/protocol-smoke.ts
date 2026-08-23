/**
 * Protocol roundtrip validation against the real WebCrypto implementation.
 * Run: npx tsx scripts/protocol-smoke.ts
 * Covers: X3DH establishment, bidirectional ratchet turns, multi-message chains,
 * out-of-order delivery (skipped message keys), state persistence across reload.
 */
import { MessagingProtocol, PreKeyBundle, SealedEnvelope } from "../src/lib/signal-session";

function mockStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  } as Storage;
}

async function main() {
  // --- two parties ---------------------------------------------------------
  const aliceStore = mockStorage();
  const bobStore = mockStorage();
  const alice = new MessagingProtocol(aliceStore);
  const bob = new MessagingProtocol(bobStore);
  await alice.initialize("alice");
  await bob.initialize("bob");

  // --- bundle exchange (via "relay") ---------------------------------------
  const aliceBundle: PreKeyBundle = await alice.getBundle();
  const bobBundle: PreKeyBundle = await bob.getBundle();

  // --- Alice initiates -----------------------------------------------------
  await alice.establishSessionAsInitiator("bob", bobBundle);

  // fp symmetry sanity
  const fpA = await alice.fingerprint(bobBundle.dhIdentityKey);
  const fpB = await bob.fingerprint(aliceBundle.dhIdentityKey);
  if (fpA !== fpB) throw new Error(`fingerprint mismatch: ${fpA} vs ${fpB}`);

  const env1: SealedEnvelope = await alice.encrypt("bob", "hello bob");
  if (!env1.x3dh) throw new Error("first envelope must carry x3dh material");
  if ((await bob.decryptFrom("alice", env1)) !== "hello bob") throw new Error("msg1 failed");

  // --- Bob replies (ratchet turn on his side) ------------------------------
  const env2: SealedEnvelope = await bob.encrypt("alice", "hey alice!");
  if (env2.x3dh) throw new Error("responder replies must not carry x3dh material");
  if ((await alice.decryptFrom("bob", env2)) !== "hey alice!") throw new Error("msg2 failed");

  // --- sustained conversation, alternating turns ---------------------------
  for (let i = 0; i < 10; i++) {
    const aMsg = `alice-${i}`;
    const bMsg = `bob-${i}`;
    const ea = await alice.encrypt("bob", aMsg);
    if ((await bob.decryptFrom("alice", ea)) !== aMsg) throw new Error(`round ${i} a->b failed`);
    const eb = await bob.encrypt("alice", bMsg);
    if ((await alice.decryptFrom("bob", eb)) !== bMsg) throw new Error(`round ${i} b->a failed`);
  }

  // --- out-of-order delivery within one chain ------------------------------
  const o1 = await alice.encrypt("bob", "ooo-1");
  const o2 = await alice.encrypt("bob", "ooo-2");
  const o3 = await alice.encrypt("bob", "ooo-3");
  if ((await bob.decryptFrom("alice", o3)) !== "ooo-3") throw new Error("ooo-3 failed");
  if ((await bob.decryptFrom("alice", o1)) !== "ooo-1") throw new Error("ooo-1 failed");
  if ((await bob.decryptFrom("alice", o2)) !== "ooo-2") throw new Error("ooo-2 failed");

  // --- persistence: rebuild from storage, keep talking ----------------------
  const aliceReloaded = new MessagingProtocol(aliceStore);
  await aliceReloaded.initialize("alice");
  const eAfterReload = await aliceReloaded.encrypt("bob", "post-reload");
  if ((await bob.decryptFrom("alice", eAfterReload)) !== "post-reload") throw new Error("post-reload failed");

  // --- tamper check: flipped ciphertext must throw --------------------------
  const tampered: SealedEnvelope = JSON.parse(JSON.stringify(await alice.encrypt("bob", "tamper-me")));
  tampered.message.ct = (tampered.message.ct[0] === "A" ? "B" : "A") + tampered.message.ct.slice(1);
  let threw = false;
  try {
    await bob.decryptFrom("alice", tampered);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("tampered ciphertext decrypted successfully — AEAD broken!");

  console.log("ALL PROTOCOL CHECKS PASSED");
  console.log("fingerprint:", fpA);
}

/**
 * Exhaustion gauntlet: mimic relay pop-once OTK serving while 25 initiators
 * (pool starts at 20) each open first contact with the same Bob. Verifies
 * OTK-less X3DH fallback, low-water top-up, and that no OTK id is reused.
 */
async function exhaustionRounds() {
  const bobStore = mockStorage();
  const bob = new MessagingProtocol(bobStore);
  await bob.initialize("bob");

  // Relay simulation: serves each OTK id at most once per published bundle.
  let serverCopy = await bob.getBundle();
  const served = new Set<number>();
  bob.onPrekeysLow = async () => {
    serverCopy = await bob.getBundle();
    served.clear();
  };
  const serveBundle = (): PreKeyBundle => {
    const next = serverCopy.oneTimePreKeys.find((otk) => !served.has(otk.id));
    if (!next) return { ...serverCopy, oneTimePreKeys: [] };
    served.add(next.id);
    return { ...serverCopy, oneTimePreKeys: [next] };
  };

  const usedOtkIds = new Set<number>();
  const rounds = 25;
  for (let i = 0; i < rounds; i++) {
    const alice = new MessagingProtocol(mockStorage());
    await alice.initialize(`alice-${i}`);
    const bundle = serveBundle();
    for (const otk of bundle.oneTimePreKeys) {
      if (usedOtkIds.has(otk.id)) throw new Error(`OTK ${otk.id} handed out twice`);
      usedOtkIds.add(otk.id);
    }
    await alice.establishSessionAsInitiator("bob", bundle);
    const envelope = await alice.encrypt("bob", `round-${i}`);
    if ((await bob.decryptFrom(`alice-${i}`, envelope)) !== `round-${i}`) {
      throw new Error(`round ${i} failed`);
    }
  }

  // Crossing the initial 20-key supply proves replenishment fired; distinctness
  // is asserted inline above.
  if (usedOtkIds.size <= 20) {
    throw new Error(`replenishment never crossed initial supply: ${usedOtkIds.size} OTKs consumed`);
  }
  if (bob.remainingOneTimePrekeys() <= 0) {
    throw new Error("OTK pool drained despite top-up");
  }
  console.log(`EXHAUSTION GAUNTLET PASSED (${rounds} initiators, ${usedOtkIds.size} distinct OTKs consumed, pool at ${bob.remainingOneTimePrekeys()})`);
}

async function runAll() {
  await main();
  await exhaustionRounds();
  console.log("ALL PROTOCOL CHECKS PASSED (incl. exhaustion)");
}

runAll().catch((err) => {
  console.error("PROTOCOL SMOKE FAILED:", err);
  process.exit(1);
});
