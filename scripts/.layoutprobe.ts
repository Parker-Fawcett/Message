import { chromium } from "playwright";
import { provisionServer } from "./provision";

async function main() {
  const URL = await provisionServer({});
  const browser = await chromium.launch();
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  for (const p of [a, b]) {
    await p.goto(URL, { waitUntil: "networkidle" });
    await p.waitForSelector("textarea:not([disabled])", { timeout: 25000 });
  }
  await b.waitForFunction(() => document.body.innerText.includes("1 online"), undefined, { timeout: 15000 }).catch(() => {});

  await a.fill("textarea", "where does this render?");
  await a.keyboard.press("Enter");
  await b.waitForFunction(() => document.body.innerText.includes("where does this render?"), undefined, { timeout: 20000 });

  // geometry: where does B see the incoming bubble?
  const asideBox = await b.evaluate(() => {
    const el = document.querySelector("aside");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { x: Math.round(r.x), w: Math.round(r.width), display: cs.display };
  });
  console.log("ASIDE:", JSON.stringify(asideBox));
  const box = await b.evaluate(() => {
    const el = [...document.querySelectorAll("main .rounded-\\[22px\\]")].find((e) => e.textContent?.includes("where does this render?"));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), w: Math.round(r.width), inMain: !!el.closest("main") };
  });
  const asideText = await b.locator("aside").innerText();
  console.log(JSON.stringify({ bubble: box, asideContainsPreview: asideText.includes("where does this render") }, null, 2));

  await b.setViewportSize({ width: 1280, height: 800 });
  await b.screenshot({ path: "/tmp/layout-desktop.png" });
  await b.setViewportSize({ width: 375, height: 812 });
  await b.screenshot({ path: "/tmp/layout-mobile.png" });
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
