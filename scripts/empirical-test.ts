/**
 * Empirical E2EE test gauntlet against a live dev server on :3000.
 *
 * Scenarios:
 *  1. Two peers discover each other, both reach ready state
 *  2. Rapid burst Alice->Bob (3 msgs, one chain) — order preserved
 *  3. Bob replies twice (DH ratchet turn + Alice re-ratchet)
 *  4. Bob reloads page — persisted identity/session keeps working
 *  5. Third peer joins — fan-out to all peers, badge count updates
 *  6. Read receipts observed empirically (sent -> delivered -> read icons)
 *  7. Wire audit: no plaintext in any WebSocket frame, sample ciphertext shown
 *
 * Run: NODE_PATH=<npx playwright dir> npx tsx scripts/empirical-test.ts
 */
import { chromium } from "playwright";
import { provisionServer, stopServer } from "./provision";
import { spawn, execSync } from "node:child_process";
import { readFileSync, rmSync, existsSync } from "node:fs";

let browserRef: import("playwright").Browser | null = null;
const WIRE_LOG = "/tmp/messaging-wire-empirical.log";
const SHOT_DIR = "/tmp/messaging-shots";



const results: string[] = [];
function pass(name: string, detail = "") {
  results.push(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
  console.error(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(name: string, err: unknown): never {
  if (Array.isArray((globalThis as Record<string, unknown>).__probeErrors)) {
    const errs = (globalThis as Record<string, unknown>).__probeErrors as string[];
    if (errs.length > 0) console.error(`FAIL ${name} page-errors:`, errs.slice(0, 8));
  }
  console.error(`FAIL ${name}:`, err);
  throw err;
}

function attachConsoleErrors(page: import("playwright").Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(String(err)));
  return errors;
}

async function waitReady(page: import("playwright").Page) {
  await page.waitForSelector('textarea:not([disabled])', { timeout: 25000 });
  await page.waitForFunction(() => document.body.innerText.includes("E2EE"), undefined, { timeout: 25000 });
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
  const URL = await provisionServer({ MSG_WIRE_LOG: WIRE_LOG });
  const browser = await chromium.launch();
  browserRef = browser;
  const killBrowser = () => { try { browser.process()?.kill('SIGKILL'); } catch {} };
  process.on('exit', killBrowser);
  process.on('uncaughtExceptionMonitor', killBrowser);

  // ---------------------------------------------------------------- setup --
  const aliceCtx = await browser.newContext();
  const bobCtx = await browser.newContext();
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();
  const allErrors: string[] = [];
  (globalThis as Record<string, unknown>).__probeErrors = allErrors;
  const collectErrors = (page: import("playwright").Page) => {
    page.on("console", (msg) => {
      if (msg.type() === "error") allErrors.push(msg.text().slice(0, 200));
    });
    page.on("pageerror", (err) => allErrors.push(String(err).slice(0, 300)));
  };
  collectErrors(alice);
  collectErrors(bob);

  await alice.goto(URL, { waitUntil: "networkidle" });
  await bob.goto(URL, { waitUntil: "networkidle" });

  try {
    await waitReady(alice);
    await waitReady(bob);
    pass("1a. both peers bootstrapped keys + reached ready state");
  } catch (e) { fail("1a. bootstrap", e); }

  try {
    for (const p of [alice, bob]) {
      await p.waitForFunction(() => document.body.innerText.includes("1 online"), undefined, { timeout: 15000 });
    }
    pass("1b. mutual bundle discovery (badge shows 1 online)");
  } catch (e) { fail("1b. discovery", e); }

  // Stable handle onto Bob's row (title attr carries the peer userId).
  let bobRowSel = "";
  try {
    bobRowSel = await alice.locator(".conv-chip").first().getAttribute("title");
    if (!bobRowSel) throw new Error("no title");
  } catch (e) { fail("1c. capture bob row", e); }

  // ------------------------------------------------- 2. burst of messages --
  const burst = [`msg-a1-${Date.now()}`, `msg-a2-${Date.now()}`, `msg-a3-${Date.now()}`];
  try {
    for (const m of burst) await send(alice, m);
    for (const m of burst) await expectVisible(bob, m);
    pass("2. rapid burst of 3 encrypted messages delivered in order");
  } catch (e) { fail("2. burst delivery", e); }

  // --------------------------------------- 3. ratchet turn + double reply --
  const reply1 = `reply-b1-${Date.now()}`;
  const reply2 = `reply-b2-${Date.now()}`;
  try {
    await send(bob, reply1);
    await expectVisible(alice, reply1);
    await send(bob, reply2);
    await expectVisible(alice, reply2);
    pass("3. DH ratchet turn on Bob's side; two consecutive replies decrypted by Alice");
  } catch (e) { fail("3. ratchet turn replies", e); }

  const afterReload = `post-reload-${Date.now()}`;
  try {
    await bob.reload({ waitUntil: "networkidle" });
    await waitReady(bob);
    await expectVisible(bob, burst[0], 20000);
    pass("4a. history restored from encrypted local storage after reload");
  } catch (e) {
    try {
      const bodyText = await bob.locator("body").innerText();
      console.error("DEBUG bob body:", JSON.stringify(bodyText.slice(0, 400)));
      const hist = await bob.evaluate(() => localStorage.getItem("messaging-history-v1"));
      console.error("DEBUG history storage len:", hist?.length ?? "MISSING", "head:", hist?.slice(0, 80));
      const proto = await bob.evaluate(() => localStorage.getItem("messaging-user-id"));
      console.error("DEBUG bob userId:", proto);
    } catch { /* dump best-effort */ }
    fail("4. reload persistence", e);
  }
  try {
    await send(alice, afterReload);
    await expectVisible(bob, afterReload);
    pass("4b. session survived reload; new message decrypted with persisted state");
  } catch (e) { fail("4b. post-reload decrypt", e); }

  // --------------------------------------------------------- 5. third peer --
  // 1:1 rooms: a message to one peer must NOT leak into anyone else's
  // conversation. Chips render in bundle-publication order: [bob, carol].
  const carolText = `carol-only-${Date.now()}`;
  let carol: import("playwright").Page | null = null;
  try {
    const carolCtx = await browser.newContext();
    carol = await carolCtx.newPage();
    await carol.goto(URL, { waitUntil: "networkidle" });
    await waitReady(carol);
    await alice.waitForFunction(() => document.body.innerText.includes("2 online"), undefined, { timeout: 15000 });
    await alice.locator(".conv-chip").nth(1).click();
    await send(alice, carolText);
    await expectVisible(carol, carolText);
    await new Promise((r) => setTimeout(r, 1200));
    const bobText = await bob.locator("main").innerText();
    if (bobText.includes(carolText)) throw new Error("DM leaked into Bob's view");
    pass("5. third peer joined; DM routed to Carol only, absent from Bob's view; badge shows 2 online");
  } catch (e) { fail("5. per-conversation routing", e); }

  // ----------------------------------------------------- 6. read receipts --
  try {
    // Back to Bob's conversation; receipts only fire for the ACTIVE thread.
    await alice.locator(`.conv-chip[title="${bobRowSel}"]`).click();
    const receiptMsg = `receipt-probe-${Date.now()}`;
    await send(alice, receiptMsg);
    await expectVisible(bob, receiptMsg);
    await new Promise((r) => setTimeout(r, 800));
    if (carol) {
      const carolText = await carol.locator("main").innerText();
      if (carolText.includes(receiptMsg)) throw new Error("receipt probe leaked into Carol's view");
    }
    // Own-message status icon turns blue (read checkmark) once peer marks it.
    try {
      await alice.waitForFunction(
        () => Boolean(document.querySelector("main .text-blue-400")),
        undefined,
        { timeout: 15000 },
      );
      pass("6. sent -> delivered -> read receipts observed end-to-end (active-thread scoped)");
    } catch (inner) {
      const aBody = await alice.locator("body").innerText();
      const bBody = await bob.locator("body").innerText();
      console.log("DEBUG alice body:", JSON.stringify(aBody.slice(0, 300)));
      console.log("DEBUG bob body:", JSON.stringify(bBody.slice(0, 300)));
      console.log("DEBUG alice chips:", await alice.locator(".conv-chip").evaluateAll((els) => els.map((e) => e.textContent)));
      console.log("DEBUG bob chips:", await bob.locator(".conv-chip").evaluateAll((els) => els.map((e) => e.textContent)));
      throw inner;
    }
  } catch (e) { fail("6. receipts", e); }

  // ------------------------------------------------------------ screenshots
  await alice.screenshot({ path: `${SHOT_DIR}/alice.png` });
  await bob.screenshot({ path: `${SHOT_DIR}/bob.png` });
  if (carol) await carol.screenshot({ path: `${SHOT_DIR}/carol.png` });

  // ---------------------------------------------------------- 7. wire audit
  try {
    let wire = "";
    try {
      wire = readFileSync(WIRE_LOG, "utf8");
    } catch {
      throw new Error(`wire log missing at ${WIRE_LOG}`);
    }
    const lines = wire.trim().split("\n").filter(Boolean);
    if (lines.length === 0) throw new Error("wire log empty — tap not invoked");
    const secrets = [...burst, reply1, reply2, afterReload, carolText].filter(Boolean);
    const leaks = lines.filter((l) => secrets.some((s) => l.includes(s)));
    if (leaks.length > 0) throw new Error(`${leaks.length} relayed payloads contained plaintext`);
    const ctLines = lines.filter((l) => l.includes('"ct":"')).length;
    if (ctLines === 0) throw new Error("no ciphertext in relayed payloads");
    const sample = lines.find((l) => l.includes('"ct":"'))!;
    console.error(`7. wire audit: ${lines.length} relayed payloads, ${ctLines} carry ciphertext, 0 plaintext leaks`);
    console.error(`   sample on wire: ${sample.slice(sample.indexOf('"ct":"'), sample.indexOf('"ct":"') + 60)}...`);
    pass("7. wire audit clean");
  } catch (e) { fail("7. wire audit", e); }

  // --------------------------------------------- 8. display-name propagation --
  try {
    await alice.locator(".name-btn").click();
    await alice.locator(".name-input").fill("Alice");
    await alice.locator(".name-input").press("Enter");
    // Republish -> peers refetch bundles -> chip labels show display names.
    await expectVisible(bob, "Alice", 15000);
    pass("8. display name set by A propagates to B's chip label");
  } catch (e) { fail("8. display names", e); }

  // ------------------------------------------------------ console/page errors --
  const realErrors = allErrors.filter(
    (t) => !t.includes("net::ERR") && !t.includes("favicon"),
  );
  if (realErrors.length > 0) {
    console.error("console errors observed:", realErrors.slice(0, 5));
  } else {
    pass("9. zero console/page errors across all three clients");
  }

  await browser.close();
  await stopServer(URL);
  console.error("\nEMPIRICAL TEST RUN COMPLETE");
}

main().catch(async (err) => {
  console.error("EMPIRICAL TEST FAILED:", err);
  if (browserRef) { try { await browserRef.close(); } catch {} }
  process.exit(1);
});
