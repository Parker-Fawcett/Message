import { Bytes, aesDecrypt, aesEncrypt, fromUtf8, utf8 } from "./crypto";

/**
 * Encrypted per-room chat history in localStorage.
 *
 * Plaintext never touches storage: each flush serializes the room's messages
 * to JSON and writes {iv, ct}. The key comes from exportLocalHistoryKey() —
 * see its docstring for the (deliberately stated) trust boundary.
 */

const HISTORY_KEY = "messaging-history-v1";
export const HISTORY_MAX_PER_ROOM = 200;

export interface StoredMessage {
  id: string;
  text: string;
  senderId: string;
  /** ISO timestamp */
  timestamp: string;
  isOwn: boolean;
  status?: "sent" | "delivered" | "read";
}

interface EncryptedBucket {
  iv: string;
  ct: string;
}

type HistoryFile = Record<string, EncryptedBucket>;

function readRaw(storage: Storage): HistoryFile {
  try {
    return JSON.parse(storage.getItem(HISTORY_KEY) ?? "{}") as HistoryFile;
  } catch {
    return {};
  }
}

function writeRaw(storage: Storage, file: HistoryFile): void {
  storage.setItem(HISTORY_KEY, JSON.stringify(file));
}

export function capMessages<T>(msgs: T[], max = HISTORY_MAX_PER_ROOM): T[] {
  return msgs.length > max ? msgs.slice(msgs.length - max) : msgs;
}

export async function saveRoomHistory(
  storage: Storage,
  key: Bytes,
  roomId: string,
  messages: StoredMessage[],
): Promise<void> {
  const file = readRaw(storage);
  if (messages.length === 0) {
    delete file[roomId];
  } else {
    const plaintext = utf8(JSON.stringify(capMessages(messages)));
    const { iv, ct } = await aesEncrypt(key, plaintext, utf8(roomId));
    file[roomId] = { iv, ct };
  }
  writeRaw(storage, file);
}

export async function loadAllHistory(
  storage: Storage,
  key: Bytes,
): Promise<Record<string, StoredMessage[]>> {
  const file = readRaw(storage);
  const out: Record<string, StoredMessage[]> = {};
  for (const [roomId, bucket] of Object.entries(file)) {
    try {
      const pt = await aesDecrypt(key, bucket.iv, bucket.ct, utf8(roomId));
      out[roomId] = JSON.parse(fromUtf8(pt)) as StoredMessage[];
    } catch {
      // Undecryptable buckets (e.g. different identity) are dropped.
      delete file[roomId];
    }
  }
  writeRaw(storage, file);
  return out;
}

export function toStoredMessages(msgs: { id: string; text: string; senderId: string; timestamp: Date; isOwn: boolean; status?: "sent" | "delivered" | "read" }[]): StoredMessage[] {
  return msgs.map((m) => ({
    id: m.id,
    text: m.text,
    senderId: m.senderId,
    timestamp: m.timestamp.toISOString(),
    isOwn: m.isOwn,
    status: m.status,
  }));
}
