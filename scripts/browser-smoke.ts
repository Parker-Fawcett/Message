/**
 * Browser-level E2EE smoke test: two isolated Playwright contexts
 * (separate localStorage = separate identities) exchange messages through
 * the real dev server. Also asserts plaintext never appears on the wire.
 *
 * Run: npx tsx scripts/browser-smoke.ts   (dev server must be on :3000)
 */
import { chromium } from "playwright";

const URL = "http://localhost:3000";

async function main() {
  const browser = await chromium.launch();
  const aliceCtx = await browser.newContext();
  const bobCtx = await browser.newContext();

  const wireChunks: string[] = [];
  const alicePage = await aliceCtx.newPage();
  alicePage.on("websocket", (ws) => {
    ws.on("framereceived", (frame) => wireChunks.push(String(frame.payload)));
    ws.on("sent", (frame) => wireChunks.push(String(frame.payload)));
  });
  const bobPage = await bobCtx.newPage();

  await alicePage.goto(URL, { waitUntil: "networkidle" });
  await bobPage.goto(URL, { waitUntil: "networkidle" });

  // Both sides must reach ready state and discover each other's bundle.
  const readySel = 'textarea:not([disabled])';
  await alicePage.waitForSelector(readySel, { timeout: 20000 });
  await bobPage.waitForSelector(readySel, { timeout: 20000 });
  await alicePage.waitForFunction(() => document.body.innerText.includes("E2EE"), { timeout: 20000 });
  await bobPage.waitForFunction(() => document.body.innerText.includes("E2EE"), { timeout: 20000 });

  // --- Alice -> Bob ---------------------------------------------------------
  const secret = `attack at dawn ${Date.now()}`;
  await alicePage.fill("textarea", secret);
  await alicePage.keyboard.press("Enter");

  await bobPage.waitForFunction(
    (expected) => document.body.innerText.includes(expected),
    secret,
    { timeout: 20000 },
  );

  // --- Bob -> Alice + read receipt ------------------------------------------
  const reply = `copy that ${Date.now()}`;
  await bobPage.fill("textarea", reply);
  await bobPage.keyboard.press("Enter");
  await alicePage.waitForFunction(
    (expected) => document.body.innerText.includes(expected),
    reply,
    { timeout: 20000 },
  );

  // Bob's view of Alice's message should show "read" state eventually —
  // assert at least both bubbles exist in each window.
  const aliceBubbles = await alicePage.locator("main p.text-sm").count();
  const bobBubbles = await bobPage.locator("main p.text-sm").count();
  if (aliceBubbles < 2 || bobBubbles < 2) {
    throw new Error(`bubble counts wrong: alice=${aliceBubbles} bob=${bobBubbles}`);
  }

  // --- ciphertext opacity: plaintext must not appear in any WS frame --------
  const leaks = wireChunks.filter((chunk) => chunk.includes(secret) || chunk.includes(reply));
  if (leaks.length > 0) {
    throw new Error(`PLAINTEXT LEAKED ON WIRE (${leaks.length} frames)`);
  }
  if (wireChunks.length === 0) throw new Error("no websocket frames captured — interception broken");

  console.log(`ALL BROWSER CHECKS PASSED (${wireChunks.length} ws frames inspected, no plaintext)`);
  await browser.close();
}

main().catch(async (err) => {
  console.error("BROWSER SMOKE FAILED:", err);
  process.exit(1);
});
