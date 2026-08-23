const { createServer } = require('http');
const { parse } = require('url');
const next = require('next');
const { Server } = require('socket.io');
const fs = require('fs');
const webpush = require('web-push');

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

const MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_QUEUED_PER_ROOM = 200;
// Offline identities vanish from discovery after this long without a
// republish; online users are never expired. Override for tests.
const BUNDLE_TTL_MS = parseInt(process.env.BUNDLE_TTL_MS || '', 10) || 7 * 24 * 60 * 60 * 1000;
// Loopback mode replaces real push-service delivery with wire-tap entries so
// the empirical suites can assert push fan-out without contacting FCM.
const PUSH_LOOPBACK = process.env.PUSH_MODE === 'loopback';
const VAPID_FILE = '.vapid.json';

function loadOrCreateVapid() {
  // Env-provided keys survive redeploys and keep existing subscriptions
  // valid; fall back to a generated .vapid.json for local development.
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }
  try {
    return JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
  } catch {
    const keys = webpush.generateVAPIDKeys();
    fs.writeFileSync(VAPID_FILE, JSON.stringify(keys));
    return keys;
  }
}

const vapidKeys = loadOrCreateVapid();
if (!PUSH_LOOPBACK) {
  webpush.setVapidDetails('mailto:dev@example.com', vapidKeys.publicKey, vapidKeys.privateKey);
}

// Optional wire tap for empirical audits: when MSG_WIRE_LOG is set, every
// payload the relay forwards is appended there (ciphertext by construction).
const WIRE_LOG = process.env.MSG_WIRE_LOG || null;
function tap(payload) {
  if (WIRE_LOG) {
    try {
      fs.appendFileSync(WIRE_LOG, JSON.stringify(payload) + '\n');
    } catch {}
  }
}

  // userId -> Set<pushSubscription>. Memory-only for now; subscriptions are
  // re-registered by clients on each visit.
  const pushSubsByUser = new Map();

  async function deliverPush(userId, meta) {
    const subs = pushSubsByUser.get(userId);
    if (!subs || subs.size === 0) return;
    for (const sub of subs) {
      if (PUSH_LOOPBACK) {
        tap({ dir: 'push', to: userId, endpoint: sub.endpoint, meta });
        continue;
      }
      try {
        await webpush.sendNotification(sub, JSON.stringify(meta));
      } catch (err) {
        if (err && (err.statusCode === 404 || err.statusCode === 410)) {
          subs.delete(sub);
        }
      }
    }
  }

  app.prepare().then(() => {
  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url, true);
    if (req.method === 'GET' && parsedUrl.pathname === '/push/public-key') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(vapidKeys.publicKey);
      return;
    }
    if (req.method === 'POST' && parsedUrl.pathname === '/shutdown') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('bye');
      setTimeout(() => process.exit(0), 100);
      return;
    }
    if (req.method === 'GET' && parsedUrl.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ pid: process.pid, port: Number(process.env.PORT || 3000), bundleTtlMs: BUNDLE_TTL_MS, pushLoopback: PUSH_LOOPBACK, wireTap: Boolean(WIRE_LOG) }));
      return;
    }
    handle(req, res, parsedUrl);
  });

  const io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  // Prekey bundle registry: userId -> { bundle, unserved, served, lastSeen }. The relay
  // stores and serves these so peers can establish E2EE sessions, but never
  // needs any private material or plaintext (message payloads are opaque
  // ciphertext). Entries persist across disconnects so offline peers remain
  // reachable; this is what makes store-and-forward of first-contact
  // messages possible. Each one-time prekey is handed out at most once.
  const bundlesByUser = new Map();

  // userId -> live connection count (multiple tabs share one identity).
  const onlineRefCount = new Map();

  // roomId -> FIFO of undelivered ciphertext messages awaiting acks.
  const queueByRoom = new Map();

  function markOnline(userId) {
    const next = (onlineRefCount.get(userId) || 0) + 1;
    onlineRefCount.set(userId, next);
    if (next === 1) io.emit('presence-delta', { userId, online: true });
  }

  function markOffline(userId) {
    const next = (onlineRefCount.get(userId) || 1) - 1;
    if (next <= 0) {
      onlineRefCount.delete(userId);
      io.emit('presence-delta', { userId, online: false });
    } else {
      onlineRefCount.set(userId, next);
    }
  }

  function sweepQueue(roomId) {
    const queue = queueByRoom.get(roomId);
    if (!queue) return;
    const now = Date.now();
    const alive = queue.filter((entry) => {
      const allAcked = entry.recipients.every((r) => entry.acked.has(r));
      return !allAcked && now - entry.ts < MESSAGE_TTL_MS;
    });
    if (alive.length > MAX_QUEUED_PER_ROOM) alive.splice(0, alive.length - MAX_QUEUED_PER_ROOM);
    if (alive.length === 0) queueByRoom.delete(roomId);
    else queueByRoom.set(roomId, alive);
  }

  // Drops bundles of identities that haven't republished within the TTL.
  // Online users are exempt — their tab may simply not have reloaded.
  function sweepStaleBundles() {
    const now = Date.now();
    for (const [userId, entry] of bundlesByUser) {
      if (onlineRefCount.has(userId)) continue;
      if (now - entry.lastSeen > BUNDLE_TTL_MS) {
        bundlesByUser.delete(userId);
        console.log(`Bundle expired for user ${userId}`);
      }
    }
  }

  sweepStaleBundles();
  setInterval(sweepStaleBundles, Math.min(BUNDLE_TTL_MS, 60 * 60 * 1000)).unref();

  // groupId -> { name, members }. Create-only MVP: no membership edits yet.
  // Messages inside a group are pairwise-encrypted per member by the sender;
  // the relay only sees opaque envelopes addressed to each member.
  const groupsByGroup = new Map();

  io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('create-group', ({ groupId, name, members }, ack) => {
      if (!groupId || !name || !Array.isArray(members) || members.length < 2) {
        if (typeof ack === 'function') ack(false);
        return;
      }
      groupsByGroup.set(groupId, { name, members: [...new Set(members)] });
      tap({ dir: 'group-created', groupId, members });
      io.emit('group-added', { groupId, name, members });
      if (typeof ack === 'function') ack(true);
    });

    socket.on('publish-bundle', ({ userId, bundle }) => {
      if (!userId || !bundle) return;
      const firstSeen = !socket.data.userId;
      socket.data.userId = userId;
      const prev = bundlesByUser.get(userId);
      // An OTK id already handed out stays dead forever, even across
      // republishes; brand-new ids start life as unserved.
      const servedSet = new Set(prev ? prev.served : []);
      console.log('[srv] publish', userId, 'otk count:', (bundle.oneTimePreKeys||[]).length, 'prevServed:', prev ? prev.served.length : 'none');
      const unserved = (bundle.oneTimePreKeys || [])
        .map((otk) => otk.id)
        .filter((id) => !servedSet.has(id));
      bundlesByUser.set(userId, {
        bundle,
        unserved,
        served: [...servedSet],
        lastSeen: Date.now()
      });
      if (firstSeen) {
        markOnline(userId);
        console.log(`Bundle published for user ${userId}`);
      }
      socket.broadcast.emit('peer-published', { userId });
    });

    // Single-peer fetch for session establishment. Hands out each one-time
    // prekey at most once so concurrent initiators never derive SKs from
    // the same OTK; an empty list falls back to OTK-less X3DH.
    socket.on('get-bundle', (targetUserId, ack) => {
      if (typeof ack !== 'function') return;
      sweepStaleBundles();
      const entry = bundlesByUser.get(targetUserId);
      if (!entry) return ack(null);

      // Hand out each one-time prekey at most once, ever.
      console.log('[srv] get-bundle', targetUserId, 'unserved:', JSON.stringify(entry.unserved));
      const otkId = entry.unserved.shift();
      const oneTimePreKeys = otkId !== undefined
        ? entry.bundle.oneTimePreKeys.filter((otk) => otk.id === otkId)
        : [];
      ack({ ...entry.bundle, oneTimePreKeys });
    });

    socket.on('get-bundles', () => {
      sweepStaleBundles();
      const mine = socket.data.userId;
      const bundles = [...bundlesByUser.entries()]
        .filter(([userId]) => userId !== mine)
        .map(([, entry]) => ({ ...entry.bundle, oneTimePreKeys: [] }));
      const online = [...onlineRefCount.keys()].filter((userId) => userId !== mine);
      const groups = [...groupsByGroup.entries()]
        .filter(([, group]) => mine && group.members.includes(mine))
        .map(([groupId, group]) => ({ groupId, name: group.name, members: group.members }));
      socket.emit('bundles', { bundles, online, groups });
    });

    socket.on('join-room', (roomId) => {
      socket.join(roomId);
      const userId = socket.data.userId;

      // Replay undelivered traffic addressed to this user, oldest first.
      if (userId) {
        const queue = queueByRoom.get(roomId) || [];
        for (const entry of queue) {
          if (entry.acked.has(userId)) continue;
          const theirs = entry.payload.envelopes?.some((env) => env.to === userId);
          if (theirs) {
            tap({ dir: 'replay', to: userId, payload: entry.payload });
            socket.emit('receive-message', entry.payload);
          }
        }
      }
      console.log(`User ${socket.id} joined room ${roomId}`);
    });

    socket.on('register-push', ({ userId, subscription }) => {
      if (!userId || !subscription) {
        tap({ dir: 'register-rejected', reason: !userId ? 'no-user' : 'no-sub' });
        return;
      }
      let subs = pushSubsByUser.get(userId);
      if (!subs) {
        subs = new Set();
        pushSubsByUser.set(userId, subs);
      }
      subs.add(subscription);
      tap({ dir: 'register', to: userId });
    });

    socket.on('send-message', (data) => {
      const recipients = [...new Set((data.envelopes || []).map((env) => env.to))];
      if (recipients.length > 0) {
        const queue = queueByRoom.get(data.roomId) || [];
        queue.push({
          messageId: data.id,
          payload: data,
          recipients,
          acked: new Set(),
          ts: Date.now()
        });
        queueByRoom.set(data.roomId, queue);
        sweepQueue(data.roomId);
      }
      tap({ dir: 'live', from: socket.data.userId, payload: data });
      socket.to(data.roomId).emit('receive-message', data);

      // Wake anyone who is offline and has a registered push subscription.
      // Payload carries routing metadata only — never message content.
      for (const env of data.envelopes || []) {
        if (!onlineRefCount.has(env.to)) {
          void deliverPush(env.to, { roomId: data.roomId, from: data.senderId, messageId: data.id });
        }
      }
    });

    socket.on('message-delivered', (data) => {
      const deliveredTo = socket.data.userId;
      const queue = queueByRoom.get(data.roomId) || [];
      for (const entry of queue) {
        if (entry.messageId !== data.messageId) continue;
        if (deliveredTo && entry.recipients.includes(deliveredTo)) {
          entry.acked.add(deliveredTo);
        }
      }
      sweepQueue(data.roomId);
      socket.to(data.roomId).emit('message-delivered', { roomId: data.roomId, messageId: data.messageId, deliveredTo });
    });

    socket.on('message-read', (data) => {
      socket.to(data.roomId).emit('message-read', { roomId: data.roomId, messageId: data.messageId, readBy: socket.data.userId });
    });

    socket.on('typing', (data) => {
      socket.to(data.roomId).emit('user-typing', { userId: socket.data.userId, roomId: data.roomId, isTyping: data.isTyping });
    });

    socket.on('disconnect', () => {
      const userId = socket.data.userId;
      if (userId) markOffline(userId);
      console.log('User disconnected:', socket.id);
    });
  });

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`> Ready on http://localhost:${PORT}`);
  });
});
