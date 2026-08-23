/* One-shot: uses the paused bot's state file to send a DM to TARGET_ID.
 * Usage: TARGET_ID=u-xxxx npx tsx scripts/.ping-user.ts
 */
import { io } from "socket.io-client";
import { readFileSync, writeFileSync } from "node:fs";
import { createMessagingProtocol } from "../src/lib/signal-session";

const FILE = "bot-state-prod.json";
const USER_ID = "u-assistant-bot";
const TARGET = process.env.TARGET_ID || "";

let data: Record<string, string> = {};
try {
  data = JSON.parse(readFileSync(FILE, "utf8"));
} catch {}

const storage: Storage = {
  getItem: (k) => (k in data ? data[k] : null),
  setItem: (k, v) => {
    data[k] = String(v);
    writeFileSync(FILE, JSON.stringify(data, null, 2));
  },
  removeItem: (k) => {
    delete data[k];
    writeFileSync(FILE, JSON.stringify(data, null, 2));
  },
  clear: () => (data = {}),
  key: () => null,
  get length() {
    return Object.keys(data).length;
  },
};

async function main() {
  const protocol = createMessagingProtocol(storage);
  await protocol.initialize(USER_ID);

  if (!protocol.hasSession(TARGET)) {
    console.log(JSON.stringify({ ok: false, reason: "no session with " + TARGET }));
    process.exit(2);
  }

  const socket = io("https://message-2fii.onrender.com");
  await new Promise<void>((r) => socket.once("connect", r));

  const env = await protocol.encrypt(
    TARGET,
    "Test ping from Assistant — if you can read this, your inbound path works. Please reply!",
  );
  const roomId = `dm:${[USER_ID, TARGET].sort().join("__")}`;
  socket.emit("join-room", roomId);
  socket.emit("send-message", {
    roomId,
    id: "ping-" + Date.now(),
    senderId: USER_ID,
    timestamp: new Date().toISOString(),
    kind: "e2ee",
    envelopes: [{ to: TARGET, ...env }],
  });
  console.log(JSON.stringify({ ok: true, sentTo: TARGET }));
  setTimeout(() => process.exit(0), 1500);
}

main().catch((e) => {
  console.error("PING FAILED:", e.message);
  process.exit(1);
});
