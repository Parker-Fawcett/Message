# Private Chat

An end-to-end encrypted messenger built on Next.js 16 + Socket.IO, with a
deliberately small and auditable codebase. Every claim below is backed by an
empirical test suite you can run yourself.

## Features

- **X3DH + Double Ratchet E2EE** — Signal-style sessions established from
  prekey bundles; per-message forward secrecy, DH ratchet turns, skipped-key
  cache for out-of-order delivery
- **1:1 rooms and groups** — pairwise-encrypted fan-out per group member
- **Store-and-forward** — messages to offline peers are queued server-side
  (ciphertext only) and replayed exactly once on reconnect
- **Web Push wake-ups** for offline recipients (routing metadata only)
- **Encrypted local history** — restored across reloads
- **Optional passphrase vault** — identity keys + history encrypted at rest
- Presence, typing indicators, sent/delivered/read receipts
- OTK rotation with server-side one-time handout + bundle TTL expiry

## Security model — the honest version

| What | Status |
|---|---|
| Message content vs relay | Encrypted; server stores/forwards opaque ciphertext |
| Routing metadata (who talks to whom, when) | Visible to the relay |
| Identity private keys / history at rest | Plaintext by default; passphrase vault encrypts them behind PBKDF2 (310k iterations). Same browser-profile trust domain while unlocked |
| Group messages | Pairwise-encrypted per member (no sender-key yet — fine for small groups, O(N) envelopes) |
| Telegram-style "secret chat" opt-in | Not needed — everything is E2EE by default |

Hand-rolled crypto warning: this implements the published X3DH + Double
Ratchet specs on WebCrypto rather than using libsignal (official bindings are
not browser-ready; community ports are unmaintained). The protocol layer has
a Node-runnable smoke suite covering establishment, ratchet turns,
out-of-order delivery, persistence, tamper rejection, and a 25-initiator OTK
exhaustion gauntlet. Treat it as an educational reference implementation, not
an audited product.

## Architecture

```
server.js                     Socket.IO relay: bundle registry (+ one-time OTK
                              handout), per-room store-and-forward queues with
                              ack-based drain, presence, push subscriptions.
                              Never sees plaintext.
src/lib/crypto.ts             Byte-oriented WebCrypto primitives (ECDH P-256,
                              ECDSA, HKDF/HMAC chain KDFs, AES-GCM)
src/lib/signal-session.ts     X3DH + Double Ratchet session management
src/lib/history.ts            Encrypted local history buckets
src/lib/local-vault.ts        Optional passphrase at-rest encryption
src/app/chat-client.tsx       Conversation UI, socket wiring, E2EE plumbing
public/sw.js                  Push service worker
scripts/provision.ts          Per-suite dedicated server on a free port
scripts/*-test.ts | *-smoke.ts|*-probe.ts   Empirical suites (see below)
```

## Run it

```bash
npm install
npm run build
node server.js            # serves production build; PORT env to change port
```

Open the URL in two separate browser profiles/windows and chat.

## Test suites

All suites provision their own isolated server (unique port, `/health`
verified) and tear it down after. `NODE_PATH` must point at a directory
containing the playwright package; browsers come from `npx playwright
install chromium`.

| Suite | Covers |
|---|---|
| `protocol-smoke.ts` | X3DH, ratchet turns, out-of-order, persistence, tamper rejection, OTK exhaustion |
| `empirical-test.ts` | Two-browser E2EE flow, bursts, reload+history restore, DM isolation with 3 peers, receipts, wire-tap leak audit |
| `store-forward-test.ts` | Offline queue/replay, ack-once semantics, presence, loopback push wake-ups |
| `group-test.ts` | Group lifecycle, pairwise fan-out counts, offline member replay |
| `bundle-ttl-test.ts` | Stale-bundle expiry + online exemption |
| `vault-test.ts` | Passphrase enable/lock/unlock, at-rest audit, continuity |
| `wire-probe.ts`, `history-probe.ts`, `push-server-probe.js` | Narrow diagnostics |

```bash
NODE_PATH=/path/to/node_modules npx tsx scripts/empirical-test.ts
```

Suites assert exact wire-event counts against a server-side tap
(`MSG_WIRE_LOG=/tmp/...`), so "no plaintext leak" means no plaintext in
anything the relay forwarded.

## Deployment notes

- `render.yaml` included. Set `MSG_WIRE_LOG` only for debugging;
  `PUSH_MODE=loopback` only for tests.
- VAPID keys persist in `.vapid.json` (gitignored) — on ephemeral hosting
  platforms, mount it or supply via env instead.
- In-memory state (queues, bundles, subscriptions) resets on restart by
  design; history lives on clients.
