/**
 * Store-and-forward empirical test against live dev server on :3000.
 *
 * Scenarios:
 *  1. A+B online, baseline exchange works
 *  2. B goes offline -> presence badge drops on A
 *  3. A sends 3 msgs while B offline -> queued server-side
 *  4. B returns with SAME identity (context storage persists) -> all 3 decrypted
 *  5. B leaves + returns again -> zero redelivered/undecryptable duplicates
 *  6. Live traffic still flows normally after reunion
 *  7. Wire audit: ciphertext present, plaintext absent
 *
 * Run: NODE_PATH=<npx playwright dir> npx tsx scripts/store-forward-test.ts
 */
import { chromium } from "playwright";
import { provisionServer, stopServer } from "./provision";
import { spawn, execSync } from "node:child_process";
import { readFileSync, rmSync, existsSync } from "node:fs";

let browserRef: import("playwright").Browser | null = null;
const WIRE_LOG = "/tmp/messaging-wire-sf.log";



function pass(name: string, detail = "") {
  console.error(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(name: string, err: unknown): never {
  console.error(`FAIL ${name}:`, err);
  throw err;
}

function attachCapture(page: import("playwright").Page): { chunks: string[] } {
  const log: { chunks: string[] } = { chunks: [] };
  // Socket.IO rides polling then upgrades to its own websocket at
  // /socket.io/?... — Next HMR also opens one, so filter by URL.
  page.on("request", (req) => {
    if (req.url().includes("socket.io") && req.method() === "POST") {
      const body = req.postData();
      if (body) log.chunks.push(body);
    }
  });
  page.on("response", (resp) => {
    if (resp.url().includes("socket.io")) {
      resp.text().then((t) => log.chunks.push(t)).catch(() => {});
    }
  });
  page.on("websocket", (ws) => {
    console.error(`[capture] ws open: ${ws.url().slice(0, 100)}`);
    if (!ws.url().includes("socket.io")) {
      console.error("[capture] -> ignoring (HMR)");
      return;
    }
    let n = 0;
    const peek = (kind: string, f: { payload: unknown }) => {
      n++;
      const s = String(f.payload);
      if (n <= 6) console.error(`[capture] ${kind}#${n}: ${s.slice(0, 70)}`);
      log.chunks.push(s);
    };
    ws.on("sent", (f) => peek("sent", f));
    ws.on("framereceived", (f) => peek("recv", f));
    ws.on("close", () => console.error(`[capture] socket.io ws closed after ${n} frames`));
  });
  return log;
}

async function waitReady(page: import("playwright").Page, timeout = 25000) {
  await page.waitForSelector("textarea:not([disabled])", { timeout });
}

async function send(page: import("playwright").Page, text: string) {
  await page.fill("textarea", text);
  await page.keyboard.press("Enter");
}

async function expectVisible(page: import("playwright").Page, text: string, timeout = 20000) {
  await page.waitForFunction(
    (expected) => document.body.innerText.includes(expected),
    text,
    { timeout },
  );
}

async function main() {
  const URL = await provisionServer({ MSG_WIRE_LOG: WIRE_LOG, PUSH_MODE: "loopback" });
  const browser = await chromium.launch();
  browserRef = browser;
  const killBrowser = () => { try { browser.process()?.kill('SIGKILL'); } catch {} };
  process.on('exit', killBrowser);
  process.on('uncaughtExceptionMonitor', killBrowser);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();

  // Register loopback push subscriptions so offline delivery can be asserted.
  await ctxA.addInitScript(() => localStorage.setItem("messaging-push-loopback", "1"));
  await ctxB.addInitScript(() => localStorage.setItem("messaging-push-loopback", "1"));
  const a = await ctxA.newPage();
  const aWire = attachCapture(a);
  const errors: string[] = [];
  a.on("pageerror", (e) => errors.push(String(e)));
  await a.goto(URL, { waitUntil: "networkidle" });
  await waitReady(a);

  let b = await ctxB.newPage();
  const bWire = attachCapture(b);
  b.on("pageerror", (e) => errors.push(String(e)));
  await b.goto(URL, { waitUntil: "networkidle" });
  await waitReady(b);
  await b.getByRole("button", { name: /^Push$/ }).click();
  await new Promise((r) => setTimeout(r, 500));

  try {
    await expectVisible(a, "1 online");
    await expectVisible(b, "1 online");
    pass("1. both peers online, mutual discovery");
  } catch (e) { fail("1. discovery", e); }

  const warmup = `warmup-${Date.now()}`;
  try {
    await send(a, warmup);
    await expectVisible(b, warmup);
    pass("1b. baseline encrypted exchange");
  } catch (e) {
    console.error("DEBUG a:", JSON.stringify((await a.locator("body").innerText()).slice(0, 250)));
    console.error("DEBUG b:", JSON.stringify((await b.locator("body").innerText()).slice(0, 250)));
    fail("1b. baseline", e);
  }

  // ---- B goes offline ------------------------------------------------------
  try {
    await b.goto("about:blank");
    await a.waitForFunction(
      () => !document.body.innerText.includes("online"),
      undefined,
      { timeout: 15000 },
    );
    pass("2. B offline; presence badge dropped on A");
  } catch (e) { fail("2. presence drop", e); }

  // ---- A queues messages into the void -------------------------------------
  const queued = [`q1-${Date.now()}`, `q2-${Date.now()}`, `q3-${Date.now()}`];
  try {
    for (const m of queued) await send(a, m);
    await new Promise((r) => setTimeout(r, 800));
    pass("3. 3 messages sent while recipient offline");
  } catch (e) { fail("3. offline send", e); }

  // ---- B returns with SAME identity ----------------------------------------
  try {
    b = await ctxB.newPage();
    b.on("pageerror", (e) => errors.push(String(e)));
    attachCapture(b);
    await b.goto(URL, { waitUntil: "networkidle" });
    await waitReady(b);
    for (const m of queued) await expectVisible(b, m, 25000);
    pass("4. B returned; all 3 queued messages replayed AND decrypted");
  } catch (e) { fail("4. replay decrypt", e); }

  // ---- B cycles again: server must NOT re-replay acked messages -------------
  // (Bob's own screen now shows q1..q3 from encrypted local history — that is
  // expected. The no-redelivery guarantee is checked against the relay's
  // replay ledger instead of the DOM.)
  try {
    await b.goto("about:blank");
    await new Promise((r) => setTimeout(r, 1000));
    b = await ctxB.newPage();
    b.on("pageerror", (e) => errors.push(String(e)));
    await b.goto(URL, { waitUntil: "networkidle" });
    await waitReady(b);
    await new Promise((r) => setTimeout(r, 1500));
    const bodyText = await b.locator("main").innerText();
    if (bodyText.includes("[Unable to decrypt]")) throw new Error("undecryptable bubble rendered");

    let wire = "";
    try { wire = readFileSync(WIRE_LOG, "utf8"); } catch { throw new Error("wire log missing"); }
    // Tap payloads are ciphertext — correlate by EVENT COUNT, not content:
    // exactly one replay per queued message, zero on the second return.
    const replayLines = wire.split("\n").filter((l) => l.includes('"dir":"replay"'));
    if (replayLines.length !== queued.length) {
      throw new Error(`expected ${queued.length} replay events total, saw ${replayLines.length}`);
    }
    pass("5. acked messages NOT replayed on subsequent reconnects (relay ledger); history renders from local storage");
  } catch (e) { fail("5. no-redelivery", e); }

  // ---- live traffic post-reunion --------------------------------------------
  try {
    await expectVisible(a, "1 online", 15000);
    const live = `live-${Date.now()}`;
    await send(a, live);
    await expectVisible(b, live);
    pass("6. live delivery + presence restored after reunion");
  } catch (e) { fail("6. post-reunion live", e); }

  // ---- wire audit (server-side tap: exactly what the relay forwarded) ------
  try {
    let wire = "";
    try {
      wire = readFileSync(WIRE_LOG, "utf8");
    } catch {
      throw new Error(`wire log missing at ${WIRE_LOG} — was server started with MSG_WIRE_LOG?`);
    }
    const lines = wire.trim().split("\n").filter(Boolean);
    if (lines.length === 0) throw new Error("wire log empty — tap not invoked");
    const secrets = [warmup, ...queued];
    const leaks = lines.filter((l) => secrets.some((s) => l.includes(s)));
    if (leaks.length > 0) throw new Error(`${leaks.length} relayed payloads contained plaintext`);
    const ctLines = lines.filter((l) => l.includes('"ct":"')).length;
    if (ctLines === 0) throw new Error("no ciphertext in relayed payloads");
    const pushLines = lines.filter((l) => l.includes('"dir":"push"'));
    if (pushLines.length !== queued.length) {
      throw new Error(`expected ${queued.length} push wake-ups for offline recipient, saw ${pushLines.length}`);
    }
    for (const line of pushLines) {
      if (!line.includes("loopback://")) throw new Error("push did not use loopback endpoint");
    }
    const sample = lines.find((l) => l.includes('"ct":"'))!;
    console.error(`7. wire audit: ${lines.length} relayed payloads, ${ctLines} carry ciphertext, 0 plaintext leaks`);
    console.error(`   sample on wire: ${sample.slice(sample.indexOf('"ct":"'), sample.indexOf('"ct":"') + 60)}...`);
    pass("7. wire audit clean");
  } catch (e) { fail("7. wire audit", e); }

  if (errors.length > 0) {
    console.error("console/page errors:", errors.slice(0, 5));
  } else {
    pass("8. zero page errors on both clients");
  }

  await browser.close();
  await stopServer(URL);
  console.error("\nSTORE-AND-FORWARD TEST COMPLETE");
}

main().catch(async (err) => {
  console.error("STORE-FORWARD TEST FAILED:", err);
  if (browserRef) { try { await browserRef.close(); } catch {} }
  process.exit(1);
});
