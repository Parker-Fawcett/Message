/**
 * Peer bot: joins the relay as a full E2EE participant so a human tester
 * always has someone to talk to.
 *
 * - Real X3DH + Double Ratchet sessions via src/lib/signal-session
 *   (Node 22 ships WebCrypto; Storage is backed by a JSON file so the
 *   ratchet state survives restarts)
 * - Auto-replies with simple pattern matching (!help, !time, !joke, else
 *   friendly acks)
 * - Emits delivered/read receipts and a brief typing indicator before
 *   replying, like a normal client
 *
 * Run: npx tsx scripts/peer-bot.ts
 */
import { io } from "socket.io-client";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";

const LOG_FILE = "/tmp/bot-prod.log";
const log = (m: string) => {
  const line = `${new Date().toISOString().slice(11, 19)} ${m}`;
  try { appendFileSync(LOG_FILE, line + "\n"); } catch {}
  console.error(line);
};
import { createMessagingProtocol, type PreKeyBundle, type SealedEnvelope } from "../src/lib/signal-session";

const RELAY = process.env.BOT_RELAY || "http://localhost:3000";
const STATE_FILE = process.env.BOT_STATE || "bot-state.json";
const NAME = process.env.BOT_NAME || "Assistant";
const USER_ID = "u-assistant-bot";

/* ---------- file-backed Storage so ratchet state persists ---------- */

class FileStorage implements Storage {
  private data: Record<string, string>;
  constructor(file: string) {
    this.file = file;
    this.data = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  }
  private file: string;
  private flush() {
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
  get length() {
    return Object.keys(this.data).length;
  }
  clear(): void {
    this.data = {};
    this.flush();
  }
  getItem(k: string): string | null {
    return k in this.data ? this.data[k] : null;
  }
  key(i: number): string | null {
    return Object.keys(this.data)[i] ?? null;
  }
  removeItem(k: string): void {
    delete this.data[k];
    this.flush();
  }
  setItem(k: string, v: string): void {
    this.data[k] = v;
    this.flush();
  }
}

/* ---------- reply brain ---------- */

function reply(text: string): string {
  const t = text.toLowerCase().trim();

  if (/^!help/.test(t)) {
    return (
      "I'm the test peer — a real E2EE client running the same X3DH + Double Ratchet stack as your browser.\n\n" +
      "Try: !time · !joke · !who · or just talk to me."
    );
  }
  if (/^!time/.test(t)) return `Server clock says ${new Date().toLocaleTimeString()}.`;
  if (/^!who/.test(t)) {
    let peers: string[] = [];
    try {
      peers = JSON.parse(storage.getItem("bot-known-peers") ?? "[]");
    } catch {}
    const names = peers.map((id) => (id === USER_ID ? NAME : id));
    return `I have established encrypted sessions with: ${names.length > 0 ? names.join(", ") : "no one yet"}.`;
  }
  if (/^!joke/.test(t)) {
    const jokes = [
      "Why did the developer go broke? Because he used up all his cache.",
      "There are two hard things in distributed systems: clocks, ordering messages by timestamps, and off-by-one errors.",
      "I'd tell you an UDP joke but you might not get it.",
      "My passphrase vault joke is unrepeatable.",
    ];
    return jokes[Math.floor(Math.random() * jokes.length)];
  }
  if (/\b(hi|hello|hey|yo|sup)\b/.test(t)) {
    const who = text.length < 12 ? "" : "";
    return `Hey${who}! You're reading this because your client just negotiated a Double Ratchet session with me. Ask for !help.`;
  }
  if (/\?$/.test(t)) return "Good question — everything between us is end-to-end encrypted, so even the relay can't read either side.";
  if (/\b(thanks|thank you|ty)\b/.test(t)) return "Anytime. Your keys, your messages.";
  if (t.length <= 3) return "Short and cryptic — respect.";

  const words = text.split(/\s+/).length;
  return `Noted (${words} word${words === 1 ? "" : "s"}, sealed with AES-GCM under a key only you and I derived). Send !help for tricks.`;
}

/* ---------- wiring ---------- */

const storage = new FileStorage(STATE_FILE);
const protocol = createMessagingProtocol(storage);
let socket: ReturnType<typeof io> | null = null;

const joinedRooms = new Set<string>();
const pendingReplies = new Set<string>(); // dedupe guard

const dmRoomId = (a: string, b: string) => `dm:${[a, b].sort().join("__")}`;

interface BundleLike {
  userId: string;
  displayName?: string;
  oneTimePreKeys: { id: number; key: string }[];
  [k: string]: unknown;
}

async function ensureSession(peerId: string): Promise<boolean> {
  if (protocol.hasSession(peerId)) return true;
  // Fetch a fresh bundle through the relay (OTK handout happens server-side).
  const got = await new Promise<PreKeyBundle | null>((resolve) => {
    if (!socket) return resolve(null);
    socket.timeout(10000).emit("get-bundle", peerId, (err: Error | null, resp: PreKeyBundle | null) => {
      resolve(err ? null : resp);
    });
  });
  if (!got) return false;
  try {
    await protocol.establishSessionAsInitiator(peerId, got);
    return true;
  } catch (e) {
    console.error(`[${NAME}] establish failed for ${peerId}:`, e instanceof Error ? e.message : e);
    return false;
  }
}

async function sendTo(peerId: string, text: string): Promise<void> {
  if (!socket) return;
  const roomId = dmRoomId(USER_ID, peerId);
  let envelope: SealedEnvelope;
  try {
    envelope = await protocol.encrypt(peerId, text);
  } catch (e) {
    console.error(`[${NAME}] encrypt failed for ${peerId}:`, e instanceof Error ? e.message : e);
    return;
  }
  socket.emit("send-message", {
    roomId,
    id: Math.random().toString(36).substring(2, 11),
    senderId: USER_ID,
    timestamp: new Date().toISOString(),
    kind: "e2ee",
    envelopes: [{ to: peerId, ...envelope }],
  });
}

async function handleIncoming(data: {
  roomId: string;
  id: string;
  senderId: string;
  timestamp: string;
  envelopes: SealedEnvelope[];
}) {
  if (!socket) return;
  joinedRooms.add(data.roomId);
  socket.emit("join-room", data.roomId);
  const env = data.envelopes.find((e) => e.to === USER_ID);
  if (!env) return;

  socket.emit("message-delivered", { roomId: data.roomId, messageId: data.id });

  let plaintext: string;
  try {
    plaintext = await protocol.decryptFrom(data.senderId, env);
  } catch (e) {
    log(`DECRYPT FAILED from ${data.senderId} (msg ${data.id}): ${e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)}`);
    return;
  }

  log(`[in]  ${data.senderId}: ${plaintext}`);
  rememberPeer(data.senderId);
  socket.emit("message-read", { roomId: data.roomId, messageId: data.id });

  const response = reply(plaintext);

  // small human-feel pause with typing indicator
  socket.emit("typing", { roomId: data.roomId, isTyping: true });
  await new Promise((r) => setTimeout(r, 500 + Math.random() * 600));
  socket.emit("typing", { roomId: data.roomId, isTyping: false });

  await sendTo(data.senderId, response);
  log(`[out] ${data.senderId}: ${response}`);
}

function rememberPeer(peerId: string): void {
  try {
    const raw = storage.getItem("bot-known-peers");
    const set = new Set<string>(raw ? JSON.parse(raw) : []);
    set.add(peerId);
    storage.setItem("bot-known-peers", JSON.stringify([...set]));
  } catch {}
}

async function boot() {
  await protocol.initialize(USER_ID);
  try {
    const known = JSON.parse(storage.getItem("bot-known-peers") ?? "[]") as string[];
    for (const peerId of known) {
      const room = dmRoomId(USER_ID, peerId);
      joinedRooms.add(room); // re-joined on every connect below
    }
  } catch {}

  const bundle = await protocol.getBundle();
  const withName = { ...bundle, displayName: NAME };

  socket = io(RELAY);

  socket.on("connect", () => {
    log(`[${NAME}] connected to ${RELAY} as ${USER_ID}`);
    joinedRooms.clear();
    socket!.emit("publish-bundle", { userId: USER_ID, bundle: withName });
    for (const room of joinedRooms) socket!.emit("join-room", room);
    socket!.emit("get-bundles");
  });

  const joinDiscovered = (resp: { bundles: BundleLike[] }) => {
    for (const b of resp.bundles) {
      const room = dmRoomId(USER_ID, b.userId);
      if (!joinedRooms.has(room)) {
        joinedRooms.add(room);
        socket?.emit("join-room", room);
      }
    }
  };
  socket.on("bundles", (resp: { bundles: BundleLike[] }) => {
    log(`bundles: ${resp.bundles.length} bundles [${resp.bundles.map((b) => b.userId).join(",")}]`);
    joinDiscovered(resp);
  });
  socket.on("peer-published", ({ userId }: { userId: string }) => {
    log(`peer-published: ${userId} -> refetching`);
    socket?.emit("get-bundles");
  });

  socket.on("receive-message", (data) => {
    const key = data.id;
    if (pendingReplies.has(key)) return;
    pendingReplies.add(key);
    setTimeout(() => pendingReplies.delete(key), 10_000);
    void handleIncoming(data);
  });

  socket.on("disconnect", () => log(`[${NAME}] disconnected — retrying`));
  socket.io.on("reconnect", () => log(`[${NAME}] transport reconnected`));
  socket.io.on("error", (e) => log(`manager error: ${String(e).slice(0, 80)}`));
  socket.onAny((ev) => log(`EV ${ev}`));

  // Stale-connection watchdog: through some proxies, an otherwise-alive
  // socket stops receiving broadcasts without ever firing disconnect.
  // If we hear nothing for 90s, force-recycle the transport.
  let lastActivity = Date.now();
  const touch = () => { lastActivity = Date.now(); };
  socket.onAny(touch);
  const sendTouch = () => { touch(); };
  ["connect", "publish-bundle", "get-bundles"].forEach((ev) => socket.on(ev as never, sendTouch));
  setInterval(() => {
    if (Date.now() - lastActivity > 45_000) {
      log("watchdog: silent >45s, recycling connection");
      lastActivity = Date.now();
      socket.disconnect();
      socket.connect();
    }
  }, 15_000);
}

process.on("uncaughtException", (e) => log(`UNCAUGHT: ${e.stack?.slice(0, 200) ?? e}`));
process.on("unhandledRejection", (e) => log(`UNHANDLED REJECTION: ${String(e).slice(0, 200)}`));

boot().catch((e) => {
  console.error("bot failed to start:", e);
  process.exit(1);
});
