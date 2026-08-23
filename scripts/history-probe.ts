/** Isolated probe of encrypted local history: chat, reload, inspect storage + UI. */
import { chromium } from "playwright";
import { spawn, execSync } from "node:child_process";

const URL = "http://localhost:3000";

// Bundles persist across disconnects by design, so a long-lived server
// accumulates stale peers that poison discovery. Isolate: fresh server.
async function freshServer(): Promise<void> {
  try {
    execSync("lsof -ti:3000 -sTCP:LISTEN | xargs kill", { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 1000));
  } catch {}
  const child = spawn("node", ["server.js"], { cwd: process.cwd(), stdio: "ignore", detached: true });
  child.unref();
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await fetch(URL).then((r) => r.ok).catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("server did not start");
}

async function main() {
  await freshServer();
  const browser = await chromium.launch();
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  const marker = "unused";
  const markers: string[] = [];
  let reply = "";
  const errors: string[] = [];
  for (const p of [a, b]) {
    p.on("console", (m) => {
      if (m.type() === "error" || m.type() === "warning") errors.push(`[${m.type()}] ${m.text().slice(0, 200)}`);
    });
    p.on("pageerror", (e) => errors.push(`[pageerror] ${String(e).slice(0, 300)}`));
  }
  await a.goto(URL, { waitUntil: "networkidle" });
  await b.goto(URL, { waitUntil: "networkidle" });
  await b.waitForSelector("textarea:not([disabled])", { timeout: 25000 });
  try {
    await a.waitForFunction(() => document.body.innerText.includes("1 online"), undefined, { timeout: 15000 });

    markers.push(`h1-${Date.now()}`, `h2-${Date.now()}`, `h3-${Date.now()}`);
    for (const m of markers) {
      await a.fill("textarea", m);
      await a.keyboard.press("Enter");
    }
    for (const m of markers) {
      await b.waitForFunction((x) => document.body.innerText.includes(x), m, { timeout: 15000 });
    }
    reply = `reply-${Date.now()}`;
    await b.fill("textarea", reply);
    await b.keyboard.press("Enter");
    await a.waitForFunction((x) => document.body.innerText.includes(x), reply, { timeout: 15000 });
  } catch (e) {
    console.log("--- DIAGNOSTIC DUMP ---");
    console.log("a main:", JSON.stringify((await a.locator("main").innerText().catch(() => "")).slice(0, 200)));
    console.log("b FULL BODY:", JSON.stringify((await b.locator("body").innerText().catch(() => "")).slice(0, 500)));
    await b.screenshot({ path: "/tmp/messaging-shots/probe-b.png", fullPage: true }).catch(() => {});
    const storageKeys = await b.evaluate(() => Object.keys(localStorage));
    console.log("b storage keys:", storageKeys);
    console.log("page errors:", errors.length ? errors.slice(0, 8) : "none");
    throw e;
  }
  await new Promise((r) => setTimeout(r, 1200)); // let the debounced flush fire

  const storedBefore = await b.evaluate(() => localStorage.getItem("messaging-history-v1"));
  console.log("storage present:", Boolean(storedBefore), "len:", storedBefore?.length ?? 0);
  console.log("storage head:", storedBefore?.slice(0, 120));

  await b.reload({ waitUntil: "networkidle" });
  await b.waitForSelector("textarea:not([disabled])", { timeout: 25000 });
  await new Promise((r) => setTimeout(r, 1000));
  const visible = await b.locator("main").innerText();
  console.log("markers visible after reload:", markers.every((m) => visible.includes(m)), "| reply:", visible.includes(reply));
  console.log("page errors:", errors.length ? errors.slice(0, 8) : "none");
  if (!markers.every((m) => visible.includes(m))) {
    console.log("main text:", visible.slice(0, 300));
    process.exitCode = 1;
  } else {
    console.log("HISTORY PROBE OK");
  }
  await browser.close();
}

main().catch((e) => {
  console.error("PROBE FAILED:", e);
  process.exit(1);
});
