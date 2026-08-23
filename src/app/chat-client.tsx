"use client";

import { useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import {
  createMessagingProtocol,
  type MessagingProtocol,
  type PreKeyBundle,
  type SealedEnvelope,
} from "../lib/signal-session";
import { capMessages, loadAllHistory, saveRoomHistory, type StoredMessage } from "../lib/history";
import {
  enableAndLock,
  isLocked as vaultIsLocked,
  isVaultConfigured as vaultHasMeta,
  performLockIfPossible,
  unlock as unlockVault,
} from "../lib/local-vault";

interface Message {
  id: string;
  text: string;
  senderId: string;
  timestamp: Date;
  isOwn: boolean;
  status?: "sent" | "delivered" | "read";
}

interface WireMessage {
  id: string;
  senderId: string;
  timestamp: string;
  kind: "e2ee";
  roomId: string;
  envelopes: SealedEnvelope[];
}

interface Group {
  groupId: string;
  name: string;
  members: string[];
}

type Conversation =
  | { kind: "dm"; peerId: string }
  | { kind: "group"; groupId: string };

function dmRoomId(a: string, b: string): string {
  return `dm:${[a, b].sort().join("__")}`;
}

function groupRoomId(groupId: string): string {
  return `group:${groupId}`;
}

function roomFor(conv: Conversation, myId: string): string {
  return conv.kind === "dm" ? dmRoomId(myId, conv.peerId) : groupRoomId(conv.groupId);
}

const USER_ID_KEY = "messaging-user-id";
const DISPLAY_NAME_KEY = "messaging-display-name";
const UNABLE_TO_DECRYPT = "[Unable to decrypt]";

function shortLabel(userId: string): string {
  return userId.length > 10 ? `${userId.slice(0, 10)}…` : userId;
}

function resolveUserId(): string {
  const existing = localStorage.getItem(USER_ID_KEY);
  if (existing) return existing;
  const created = `u-${Math.random().toString(36).substring(2, 11)}`;
  localStorage.setItem(USER_ID_KEY, created);
  return created;
}

function myUserId(): string {
  return localStorage.getItem(USER_ID_KEY) ?? "";
}

function emitWithAck<T>(socket: Socket, event: string, ...args: unknown[]): Promise<T> {
  return new Promise((resolve, reject) => {
    socket.timeout(10000).emit(event, ...args, (err: Error | null, response: T) => {
      if (err) reject(err);
      else resolve(response);
    });
  });
}

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

async function subscribeToPush(socket: Socket, userId: string): Promise<boolean> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return false;
  try {
    // Loopback hook for empirical suites: registers a fake endpoint instead
    // of contacting a real push service, and skips the permission prompt.
    if (localStorage.getItem("messaging-push-loopback") === "1") {
      socket.emit("register-push", {
        userId,
        subscription: { endpoint: `loopback://${userId}` },
      });
      return true;
    }

    const permission = await Notification.requestPermission();
    if (permission !== "granted") return false;

    const registration = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    const res = await fetch("/push/public-key");
    const publicKey = await res.text();
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    socket.emit("register-push", { userId, subscription: subscription.toJSON() });
    return true;
  } catch (err) {
    console.error("push subscription failed", err);
    return false;
  }
}

export default function ChatPage() {
  const [messagesByRoom, setMessagesByRoom] = useState<Record<string, Message[]>>({});
  const [input, setInput] = useState("");
  const [isConnected, setIsConnected] = useState(false);
  const [peers, setPeers] = useState<Record<string, PreKeyBundle>>({});
  const [onlineCount, setOnlineCount] = useState(0);
  const [isReady, setIsReady] = useState(false);
  const [groups, setGroups] = useState<Record<string, Group>>({});
  const [activeConv, setActiveConv] = useState<Conversation | null>(null);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [typingRooms, setTypingRooms] = useState<Record<string, boolean>>({});
  const [pushEnabled, setPushEnabled] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [vaultLocked, setVaultLocked] = useState(false);
  const [vaultConfigured, setVaultConfigured] = useState(false);
  const [showVaultForm, setShowVaultForm] = useState(false);
  const [vaultPass1, setVaultPass1] = useState("");
  const [vaultPass2, setVaultPass2] = useState("");
  const [vaultError, setVaultError] = useState("");

  useEffect(() => {
    setDisplayName(localStorage.getItem(DISPLAY_NAME_KEY) ?? "");
  }, []);

  const publishIdentity = async () => {
    const socket = socketRef.current;
    const protocol = protocolRef.current;
    if (!socket || !protocol) return;
    const base = await protocol.getBundle();
    const name = displayName.trim();
    socket.emit("publish-bundle", {
      userId: myUserId(),
      bundle: name ? { ...base, displayName: name } : base,
    });
  };

  const protocolRef = useRef<MessagingProtocol | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const peersRef = useRef<Record<string, PreKeyBundle>>({});
  const groupsRef = useRef<Record<string, Group>>({});
  const messagesRef = useRef<Record<string, Message[]>>({});
  const activeConvRef = useRef<Conversation | null>(null);
  const chatVisibleRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const decryptChainRef = useRef<Promise<void>>(Promise.resolve());
  const joinedRoomsRef = useRef<Set<string>>(new Set());
  const bootRef = useRef<() => Promise<void>>(async () => {});
  const historyKeyRef = useRef<import("../lib/crypto").Bytes | null>(null);

  // Write-through encrypted flush of every room's history. Deliberately NOT
  // debounced: a quick reload/close would otherwise lose the tail.
  useEffect(() => {
    const key = historyKeyRef.current;
    if (!key) return;
    for (const [roomId, msgs] of Object.entries(messagesByRoom)) {
      void saveRoomHistory(localStorage, key, roomId, capMessages(msgs.map(toStored)));
    }
  }, [messagesByRoom]);

  function toStored(m: Message): StoredMessage {
    return { id: m.id, text: m.text, senderId: m.senderId, timestamp: m.timestamp.toISOString(), isOwn: m.isOwn, status: m.status };
  }

  useEffect(() => {
    messagesRef.current = messagesByRoom;
  }, [messagesByRoom]);

  useEffect(() => {
    activeConvRef.current = activeConv;
  }, [activeConv]);

  useEffect(() => {
    let disposed = false;
    const userId = resolveUserId();

    const socket = io();
    socketRef.current = socket;

    // Publish → fetch bundles → join every peer's DM room, in that order on
    // each (re)connect: the server keys replay and presence off
    // publish-bundle's identity.
    const boot = async () => {
      try {
        if (vaultIsLocked(localStorage)) {
          setVaultLocked(true);
          return;
        }
        setVaultConfigured(vaultHasMeta(localStorage));
        const protocol = createMessagingProtocol(localStorage);
        protocol.onPrekeysLow = async () => {
          await publishIdentity();
        };
        await protocol.initialize(userId);
        if (disposed) return;
        protocolRef.current = protocol;
        historyKeyRef.current = await protocol.exportLocalHistoryKey();
        const restored = await loadAllHistory(localStorage, historyKeyRef.current);
        if (disposed) return;
        setMessagesByRoom((prev) => {
          const merged = { ...prev };
          for (const [roomId, msgs] of Object.entries(restored)) {
            const known = new Set((prev[roomId] ?? []).map((m) => m.id));
            const revived = msgs.filter((m) => !known.has(m.id)).map((m) => ({ ...m, timestamp: new Date(m.timestamp) }));
            merged[roomId] = [...revived, ...(prev[roomId] ?? [])];
          }
          return merged;
        });
        await publishIdentity();
        socket.emit("get-bundles");
        setIsReady(true);
      } catch (err) {
        console.error("E2EE bootstrap failed", err);
      }
    };
    bootRef.current = boot;

    socket.on("connect", () => {
      setIsConnected(true);
      joinedRoomsRef.current = new Set();
      void boot();
    });

    socket.on("disconnect", () => {
      setIsConnected(false);
    });

    const ensureJoined = (roomIds: string[]) => {
      for (const roomId of roomIds) {
        if (!joinedRoomsRef.current.has(roomId)) {
          joinedRoomsRef.current.add(roomId);
          socket.emit("join-room", roomId);
        }
      }
    };

    const joinAll = () => {
      const rooms: string[] = [];
      for (const peerId of Object.keys(peersRef.current)) {
        if (peerId !== userId) rooms.push(dmRoomId(userId, peerId));
      }
      for (const groupId of Object.keys(groupsRef.current)) {
        rooms.push(groupRoomId(groupId));
      }
      ensureJoined(rooms);
    };

    socket.on("bundles", ({ bundles, online, groups: discoveredGroups }: { bundles: PreKeyBundle[]; online: string[]; groups?: Group[] }) => {
      if (disposed) return;
      const next = Object.fromEntries(bundles.map((bundle) => [bundle.userId, bundle]));
      peersRef.current = next;
      setPeers(next);
      setOnlineCount(online.length);
      const nextGroups = Object.fromEntries((discoveredGroups ?? []).map((g) => [g.groupId, g]));
      groupsRef.current = nextGroups;
      setGroups(nextGroups);
      joinAll();
    });

    socket.on("group-added", ({ groupId }: { groupId: string }) => {
      // Discovery refresh picks up membership + joins the room.
      socket.emit("get-bundles");
      void groupId;
    });

    socket.on("presence-delta", ({ userId: peerId, online }: { userId: string; online: boolean }) => {
      if (disposed || peerId === userId) return;
      setOnlineCount((prev) => Math.max(0, prev + (online ? 1 : -1)));
    });

    socket.on("peer-published", () => {
      socket.emit("get-bundles");
    });

    socket.on("receive-message", (data: WireMessage) => {
      const protocol = protocolRef.current;
      if (!protocol || data.kind !== "e2ee") return;
      if (data.senderId === userId) return;

      if (!(data.senderId in peersRef.current)) {
        socket.emit("get-bundles");
      }

      if ((messagesRef.current[data.roomId] ?? []).some((m) => m.id === data.id)) return;

      const envelope = data.envelopes.find((candidate) => candidate.to === userId);
      if (!envelope) return;

      // Serialize decryption: queued replays arrive as a burst and each
      // handler mutates shared ratchet state — concurrent runs would corrupt
      // chain advancement. The promise chain preserves arrival order.
      decryptChainRef.current = decryptChainRef.current
        .then(async () => {
          let text: string;
          try {
            text = await protocol.decryptFrom(data.senderId, envelope);
          } catch {
            text = UNABLE_TO_DECRYPT;
          }
          if (disposed) return;
          setMessagesByRoom((prev) => {
            const bucket = prev[data.roomId] ?? [];
            if (bucket.some((m) => m.id === data.id)) return prev;
            return {
              ...prev,
              [data.roomId]: [
                ...bucket,
                {
                  id: data.id,
                  text,
                  senderId: data.senderId,
                  timestamp: new Date(data.timestamp),
                  isOwn: false,
                  status: "delivered",
                },
              ],
            };
          });
          const myRoom = activeConvRef.current ? roomFor(activeConvRef.current, userId) : null;
          if (myRoom !== data.roomId || document.hidden) {
            setUnread((prev) => ({ ...prev, [data.roomId]: (prev[data.roomId] ?? 0) + 1 }));
          }
          socket.emit("message-delivered", { roomId: data.roomId, messageId: data.id });
        })
        .catch((err) => console.error("decrypt pipeline error", err));
    });

    socket.on("message-delivered", (ev: { messageId: string; deliveredTo: string }) => {
      if (ev.deliveredTo === userId) return;
      setMessagesByRoom((prev) =>
        Object.fromEntries(
          Object.entries(prev).map(([roomId, msgs]) => [
            roomId,
            msgs.map((m) =>
              m.id === ev.messageId && m.isOwn && m.status !== "read" ? { ...m, status: "delivered" as const } : m,
            ),
          ]),
        ),
      );
    });

    socket.on("message-read", (ev: { messageId: string; readBy: string }) => {
      if (ev.readBy === userId) return;
      setMessagesByRoom((prev) =>
        Object.fromEntries(
          Object.entries(prev).map(([roomId, msgs]) => [
            roomId,
            msgs.map((m) => (m.id === ev.messageId && m.isOwn ? { ...m, status: "read" as const } : m)),
          ]),
        ),
      );
    });

    socket.on("user-typing", (ev: { userId: string; roomId: string; isTyping: boolean }) => {
      if (ev.userId === userId) return;
      setTypingRooms((prev) => ({ ...prev, [ev.roomId]: ev.isTyping }));
    });

    return () => {
      disposed = true;
      socket.disconnect();
    };
  }, []);

  // Auto-select the first conversation once peers/groups are known.
  useEffect(() => {
    setActiveConv((current) => {
      if (current) return current;
      const firstDm = Object.keys(peers)[0];
      if (firstDm) return { kind: "dm", peerId: firstDm };
      const firstGroup = Object.keys(groups)[0];
      if (firstGroup) return { kind: "group", groupId: firstGroup };
      return null;
    });
  }, [peers, groups]);

  const activeRoomId = activeConv ? roomFor(activeConv, myUserId()) : null;

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const activeMessages = (activeRoomId ? messagesByRoom[activeRoomId] : undefined) ?? [];
  const otherTypingInActive = Boolean(activeRoomId && typingRooms[activeRoomId]);
  const typingCount = otherTypingInActive;

  useEffect(() => {
    scrollToBottom();
  }, [activeMessages.length, typingCount, activeRoomId]);

  // Opening/being inside a conversation marks its incoming messages read.
  useEffect(() => {
    if (!chatVisibleRef.current || !socketRef.current || !activeRoomId) return;
    const unreadMsgs = (messagesByRoom[activeRoomId] ?? []).filter((m) => !m.isOwn && m.status !== "read");
    if (unreadMsgs.length === 0) return;
    unreadMsgs.forEach((msg) => {
      socketRef.current?.emit("message-read", { roomId: activeRoomId, messageId: msg.id });
    });
    setMessagesByRoom((prev) => ({
      ...prev,
      [activeRoomId]: (prev[activeRoomId] ?? []).map((m) =>
        !m.isOwn && m.status !== "read" ? { ...m, status: "read" as const } : m,
      ),
    }));
    setUnread((prev) => ({ ...prev, [activeRoomId]: 0 }));
  }, [activeRoomId, messagesByRoom]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      chatVisibleRef.current = !document.hidden;
    };
    const handlePageHide = () => {
      void performLockIfPossible(localStorage);
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", handlePageHide);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", handlePageHide);
    };
  }, []);

  const sendMessage = async () => {
    const text = input.trim();
    const protocol = protocolRef.current;
    const socket = socketRef.current;
    const conv = activeConvRef.current;
    if (!text || !socket || !protocol || !conv) return;

    // Pairwise fan-out: one independent encrypted envelope per recipient.
    const targets =
      conv.kind === "dm" ? [conv.peerId] : groupsRef.current[conv.groupId]?.members.filter((m) => m !== myUserId()) ?? [];

    const roomId = roomFor(conv, myUserId());
    const envelopes: SealedEnvelope[] = [];
    try {
      for (const target of targets) {
        if (!protocol.hasSession(target)) {
          // Fresh bundle per establishment: the relay hands each one-time
          // prekey out exactly once, so cached bundles go stale immediately.
          const bundle = await emitWithAck<PreKeyBundle | null>(socket, "get-bundle", target);
          if (!bundle) throw new Error(`no bundle available for ${target}`);
          await protocol.establishSessionAsInitiator(target, bundle);
        }
        envelopes.push(await protocol.encrypt(target, text));
      }
    } catch (err) {
      console.error(`encrypt failed during group/dm send`, err);
      return;
    }
    if (envelopes.length === 0) return;

    const wireMessage: WireMessage = {
      id: Math.random().toString(36).substring(2, 11),
      senderId: myUserId(),
      timestamp: new Date().toISOString(),
      kind: "e2ee",
      roomId,
      envelopes,
    };

    setMessagesByRoom((prev) => ({
      ...prev,
      [roomId]: [
        ...(prev[roomId] ?? []),
        { id: wireMessage.id, text, senderId: wireMessage.senderId, timestamp: new Date(), isOwn: true, status: "sent" },
      ],
    }));
    socket.emit("send-message", wireMessage);
    setInput("");
    socket.emit("typing", { roomId, isTyping: false });
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    textareaRef.current?.focus();
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInput(value);
    const socket = socketRef.current;
    const conv = activeConvRef.current;
    if (!socket || !conv) return;
    const roomId = roomFor(conv, myUserId());

    if (value.trim() && !typingTimeoutRef.current) {
      socket.emit("typing", { roomId, isTyping: true });
    }
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      typingTimeoutRef.current = null;
      socket.emit("typing", { roomId, isTyping: false });
    }, 1000);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  };

  const enablePush = async () => {
    const socket = socketRef.current;
    if (!socket) return;
    const ok = await subscribeToPush(socket, myUserId());
    setPushEnabled(ok);
  };

  const saveDisplayName = () => {
    setEditingName(false);
    const name = displayName.trim().slice(0, 32);
    localStorage.setItem(DISPLAY_NAME_KEY, name);
    void publishIdentity();
  };

  const enableVault = async () => {
    setVaultError("");
    if (vaultPass1.length < 8) {
      setVaultError("Passphrase must be at least 8 characters.");
      return;
    }
    if (vaultPass1 !== vaultPass2) {
      setVaultError("Passphrases do not match.");
      return;
    }
    try {
      await enableAndLock(localStorage, vaultPass1);
      // Reload into the locked gate — the cleanest way to prove the round-trip.
      window.location.reload();
    } catch (err) {
      console.error("vault enable failed", err);
      setVaultError(String(err));
    }
  };

  const submitUnlock = async () => {
    setVaultError("");
    try {
      await unlockVault(localStorage, vaultPass1 || "");
      setVaultLocked(false);
      setVaultPass1("");
      await bootRef.current?.();
    } catch {
      setVaultError("Wrong passphrase.");
    }
  };

  const lockNow = async () => {
    await performLockIfPossible(localStorage);
    window.location.reload();
  };

  const createGroup = async () => {
    const socket = socketRef.current;
    if (!socket) return;
    const memberIds = Object.keys(peersRef.current);
    if (memberIds.length < 1) return;
    const name = window.prompt("Group name?");
    if (!name?.trim()) return;
    const groupId = `g-${Math.random().toString(36).substring(2, 11)}`;
    const created = await emitWithAck<boolean>(socket, "create-group", {
      groupId,
      name: name.trim(),
      members: [myUserId(), ...memberIds],
    });
    if (created) setActiveConv({ kind: "group", groupId });
  };


const IconShield = (
  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
    <path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3z" strokeLinejoin="round" />
    <path d="M9.5 12l1.8 1.8L15 10" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const IconBell = (
  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
    <path d="M6 9a6 6 0 1112 0c0 4 1.5 5.5 1.5 5.5h-15S6 13 6 9z" strokeLinejoin="round" />
    <path d="M10 18a2 2 0 004 0" strokeLinecap="round" />
  </svg>
);
const IconLock = (
  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 118 0v3" strokeLinecap="round" />
  </svg>
);
const IconSend = (
  <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M12 19V5m0 0l-6 6m6-6l6 6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const getStatusIcon = (status?: string) => {
  switch (status) {
    case "read":
      return (
        <svg className="text-blue-400 h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M2 12l4.5 4.5L15 8" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M9 12l4.5 4.5L22 8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "delivered":
      return (
        <svg className="h-4 w-4 text-white/40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M2 12l4.5 4.5L15 8" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M9 12l4.5 4.5L22 8" strokeLinecap="round" strokeLinejoin="round" opacity="0.35" />
        </svg>
      );
    default:
      return (
        <svg className="h-4 w-4 text-white/30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M20 7L9 18l-5-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
  }
};

  /* ---------------- locked gate (signature screen) ---------------- */

  if (vaultLocked) {
    return (
      <div className="relative flex h-dvh flex-col items-center justify-center overflow-hidden bg-[#08090a] px-4">
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-[420px]"
          style={{ background: "radial-gradient(ellipse 60% 50% at 50% -10%, rgba(94,106,210,0.16), transparent)" }}
        />
        <div className="relative w-full max-w-sm rounded-[1.75rem] bg-white/[0.03] p-[7px] ring-1 ring-white/[0.06]">
          <div className="space-y-5 rounded-[calc(1.75rem-7px)] border border-white/[0.06] bg-[#0f1011] p-8 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[#5e6ad2]/15 text-[#a5acff] ring-1 ring-[#7170ff]/25">
              {IconLock}
            </div>
            <div className="space-y-1.5">
              <h1 className="text-lg font-medium tracking-tight text-[#f7f8f8]">This chat is locked</h1>
              <p className="text-sm text-[#8a8f98]">Enter your passphrase to decrypt your messages.</p>
            </div>
            <input
              type="password"
              autoFocus
              placeholder="Passphrase"
              onChange={(e) => setVaultPass1(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitUnlock();
              }}
              className="vault-unlock-input w-full rounded-xl border border-white/[0.08] bg-white/[0.03] px-3.5 py-2.5 text-base text-[#f7f8f8] placeholder:text-[#62666d] focus:outline-none focus:ring-2 focus:ring-[#7170ff]/60"
            />
            {vaultError && <p className="vault-error animate-pulse text-sm text-[#e5484d]">{vaultError}</p>}
            <button
              onClick={() => void submitUnlock()}
              className="w-full rounded-xl bg-[#5e6ad2] py-2.5 text-sm font-medium text-white transition-all duration-200 hover:bg-[#7170ff] active:scale-[0.98]"
            >
              Unlock
            </button>
          </div>
        </div>
      </div>
    );
  }

  const peerIds = Object.keys(peers);

  const labelFor = (peerId: string) => peers[peerId]?.displayName?.trim() || shortLabel(peerId);

  const chipBase =
    "conv-chip flex-shrink-0 rounded-full border px-2.5 py-1 text-[13px] font-medium transition-colors duration-200";
  const chipActive = "bg-[#5e6ad2] text-white border-[#5e6ad2]";
  const chipIdle = "bg-transparent text-[#d0d6e0] border-white/[0.08] hover:bg-white/[0.04]";
  const badgeCls = (isActive: boolean) =>
    `ml-1.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10px] font-medium ${
      isActive ? "bg-white/25 text-white" : "bg-[#5e6ad2] text-white"
    }`;

  return (
    <div className="flex h-dvh flex-col bg-[#08090a] text-[#f7f8f8]">
      {/* header */}
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-white/[0.06] bg-[#0f1011]/90 px-4 py-2.5 backdrop-blur-sm">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="truncate text-[15px] font-medium tracking-tight text-[#f7f8f8]">Private Chat</h1>
          {editingName ? (
            <input
              autoFocus
              value={displayName}
              maxLength={32}
              placeholder="Your name"
              onChange={(e) => setDisplayName(e.target.value)}
              onBlur={saveDisplayName}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveDisplayName();
                if (e.key === "Escape") setEditingName(false);
              }}
              className="name-input w-28 rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-0.5 text-sm text-[#f7f8f8] focus:outline-none focus:ring-2 focus:ring-[#7170ff]/60"
            />
          ) : (
            <button
              onClick={() => setEditingName(true)}
              className="name-btn max-w-[140px] truncate text-xs text-[#62666d] transition-colors duration-200 hover:text-[#8a8f98]"
              title="Set the name other people see"
            >
              {displayName.trim() || "set your name"}
            </button>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <span
            className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-1 text-[11px] font-medium text-[#a5acff]"
            title="Messages are end-to-end encrypted. The server only relays ciphertext."
          >
            {IconShield}
            E2EE
          </span>
          {isReady && !vaultConfigured && !showVaultForm && (
            <button
              onClick={() => {
                setShowVaultForm(true);
                setVaultError("");
              }}
              className="vault-enable-btn inline-flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-1 text-[11px] font-medium text-[#7a7fad] transition-colors duration-200 hover:bg-white/[0.07] hover:text-[#a5acff]"
              title="Encrypt your messages and identity keys at rest behind a passphrase"
            >
              {IconLock}
              Passphrase
            </button>
          )}
          {isReady && vaultConfigured && (
            <button
              onClick={() => void lockNow()}
              className="vault-lock-btn inline-flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-1 text-[11px] font-medium text-[#7a7fad] transition-colors duration-200 hover:bg-white/[0.07] hover:text-[#a5acff]"
              title="Encrypt local data and require your passphrase"
            >
              {IconLock}
              Lock
            </button>
          )}
          {!pushEnabled && isReady && (
            <button
              onClick={() => void enablePush()}
              className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-1 text-[11px] font-medium text-[#8a8f98] transition-colors duration-200 hover:bg-white/[0.07] hover:text-[#d0d6e0]"
              title="Get notified when messages arrive while the tab is closed"
            >
              {IconBell}
              Push
            </button>
          )}
          {onlineCount > 0 && <span className="text-xs text-[#8a8f98]">{onlineCount} online</span>}
          <span
            className={`h-1.5 w-1.5 rounded-full ${isConnected ? "pulse-dot bg-[#27a644]" : "bg-[#e5484d]"}`}
            title={isConnected ? "Connected" : "Disconnected"}
          />
        </div>
      </header>

      {/* conversation chips */}
      <nav className="scroll-dark sticky top-[49px] z-10 flex gap-1.5 overflow-x-auto border-b border-white/[0.05] bg-[#0f1011]/60 px-3 py-2">
        {peerIds.map((peerId) => {
          const conv: Conversation = { kind: "dm", peerId };
          const count = unread[roomFor(conv, myUserId())] ?? 0;
          const isActive = activeConv?.kind === "dm" && activeConv.peerId === peerId;
          return (
            <button
              key={peerId}
              onClick={() => setActiveConv(conv)}
              className={`${chipBase} ${isActive ? chipActive : chipIdle}`}
              title={peerId}
            >
              {labelFor(peerId)}
              {count > 0 && <span className={badgeCls(isActive)}>{count}</span>}
            </button>
          );
        })}
        {Object.values(groups).map((group) => {
          const conv: Conversation = { kind: "group", groupId: group.groupId };
          const roomId = roomFor(conv, myUserId());
          const count = unread[roomId] ?? 0;
          const isActive = activeConv?.kind === "group" && activeConv.groupId === group.groupId;
          return (
            <button
              key={group.groupId}
              onClick={() => setActiveConv(conv)}
              className={`${chipBase} ${isActive ? chipActive : chipIdle}`}
              title={`${group.name} — members: ${group.members.join(", ")}`}
            >
              #&nbsp;{group.name}
              {count > 0 && <span className={badgeCls(isActive)}>{count}</span>}
            </button>
          );
        })}
        {peerIds.length > 0 && (
          <button
            onClick={() => void createGroup()}
            aria-label="Create a group with current peers"
            className="conv-create flex-shrink-0 rounded-full border border-dashed border-white/[0.12] px-2.5 py-1 text-[13px] font-medium text-[#62666d] transition-colors duration-200 hover:border-[#7170ff]/50 hover:text-[#a5acff]"
          >
            +
          </button>
        )}
      </nav>

      {/* messages */}
      <main className="scroll-dark flex-1 space-y-2.5 overflow-y-auto px-4 pt-5 pb-2">
        {!activeConv ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-white/[0.03] text-[#62666d] ring-1 ring-white/[0.08]">
              {IconShield}
            </div>
            <p className="max-w-[240px] text-sm text-[#62666d]">
              Waiting for someone to connect. Everything you send here is end-to-end encrypted.
            </p>
          </div>
        ) : (
          <>
            {activeMessages.map((msg, idx) => {
              const prev = idx > 0 ? activeMessages[idx - 1] : undefined;
              const showSender = !msg.isOwn && (!prev || prev.senderId !== msg.senderId);
              return (
                <div key={msg.id} className={`bubble-in flex ${msg.isOwn ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[78%] sm:max-w-[65%] ${showSender ? "mt-2" : ""}`}>
                    {showSender && (
                      <div className="mb-1 ml-1 flex items-center gap-1.5">
                        <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-[#7a7fad]/25 text-[9px] font-medium uppercase text-[#a5acff] ring-1 ring-[#7a7fad]/30">
                          {(labelFor(msg.senderId)[0] ?? "?").toUpperCase()}
                        </span>
                        <span className="text-[11px] font-medium text-[#7a7fad]">{labelFor(msg.senderId)}</span>
                      </div>
                    )}
                    <div
                      className={`rounded-2xl px-3.5 py-2 text-[15px] leading-[1.45] ${
                        msg.isOwn
                          ? "rounded-br-md bg-[#5e6ad2] text-white shadow-[0_1px_2px_rgba(0,0,0,0.25)]"
                          : "rounded-bl-md border border-white/[0.06] bg-[#191a1b] text-[#f7f8f8]"
                      }`}
                    >
                      <p className={`whitespace-pre-wrap break-words ${msg.text === UNABLE_TO_DECRYPT ? "italic opacity-50" : ""}`}>
                        {msg.text}
                      </p>
                      <div className={`mt-0.5 flex items-center justify-end gap-1 ${msg.isOwn ? "-mr-1" : "-ml-1"}`}>
                        <span className={`font-mono text-[10px] ${msg.isOwn ? "text-white/60" : "text-[#62666d]"}`}>
                          {msg.timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </span>
                        {msg.isOwn && getStatusIcon(msg.status)}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}

            {otherTypingInActive && (
              <div className="flex justify-start">
                <div className="rounded-2xl rounded-bl-md border border-white/[0.06] bg-[#191a1b] px-4 py-2.5">
                  <div className="flex gap-1">
                    {[0, 1, 2].map((i) => (
                      <span
                        key={i}
                        className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#8a8f98]"
                        style={{ animationDelay: `${i * 120}ms` }}
                      />
                    ))}
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        <div ref={messagesEndRef} />
      </main>

      {/* vault enable modal */}
      {showVaultForm && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-[1.5rem] bg-white/[0.03] p-[7px] ring-1 ring-white/[0.08]">
            <div className="space-y-4 rounded-[calc(1.5rem-7px)] border border-white/[0.06] bg-[#0f1011] p-6">
              <div className="space-y-1">
                <h2 className="text-base font-medium text-[#f7f8f8]">Encrypt local data</h2>
                <p className="text-xs leading-relaxed text-[#8a8f98]">
                  Messages and identity keys will be encrypted at rest behind this passphrase.
                  If you forget it, this device&apos;s history is unrecoverable.
                </p>
              </div>
              <input
                type="password"
                placeholder="Passphrase (min 8 characters)"
                value={vaultPass1}
                onChange={(e) => setVaultPass1(e.target.value)}
                className="vault-pass w-full rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-base text-[#f7f8f8] placeholder:text-[#62666d] focus:outline-none focus:ring-2 focus:ring-[#7170ff]/60"
              />
              <input
                type="password"
                placeholder="Repeat passphrase"
                value={vaultPass2}
                onChange={(e) => setVaultPass2(e.target.value)}
                className="vault-pass2 w-full rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-base text-[#f7f8f8] placeholder:text-[#62666d] focus:outline-none focus:ring-2 focus:ring-[#7170ff]/60"
              />
              {vaultError && <p className="vault-error text-sm text-[#e5484d]">{vaultError}</p>}
              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => void enableVault()}
                  className="vault-enable-save flex-1 rounded-xl bg-[#5e6ad2] py-2 text-sm font-medium text-white transition-all duration-200 hover:bg-[#7170ff] active:scale-[0.98]"
                >
                  Enable &amp; lock
                </button>
                <button
                  onClick={() => {
                    setShowVaultForm(false);
                    setVaultError("");
                    setVaultPass1("");
                    setVaultPass2("");
                  }}
                  className="flex-1 rounded-xl bg-white/[0.04] py-2 text-sm text-[#d0d6e0] transition-colors duration-200 hover:bg-white/[0.07]"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* composer */}
      <footer className="sticky bottom-0 border-t border-white/[0.06] bg-[#0f1011]/90 p-3 pb-safe backdrop-blur-sm">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <div className="flex-1 rounded-[1.35rem] bg-white/[0.03] ring-1 ring-white/[0.08] focus-within:ring-2 focus-within:ring-[#7170ff]/50">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder={
                !isReady
                  ? "Setting up encryption..."
                  : activeConv
                    ? activeConv.kind === "group"
                      ? `Message #${groups[activeConv.groupId]?.name ?? "group"}...`
                      : `Message ${labelFor(activeConv.peerId)}...`
                    : "Waiting for a peer..."
              }
              disabled={!isReady}
              rows={1}
              style={{ fontSize: "16px" }}
              autoComplete="off"
              autoCorrect="on"
              autoCapitalize="sentences"
              spellCheck={true}
              inputMode="text"
              className="max-h-40 min-h-[44px] w-full resize-none bg-transparent px-4 py-2.5 text-base text-[#f7f8f8] placeholder:text-[#62666d] focus:outline-none disabled:opacity-60"
            />
          </div>
          <button
            onClick={() => void sendMessage()}
            disabled={!input.trim() || !isConnected || !isReady || !activeConv}
            aria-label="Send message"
            className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-[#5e6ad2] text-white transition-all duration-200 hover:bg-[#7170ff] active:scale-95 disabled:opacity-40"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M12 19V5m0 0l-6 6m6-6l6 6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </footer>
    </div>
  );
}
