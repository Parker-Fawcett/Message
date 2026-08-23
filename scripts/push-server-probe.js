/** Server-side push-path probe: register sub offline, send, expect tap. */
const { io } = require("socket.io-client");

const URL = "http://localhost:3000";

function once(socket, event, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting ${event}`)), timeoutMs);
    socket.once(event, (...args) => {
      clearTimeout(t);
      resolve(args);
    });
  });
}

async function main() {
  const bob = io(URL);
  await once(bob, "connect");
  bob.emit("publish-bundle", {
    userId: "u-probe-b",
    bundle: { userId: "u-probe-b", dhIdentityKey: "AA", signingKey: "BB", identityBindingSig: "CC", signedPreKeyId: 1, signedPreKey: "DD", signedPreKeySig: "EE", oneTimePreKeys: [] },
  });
  bob.emit("register-push", { userId: "u-probe-b", subscription: { endpoint: "loopback://u-probe-b" } });

  const alice = io(URL);
  await once(alice, "connect");
  alice.emit("publish-bundle", {
    userId: "u-probe-a",
    bundle: { userId: "u-probe-a", dhIdentityKey: "FF", signingKey: "GG", identityBindingSig: "HH", signedPreKeyId: 1, signedPreKey: "II", signedPreKeySig: "JJ", oneTimePreKeys: [] },
  });
  await new Promise((r) => setTimeout(r, 300));

  // Take Bob "offline".
  bob.disconnect();
  await new Promise((r) => setTimeout(r, 500));

  alice.emit("send-message", {
    roomId: "dm:probe",
    id: "probe-msg-1",
    senderId: "u-probe-a",
    timestamp: new Date().toISOString(),
    kind: "e2ee",
    envelopes: [{ to: "u-probe-b", message: { dh: "x", pn: 0, n: 0, iv: "y", ct: "z" } }],
  });
  await new Promise((r) => setTimeout(r, 800));
  alice.disconnect();
  console.log("PUSH SERVER PROBE DONE — check wire log for dir:push");
}

main().catch((e) => {
  console.error("PROBE FAILED:", e.message);
  process.exit(1);
});
