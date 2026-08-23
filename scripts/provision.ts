import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { rmSync } from "node:fs";

/**
 * Spawns a dedicated dev server on a fresh port so suites never contend for
 * :3000 (next dev refuses to double-start on a busy project port, which used
 * to leave stale servers silently serving old code). Verifies identity via
 * /health before handing back the base URL.
 */
export async function provisionServer(envExtra: Record<string, string> = {}): Promise<string> {
  // Fresh audit log per provisioning — suites assert on exact event counts.
  const wireLog = envExtra.MSG_WIRE_LOG;
  if (wireLog) {
    try {
      rmSync(wireLog, { force: true });
    } catch {}
  }
  const port = await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.listen(0, () => {
      const addr = probe.address() as { port: number };
      probe.close(() => resolve(addr.port));
    });
    probe.on("error", reject);
  });
  const url = `http://localhost:${port}`;

  spawn("node", ["server.js"], {
    cwd: process.cwd(),
    stdio: "ignore",
    detached: true,
    // Production mode: next dev holds a project-wide single-instance lock,
    // which makes parallel/sequential multi-server provisioning impossible.
    // Requires `npm run build` to have been run first.
    env: { ...process.env, ...envExtra, PORT: String(port), NODE_ENV: "production" },
  }).unref();

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const h = await fetch(`${url}/health`).then((r) => r.json());
      if (h.pid > 0 && h.port === port) return url;
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("dev server did not come up healthy on port " + port);
}

/** Asks a running provisioned server to exit cleanly. */
export async function stopServer(url: string): Promise<void> {
  await fetch(`${url}/shutdown`, { method: "POST" }).catch(() => {});
}
