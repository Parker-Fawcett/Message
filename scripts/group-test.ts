/**
 * Group chat empirical test (pairwise-encrypted fan-out).
 *
 *  1. A, B, C online; A creates a group with all three
 *  2. All three clients see the group chip
 *  3. A sends -> B and C BOTH receive (legitimate fan-out)
 *  4. B replies -> A and C receive
 *  5. C goes offline; A sends again -> queued
 *  6. C returns -> replayed group message decrypted
 *  7. Wire audit: no plaintext in relayed payloads
 */
import { chromium } from "playwright";
import { provisionServer, stopServer } from "./provision";
import { spawn, execSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";

let browserRef: import("playwright").Browser | null = null;
const WIRE_LOG = "/tmp/messaging-wire-group.log";



function pass(name: string, detail = "") {
  console.error(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(name: string, err: unknown): never {
  console.error(`FAIL ${name}:`, err);
  throw err;
}

async function waitReady(page: import("playwright").Page) {
  await page.waitForSelector("textarea:not([disabled])", { timeout: 25000 });
}
async function send(page: import("playwright").Page, text: string) {
  await page.fill("textarea", text);
  await page.keyboard.press("Enter");
}
async function expectVisible(page: import("playwright").Page, text: string, timeout = 20000) {
  await page.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout });
}

async function main() {
  const URL = await provisionServer({ MSG_WIRE_LOG: WIRE_LOG });
  const step = (label: string) => console.error(`STEP ${label}`);
  rmSyncSafe();
  const browser = await chromium.launch();
  browserRef = browser;
  try {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const ctxC = await browser.newContext();

  const mk = async (ctx: import("playwright").BrowserContext) => {
    const p = await ctx.newPage();
    p.on("console", (m) => {
      if (m.type() === "error") console.error(`[console] ${m.text().slice(0, 160)}`);
    });
    p.on("pageerror", (e) => console.error(`[pageerror] ${String(e).slice(0, 200)}`));
    await p.goto(URL, { waitUntil: "networkidle" });
    await waitReady(p);
    return p;
  };

  step("mk-a");
  const a = await mk(ctxA);
  step("mk-b");
  const b = await mk(ctxB);
  step("wait-1online");
  await expectVisible(a, "1 online");
  await expectVisible(b, "1 online");
  step("mk-c");
  const c = await mk(ctxC);
  try {
    step("wait-b-2online");
    await expectVisible(b, "2 online"); // counts OTHERS only
  } catch (e) {
    console.error("DEBUG health:", JSON.stringify(await fetch(`${URL}/health`).then((r) => r.json()).catch(() => null)));
    fail("setup: presence", e);
  }

  // ---- 1. A creates the group ---------------------------------------------
  const groupName = `proj-${Date.now()}`;
  let dialogName: string | null = null;
  a.on("dialog", async (dialog) => {
    dialogName = dialog.message();
    await dialog.accept(groupName);
  });
  try {
    step("click-create-group");
    await a.locator(".conv-create").click();
    await b.waitForFunction(() => document.body.innerText.includes("#"), undefined, { timeout: 15000 });
    pass(`1. group "${groupName}" created by A`);
  } catch (e) { fail("1. create group", e); }

  // ---- 2. everyone sees the group chip -------------------------------------
  try {
    for (const p of [a, b, c]) {
      await p.waitForFunction(() => document.querySelectorAll(".conv-chip").length >= 1 && document.body.innerText.includes("#"), undefined, { timeout: 15000 });
    }
    const chipsA = await a.locator(".conv-chip").count();
    const groupChipsA = await a.locator(".conv-chip", { hasText: "#" }).count();
    if (groupChipsA < 1) throw new Error(`no #chip on A (${chipsA} dm chips)`);
    pass("2. group chip visible on all three clients");
  } catch (e) { fail("2. group chip visibility", e); }

  // ---- 3. A opens group and sends -> B and C receive ------------------------
  const gMsg1 = `grp-hello-${Date.now()}`;
  try {
    await a.locator(".conv-chip", { hasText: "#" }).first().click();
    await send(a, gMsg1);
    // Recipients must open the group thread to see the message (unread badge
    // appears on their chip meanwhile).
    await b.locator(".conv-chip", { hasText: "#" }).first().click();
    await c.locator(".conv-chip", { hasText: "#" }).first().click();
    await expectVisible(b, gMsg1);
    await expectVisible(c, gMsg1);
    pass("3. A->group delivered to both members");
  } catch (e) {
    for (const [label, p] of [["a", a], ["b", b], ["c", c]] as const) {
      const bodyText = await p.locator("body").innerText().catch(() => "");
      console.error(`DEBUG ${label} body:`, JSON.stringify(bodyText.slice(0, 250)));
    }
    fail("3. group fan-out", e);
  }

  // ---- 4. B replies -> A and C receive --------------------------------------
  const gReply = `grp-reply-${Date.now()}`;
  try {
    await b.locator(".conv-chip", { hasText: "#" }).first().click();
    await send(b, gReply);
    await expectVisible(a, gReply);
    await expectVisible(c, gReply);
    pass("4. B->group delivered to remaining members");
  } catch (e) { fail("4. member reply", e); }

  // ---- 5. C offline; A queues a group message -------------------------------
  const gQueued = `grp-queued-${Date.now()}`;
  try {
    await c.goto("about:blank");
    await new Promise((r) => setTimeout(r, 800));
    await send(a, gQueued);
    await new Promise((r) => setTimeout(r, 500));
    pass("5. message sent to group while C offline");
  } catch (e) { fail("5. offline group send", e); }

  // ---- 6. C returns -> replayed and decrypted -------------------------------
  try {
    const c2 = await ctxC.newPage();
    await c2.goto(URL, { waitUntil: "networkidle" });
    await waitReady(c2);
    await c2.locator(".conv-chip", { hasText: "#" }).first().click();
    await expectVisible(c2, gQueued, 25000);
    pass("6. returning member received replayed group traffic");
  } catch (e) { fail("6. group replay", e); }

  // ---- 7. wire audit ---------------------------------------------------------
  try {
    const wire = readFileSync(WIRE_LOG, "utf8");
    const lines = wire.trim().split("\n").filter(Boolean);
    const secrets = [gMsg1, gReply, gQueued];
    const leaks = lines.filter((l) => secrets.some((s) => l.includes(s)));
    if (leaks.length > 0) throw new Error(`${leaks.length} relayed payloads contained plaintext`);
    const ctLines = lines.filter((l) => l.includes('"ct":"')).length;
    // 3 live relays (A->group x2, B->group x1) + 1 replay of the queued msg.
    const liveLines = lines.filter((l) => l.includes('"dir":"live"')).length;
    const replayLines = lines.filter((l) => l.includes('"dir":"replay"')).length;
    if (ctLines !== 4 || liveLines !== 3 || replayLines !== 1) {
      throw new Error(`relay counts off: ct=${ctLines} live=${liveLines} replay=${replayLines}`);
    }
    // Pairwise fan-out proof: every group payload carries one envelope PER
    // recipient (2 members + sender excluded) -> 2 envelopes x 3 messages.
    const envelopeCount = lines.filter((l) => l.includes('"dir":"live"')).reduce(
      (n, l) => n + (l.match(/"to":"/g)?.length ?? 0),
      0,
    );
    if (envelopeCount !== 6) throw new Error(`expected 6 pairwise envelopes, saw ${envelopeCount}`);
    console.error(`7. wire audit: ${lines.length} payloads (live=${liveLines}, replay=${replayLines}), ${envelopeCount} pairwise envelopes, 0 plaintext leaks`);
    pass("7. wire audit clean");
  } catch (e) { fail("7. wire audit", e); }

  await stopServer(URL);
  console.error("\nGROUP TEST COMPLETE");
  } finally {
    await browser.close();
  }

}

function rmSyncSafe() {
  try {
    rmSync(WIRE_LOG, { force: true });
  } catch {}
}

main().catch(async (err) => {
  console.error("GROUP TEST FAILED:", err);
  if (browserRef) { try { await browserRef.close(); } catch {} }
  process.exit(1);
});
