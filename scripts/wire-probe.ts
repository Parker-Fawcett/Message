/** Probe: capture raw WS frames during one send to confirm ciphertext is on the wire. */
import { chromium } from "playwright";

const URL = "http://localhost:3000";

async function main() {
  const browser = await chromium.launch();
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  const frames: string[] = [];
  a.on("websocket", (ws) => {
    ws.on("sent", (f) => frames.push(String(f.payload)));
    ws.on("framereceived", (f) => frames.push(String(f.payload)));
  });

  const marker = `probe-${Date.now()}`;
  const chunks: string[] = [];
  const capture = (page: import("playwright").Page) => {
    // Socket.IO may ride HTTP long-polling (invisible to ws listeners), so
    // capture at the network layer instead: POST request bodies carry
    // outbound packets; polling GET responses carry inbound ones.
    page.on("request", (req) => {
      if (req.url().includes("socket.io") && req.method() === "POST") {
        const body = req.postData();
        if (body) chunks.push(body);
      }
    });
    page.on("response", (resp) => {
      if (resp.url().includes("socket.io")) {
        resp.text().then((t) => chunks.push(t)).catch(() => {});
      }
    });
    // Socket.IO upgrades to its own websocket after handshake — filter by URL
    // so we don't mistake Next.js HMR traffic for app traffic.
    page.on("websocket", (ws) => {
      if (!ws.url().includes("socket.io")) return;
      ws.on("sent", (f) => chunks.push(String(f.payload)));
      ws.on("framereceived", (f) => chunks.push(String(f.payload)));
    });
  };
  capture(a);
  capture(b);

  await a.goto(URL, { waitUntil: "networkidle" });
  await b.goto(URL, { waitUntil: "networkidle" });
  await a.waitForSelector("textarea:not([disabled])", { timeout: 25000 });
  await b.waitForFunction(() => document.body.innerText.includes("E2EE"), undefined, { timeout: 25000 });
  await a.waitForFunction(() => document.body.innerText.includes("1 online"), undefined, { timeout: 15000 });

  await a.fill("textarea", marker);
  await a.keyboard.press("Enter");
  await b.waitForFunction((m) => document.body.innerText.includes(m), marker, { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 1000));

  const msgFrames = chunks.filter((f) => f.includes("send-message") || f.includes('"ct"') || f.includes("receive-message"));
  console.log(`captured socket.io chunks: ${chunks.length}, message-ish: ${msgFrames.length}`);
  if (msgFrames.length === 0) {
    console.log("RAW SAMPLES:", chunks.slice(0, 6).map((f) => f.slice(0, 160)));
    throw new Error("no message frames captured");
  }
  const shown = msgFrames.find((f) => f.includes('"ct"')) ?? msgFrames[0];
  const idx = Math.max(0, shown.indexOf('"ct"'));
  console.log("SAMPLE CIPHERTEXT ON WIRE:", shown.slice(idx, idx + 120));
  if (chunks.some((f) => f.includes(marker))) throw new Error("PLAINTEXT MARKER FOUND ON WIRE");
  console.log("PROBE OK: ciphertext present on wire, plaintext marker absent");
  await browser.close();
}

main().catch((e) => {
  console.error("PROBE FAILED:", e);
  process.exit(1);
});
