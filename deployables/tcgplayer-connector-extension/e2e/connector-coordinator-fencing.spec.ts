import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "vite";
import { expect, test, type BrowserContext } from "@playwright/test";
import { TCGPLAYER_CONNECTOR_EXTENSION_ID } from "@chase-sets/channels/client";
import { createWorkspaceSourceAliases } from "../../../scripts/workspace-source-aliases.mjs";
import { startLoopback } from "../__tests__/harness/loopback";
import { syntheticClaim } from "../__tests__/harness/claim";
import { synthetic } from "./loopback-platform";
import { buildHarness, launchCoordinator, packageRoot, pair, retain, snapshot, wake } from "./coordinator-observation";

declare global {
  var __fenceWorkers: Worker[];
  var __fenceEvents: { worker: number; phase: string; result?: unknown }[];
}
test.use({ trace: "off", screenshot: "off" });
let server: Awaited<ReturnType<typeof startLoopback>>;
let extension: string;
let context: BrowserContext | undefined;
test.beforeAll(async () => {
  server = await startLoopback();
  extension = await buildHarness("operation");
  await build({
    root: packageRoot,
    configFile: false,
    logLevel: "warn",
    resolve: { alias: createWorkspaceSourceAliases() },
    define: { "import.meta.env.VITE_HARNESS_EXECUTOR_UNIT": JSON.stringify("operation") },
    build: {
      outDir: extension,
      emptyOutDir: false,
      rolldownOptions: {
        input: { "fence-worker": resolve(packageRoot, "__tests__/harness/fence-worker.ts") },
        output: { entryFileNames: "[name].js", codeSplitting: false },
      },
    },
  });
  writeFileSync(resolve(extension, "fence.html"), "<!doctype html><title>SYNTHETIC IndexedDB fencing</title>");
});
test.beforeEach(() => server.reset());
test.afterEach(async () => {
  await context?.close();
  context = undefined;
});
test.afterAll(async () => {
  await server?.close();
});

for (const cause of ["stale-fence", "pause", "revoke", "lease-expiry", "newer-claim"] as const) {
  test(`connector-coordinator-fencing-interleavings-chromium ${cause} @tcgplayer-connector-extension-authority`, async () => {
    const f = await launchCoordinator(extension);
    context = f.context;
    await pair(f.context, f.worker);
    await f.worker.evaluate(() =>
      globalThis.__connectorHarness.observation.arm({ phase: "dispatched", side: "pending" }),
    );
    const claim = syntheticClaim();
    server.claims.push(claim);
    await wake(f.worker);
    await expect.poll(async () => (await snapshot(f.worker)).observation.interrupted).toBe(true);
    const before = await snapshot(f.worker);
    expect(before.members[0]?.state).toBe("prepared");
    await f.worker.evaluate(() => chrome.alarms.clear("connector-work"));
    const page = await f.context.newPage();
    await page.goto(`chrome-extension://${TCGPLAYER_CONNECTOR_EXTENSION_ID}/fence.html`);
    await page.evaluate((accessToken) => {
      globalThis.__fenceEvents = [];
      globalThis.__fenceWorkers = [0, 1].map((worker) => {
        const instance = new Worker("./fence-worker.js", { type: "module" });
        instance.onmessage = ({ data }) => globalThis.__fenceEvents.push({ worker, ...data });
        instance.postMessage({ action: "coordinate", accessToken, unit: "operation" });
        return instance;
      });
    }, synthetic.access);
    await expect
      .poll(() => page.evaluate(() => globalThis.__fenceEvents.filter((item) => item.phase === "prepared").length))
      .toBe(2);
    if (cause === "newer-claim") {
      const future = Date.now() + 1800001;
      const newer = syntheticClaim(future);
      server.claims.push({
        ...newer,
        reservationId: "synthetic-newer-reservation",
        operations: newer.operations.map((member) => ({
          ...member,
          attemptId: "synthetic-newer-attempt",
          claimGeneration: 2,
        })),
      });
      await f.worker.evaluate((now) => {
        Date.now = () => now;
        globalThis.__connectorHarness.observation.arm({ phase: "prepared", side: "committed" });
      }, future);
      // The actual alarm fires on wall time; only the coordinator's injected clock moves.
      await f.worker.evaluate(async () => {
        await chrome.alarms.create("connector-work", { when: new Date().getTime() + 50 });
      });
      await expect
        .poll(async () => (await snapshot(f.worker)).reservations[0]?.reservationId)
        .toBe("synthetic-newer-reservation");
    }
    await page.evaluate(
      ({ cause, expires }) => {
        if (cause === "pause" || cause === "revoke")
          globalThis.__fenceWorkers[1]!.postMessage({
            action: "authority",
            value: cause === "pause" ? "report-only" : "absent",
          });
        if (cause === "lease-expiry")
          for (const worker of globalThis.__fenceWorkers) worker.postMessage({ action: "clock", value: expires });
        for (const worker of globalThis.__fenceWorkers) worker.postMessage({ action: "release" });
      },
      { cause, expires: Date.parse(claim.leaseExpiresAt) },
    );
    await expect
      .poll(() => page.evaluate(() => globalThis.__fenceEvents.filter((item) => item.phase === "settled").length))
      .toBe(2);
    const after = await snapshot(f.worker);
    expect(server.portalCalls.length).toBeLessThanOrEqual(1);
    if (cause === "lease-expiry" || cause === "newer-claim") expect(server.portalCalls).toHaveLength(0);
    if (cause === "newer-claim") expect(after.members[0]?.attemptId).toBe("synthetic-newer-attempt");
    retain(`connector-coordinator-fencing-${cause}`, {
      before,
      after,
      workerEvents: await page.evaluate(() => globalThis.__fenceEvents),
    });
  });
}
