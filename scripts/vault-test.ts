/**
 * Passphrase vault empirical test.
 *
 *  1. A+B baseline exchange (B accumulates history)
 *  2. B enables passphrase -> page reloads into locked gate
 *  3. Storage audit: vault blob present, plaintext secrets GONE
 *  4. Wrong passphrase rejected with visible error
 *  5. Correct passphrase unlocks -> history restored
 *  6. Session continuity: new live message still decrypts
 *
 * Run: NODE_PATH=<playwright dir> npx tsx scripts/vault-test.ts
 */
import { chromium } from "playwright";
import { execSync } from "node:child_process";
import { provisionServer, stopServer } from "./provision";
import { spawn } from "node:child_process";

const PASSPHRASE = "correct-horse-battery";
let lastUrl = "";



function pass(name: string, detail = "") {
  console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
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
  const URL = await provisionServer({});
  lastUrl = URL;
  const browser = await chromium.launch();
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();

  const a = await ctxA.newPage();
  const errors: string[] = [];
  a.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));

  await a.goto(URL, { waitUntil: "networkidle" });
  await waitReady(a);

  let b = await ctxB.newPage();
  b.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await b.goto(URL, { waitUntil: "networkidle" });
  await waitReady(b);

  try {
    await expectVisible(a, "1 online");
    await expectVisible(b, "1 online");
    pass("1. both peers online");
  } catch (e) { fail("1. discovery", e); }

  const warmup = `vault-warmup-${Date.now()}`;
  try {
    await send(a, warmup);
    await expectVisible(b, warmup);
    pass("2. baseline exchange (B has history worth protecting)");
  } catch (e) { fail("2. baseline", e); }

  // ---- enable passphrase on B ------------------------------------------------
  try {
    await b.locator(".vault-enable-btn").click();
    await b.locator(".vault-pass").fill(PASSPHRASE);
    await b.locator(".vault-pass2").fill(PASSPHRASE);
    await b.locator(".vault-enable-save").click();
    await b.waitForSelector(".vault-unlock-input", { timeout: 20000 });
    pass("3. enable flow reloaded into locked gate");
  } catch (e) { fail("3. enable flow", e); }

  // ---- storage audit ----------------------------------------------------------
  try {
    const state = await b.evaluate(() => ({
      meta: localStorage.getItem("messaging-vault-meta"),
      blob: localStorage.getItem("messaging-vault-v1"),
      plainProto: localStorage.getItem("messaging-protocol-state-v1"),
      plainHist: localStorage.getItem("messaging-history-v1"),
    }));
    if (!state.meta || !JSON.parse(state.meta!).locked) throw new Error("meta missing or not locked");
    if (!state.blob) throw new Error("vault blob missing");
    if (state.plainProto !== null) throw new Error("protocol state still plaintext");
    if (state.plainHist !== null) throw new Error("history still plaintext");
    if ((state.blob ?? "").includes(warmup)) throw new Error("warmup plaintext inside vault blob");
    pass("4. at-rest audit: secrets encrypted, plaintext removed");
  } catch (e) { fail("4. storage audit", e); }

  // ---- wrong passphrase rejected ----------------------------------------------
  try {
    await b.fill(".vault-unlock-input", "wrong-passphrase");
    await b.locator(".vault-unlock-input").press("Enter");
    await b.waitForFunction(() => document.body.innerText.includes("Wrong passphrase"), undefined, {
      timeout: 15000,
    });
    pass("5. wrong passphrase rejected with visible error");
  } catch (e) { fail("5. wrong passphrase", e); }

  // ---- correct passphrase unlocks + restores history ---------------------------
  try {
    await b.fill(".vault-unlock-input", PASSPHRASE);
    await b.locator(".vault-unlock-input").press("Enter");
    await expectVisible(b, warmup, 25000);
    pass("6. unlock restored encrypted history");
  } catch (e) { fail("6. unlock restore", e); }

  // ---- session continuity post-unlock ------------------------------------------
  const afterUnlock = `post-unlock-${Date.now()}`;
  try {
    await send(a, afterUnlock);
    await expectVisible(b, afterUnlock);
    pass("7. ratchet continues decrypting live traffic after unlock");
  } catch (e) { fail("7. continuity", e); }

  // ---- explicit lock-now round trip --------------------------------------------
  try {
    await b.locator(".vault-lock-btn").click();
    await b.waitForSelector(".vault-unlock-input", { timeout: 20000 });
    const plain = await b.evaluate(() => localStorage.getItem("messaging-protocol-state-v1"));
    if (plain !== null) throw new Error("plaintext present after explicit lock");
    pass("8. Lock now re-locks immediately");
  } catch (e) { fail("8. lock now", e); }

  if (errors.length > 0) console.error("page errors:", errors.slice(0, 5));

  await browser.close();
  await stopServer(URL);
  console.log("\nVAULT TEST COMPLETE");
}

main().catch(async (err) => {
  console.error("VAULT TEST FAILED:", err);
  await stopServer(lastUrl).catch(() => {});
  process.exit(1);
});
