import { io } from "socket.io-client";
import { createMessagingProtocol } from "../src/lib/signal-session";

const RELAY = "https://message-2fii.onrender.com";
const MY_ID = `u-diag-${Math.random().toString(36).substring(2, 8)}`;
const store = new Map<string, string>();
const fs: Storage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => void store.set(k, v),
  removeItem: (k) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  get length() { return store.size; },
};

(async () => {
  const protocol = createMessagingProtocol(fs);
  await protocol.initialize(MY_ID);
  const socket = io(RELAY);
  await new Promise<void>((r) => socket.once("connect", r));
  console.log("connected");

  await protocol.initialize(MY_ID);
  const myBundle = await protocol.getBundle();
  socket.emit("publish-bundle", { userId: MY_ID, bundle: myBundle });
  await new Promise((r) => setTimeout(r, 500));

  const got: any = await new Promise<any>((resolve) => {
    socket.once("bundles", resolve);
    socket.emit("get-bundles");
    setTimeout(() => resolve({ bundles: [] }), 8000);
  });
  const botBundle = got?.bundles?.find((x: any) => x.userId === "u-assistant-bot");
  if (!botBundle) throw new Error("assistant bundle missing");
  console.log("bot OTKs served:", botBundle.oneTimePreKeys.length);

  await protocol.establishSessionAsInitiator("u-assistant-bot", botBundle);
  const roomId = `dm:${[MY_ID, "u-assistant-bot"].sort().join("__")}`;
  socket.emit("join-room", roomId);

  const env = await protocol.encrypt("u-assistant-bot", "!who");
  socket.emit("send-message", {
    roomId, id: "diag-" + Date.now(), senderId: MY_ID,
    timestamp: new Date().toISOString(), kind: "e2ee",
    envelopes: [{ to: "u-assistant-bot", ...env }],
  });

  const reply = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("no reply in 25s")), 25000);
    socket.on("receive-message", async (data: any) => {
      const e = data.envelopes?.find((x: any) => x.to === MY_ID);
      if (!e) return;
      clearTimeout(t);
      try { resolve(await protocol.decryptFrom(data.senderId, e)); }
      catch (err) { reject(err); }
    });
  });
  console.log("REPLY:", reply.split("\n")[0]);
  console.log("PROD PIPELINE VERIFIED (fresh identity, OTK handout)");
  socket.disconnect();
  process.exit(0);
})().catch((e) => { console.error("DIAG FAILED:", e.message); process.exit(1); });
