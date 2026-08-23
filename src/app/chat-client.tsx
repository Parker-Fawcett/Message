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

  const getStatusIcon = (status?: string) => {
    switch (status) {
      case "read":
        return (
          <svg className="w-4 h-4 text-blue-400" fill="currentColor" viewBox="0 0 24 24">
            <path d="M18 7l-1.41-1.41-6.34 6.34 1.41 1.41L18 7zm4.24-1.41L11.66 16.17 7.48 12l-1.41 1.41L11.66 19l12-12-1.42-1.41zM.41 13.41L6 19l1.41-1.41L1.83 12 .41 13.41z" />
          </svg>
        );
      case "delivered":
        return (
          <svg className="w-4 h-4 text-gray-400" fill="currentColor" viewBox="0 0 24 24">
            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" />
          </svg>
        );
      default:
        return (
          <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
          </svg>
        );
    }
  };

  if (vaultLocked) {
    return (
      <div className="flex flex-col items-center justify-center h-screen h-dvh bg-gray-50 px-4">
        <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-8 max-w-sm w-full space-y-4 text-center">
          <div className="text-4xl">🔒</div>
          <h1 className="text-lg font-semibold text-gray-900">This chat is locked</h1>
          <p className="text-sm text-gray-500">Enter your passphrase to decrypt your messages.</p>
          <input
            type="password"
            autoFocus
            placeholder="Passphrase"
            onChange={(e) => setVaultPass1(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitUnlock();
            }}
            className="vault-unlock-input w-full px-3 py-2 text-base border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {vaultError && <p className="vault-error text-sm text-red-600">{vaultError}</p>}
          <button
            onClick={() => void submitUnlock()}
            className="w-full bg-blue-600 text-white py-2.5 rounded-xl hover:bg-blue-700"
          >
            Unlock
          </button>
        </div>
      </div>
    );
  }

  const peerIds = Object.keys(peers);

  return (
    <div className="flex flex-col h-screen h-dvh bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between shadow-sm sticky top-0 z-10">
        <div className="flex items-center gap-2 min-w-0">
          <h1 className="text-lg font-semibold text-gray-900 truncate">Private Chat</h1>
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
              className="name-input w-28 px-2 py-1 text-sm border border-blue-400 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          ) : (
            <button
              onClick={() => setEditingName(true)}
              className="name-btn text-sm text-gray-500 hover:text-blue-600 truncate max-w-[140px]"
              title="Set the name other people see"
            >
              {displayName.trim() || "Set your name"}
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-green-700 bg-green-100 px-2 py-1 rounded-full">🔒 E2EE</span>
          {isReady && !vaultConfigured && !showVaultForm && (
            <button
              onClick={() => {
                setShowVaultForm(true);
                setVaultError("");
              }}
              className="vault-enable-btn text-xs font-medium text-blue-700 bg-blue-100 hover:bg-blue-200 px-2 py-1 rounded-full"
              title="Encrypt your messages and identity keys at rest behind a passphrase"
            >
              🔒 Set passphrase
            </button>
          )}
          {isReady && vaultConfigured && (
            <button
              onClick={() => void lockNow()}
              className="vault-lock-btn text-xs font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 px-2 py-1 rounded-full"
              title="Encrypt local data and require your passphrase"
            >
              🔒 Lock now
            </button>
          )}
          {!pushEnabled && isReady && (
            <button
              onClick={() => void enablePush()}
              className="text-xs font-medium text-blue-700 bg-blue-100 hover:bg-blue-200 px-2 py-1 rounded-full"
              title="Get notified when messages arrive while the tab is closed"
            >
              🔔 Enable notifications
            </button>
          )}
          {onlineCount > 0 && <span className="text-xs text-gray-500">{onlineCount} online</span>}
          <span className={`w-2 h-2 rounded-full ${isConnected ? "bg-green-500" : "bg-red-500"}`} />
          <span className="text-xs text-gray-500 capitalize hidden sm:inline">{isConnected ? "connected" : "disconnected"}</span>
        </div>
      </header>

      {showVaultForm && (
        <div className="fixed inset-0 z-20 bg-black/30 flex items-center justify-center px-4">
          <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-6 max-w-sm w-full space-y-3">
            <h2 className="text-base font-semibold text-gray-900">Encrypt local data</h2>
            <p className="text-xs text-gray-500">
              Messages and identity keys will be encrypted at rest behind this passphrase.
              If you forget it, this device&apos;s history is unrecoverable.
            </p>
            <input
              type="password"
              placeholder="Passphrase (min 8 chars)"
              value={vaultPass1}
              onChange={(e) => setVaultPass1(e.target.value)}
              className="vault-pass w-full px-3 py-2 text-base border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <input
              type="password"
              placeholder="Repeat passphrase"
              value={vaultPass2}
              onChange={(e) => setVaultPass2(e.target.value)}
              className="vault-pass2 w-full px-3 py-2 text-base border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            {vaultError && <p className="vault-error text-sm text-red-600">{vaultError}</p>}
            <div className="flex gap-2 pt-1">
              <button
                onClick={() => void enableVault()}
                className="vault-enable-save flex-1 bg-blue-600 text-white py-2 rounded-xl hover:bg-blue-700"
              >
                Enable & lock
              </button>
              <button
                onClick={() => {
                  setShowVaultForm(false);
                  setVaultError("");
                  setVaultPass1("");
                  setVaultPass2("");
                }}
                className="flex-1 bg-gray-100 text-gray-700 py-2 rounded-xl hover:bg-gray-200"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <nav className="bg-white border-b border-gray-200 px-3 py-2 flex gap-2 overflow-x-auto sticky top-[57px] z-10">
        {peerIds.map((peerId) => {
          const conv: Conversation = { kind: "dm", peerId };
          const count = unread[roomFor(conv, myUserId())] ?? 0;
          const isActive = activeConv?.kind === "dm" && activeConv.peerId === peerId;
          const label = peers[peerId]?.displayName?.trim() || shortLabel(peerId);
          return (
            <button
              key={peerId}
              onClick={() => setActiveConv(conv)}
              className={`conv-chip flex-shrink-0 px-3 py-1.5 rounded-full text-sm border transition-colors ${
                isActive
                  ? "bg-blue-600 text-white border-blue-600"
                  : "bg-white text-gray-700 border-gray-300 hover:border-blue-400"
              }`}
              title={peerId}
            >
              {label}
              {count > 0 && (
                <span
                  className={`ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[11px] ${
                    isActive ? "bg-white text-blue-600" : "bg-blue-600 text-white"
                  }`}
                >
                  {count}
                </span>
              )}
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
              className={`conv-chip flex-shrink-0 px-3 py-1.5 rounded-full text-sm border transition-colors ${
                isActive
                  ? "bg-indigo-600 text-white border-indigo-600"
                  : "bg-white text-gray-700 border-gray-300 hover:border-indigo-400"
              }`}
              title={`${group.name} — members: ${group.members.join(", ")}`}
            >
              # {group.name}
              {count > 0 && (
                <span
                  className={`ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[11px] ${
                    isActive ? "bg-white text-indigo-600" : "bg-indigo-600 text-white"
                  }`}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
        {peerIds.length > 0 && (
          <button
            onClick={() => void createGroup()}
            className="conv-create flex-shrink-0 px-3 py-1.5 rounded-full text-sm border border-dashed border-gray-300 text-gray-500 hover:border-indigo-400 hover:text-indigo-500"
            aria-label="Create a group with current peers"
          >
            + Group
          </button>
        )}
      </nav>

      <main className="flex-1 overflow-y-auto p-4 space-y-4 pb-2">
        {!activeConv ? (
          <p className="text-center text-gray-400 mt-10 text-sm">Waiting for someone to connect…</p>
        ) : (
          <>
            {activeMessages.map((msg) => (
              <div key={msg.id} className={`flex ${msg.isOwn ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[85%] px-4 py-2.5 rounded-2xl ${
                    msg.isOwn
                      ? "bg-blue-600 text-white rounded-br-none"
                      : "bg-white text-gray-900 rounded-bl-none shadow-sm"
                  }`}
                >
                  <p
                    className={`text-sm leading-relaxed whitespace-pre-wrap break-words ${
                      msg.text === UNABLE_TO_DECRYPT ? "italic opacity-60" : ""
                    }`}
                  >
                    {msg.text}
                  </p>
                  <div className="flex items-center justify-end gap-1 mt-1">
                    <p className={`text-xs ${msg.isOwn ? "text-blue-100" : "text-gray-400"}`}>
                      {msg.timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </p>
                    {msg.isOwn && getStatusIcon(msg.status)}
                  </div>
                </div>
              </div>
            ))}

            {otherTypingInActive && (
              <div className="flex justify-start">
                <div className="bg-white px-4 py-2 rounded-2xl rounded-bl-none shadow-sm">
                  <div className="flex gap-1 text-gray-500">
                    <span className="animate-bounce">●</span>
                    <span className="animate-bounce" style={{ animationDelay: "0.1s" }}>●</span>
                    <span className="animate-bounce" style={{ animationDelay: "0.2s" }}>●</span>
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        <div ref={messagesEndRef} />
      </main>

      <footer className="bg-white border-t border-gray-200 p-4 pb-safe pb-4 sticky bottom-0">
        <div className="flex items-end gap-2 max-w-3xl mx-auto">
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
                    : `Message ${shortLabel(activeConv.peerId)}...`
                  : "Waiting for a peer..."
            }
            disabled={!isReady}
            className="flex-1 bg-gray-100 border border-gray-300 rounded-2xl px-4 py-3 text-base text-gray-900 placeholder-gray-400 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent max-h-40 min-h-[48px] disabled:opacity-60"
            rows={1}
            style={{ fontSize: "16px" }}
            autoComplete="off"
            autoCorrect="on"
            autoCapitalize="sentences"
            spellCheck={true}
            inputMode="text"
          />
          <button
            onClick={() => void sendMessage()}
            disabled={!input.trim() || !isConnected || !isReady || !activeConv}
            className="bg-blue-600 text-white p-3 rounded-xl hover:bg-blue-700 active:bg-blue-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors min-w-[48px] min-h-[48px] flex-shrink-0"
            aria-label="Send message"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
            </svg>
          </button>
        </div>
      </footer>
    </div>
  );
}
