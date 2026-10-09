import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test, type BrowserContext } from "@playwright/test";
import { startLoopback } from "../__tests__/harness/loopback";
import { fixtureWorker, launchFixture } from "../__tests__/support/browser-observation";
import { buildHarness, launchCoordinator, retain, snapshot } from "./coordinator-observation";
import { buildHistoricalRetentionProduct, retentionProductHead } from "./historical-retention-product";

declare global {
  var __connectorSeed: typeof import("../src/background");
}
test.use({ trace: "off", screenshot: "off" });
let server: Awaited<ReturnType<typeof startLoopback>>;
let historical: string;
let current: string;
const active = new Set<BrowserContext>();
test.beforeAll(async () => {
  server = await startLoopback();
  historical = await buildHistoricalRetentionProduct();
  current = await buildHarness("operation");
});
test.afterEach(async () => {
  for (const context of active) await context.close();
  active.clear();
});
test.afterAll(async () => {
  await server?.close();
});

for (const round of [1, 2])
  test(`connector-coordinator-upgrade-chromium product v1 round ${round} @tcgplayer-connector-extension-authority`, async () => {
    const profile = mkdtempSync(join(tmpdir(), "connector-7940-upgrade-"));
    const context = await launchFixture(historical, profile, [
      `--disable-extensions-except=${historical}`,
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    ]);
    active.add(context);
    const worker = await fixtureWorker(context, "/seed.js");
    const before = await worker.evaluate(async () => {
      const product = globalThis.__connectorSeed;
      await product.boot;
      await product.retentionStore.write({
        rawExportId: "synthetic-7940-v1",
        connectionId: "connection_synthetic",
        downloadedAt: new Date().toISOString(),
        bytes: new TextEncoder().encode("SYNTHETIC_7940_V1_PRODUCT_WRITE"),
        maxBytes: 100,
      });
      return new Promise<{ version: number; stores: string[] }>((resolve, reject) => {
        const request = indexedDB.open("connector-raw-exports");
        request.onsuccess = () => {
          const db = request.result;
          resolve({ version: db.version, stores: Array.from(db.objectStoreNames) });
          db.close();
        };
        request.onerror = () => reject(request.error);
      });
    });
    expect(before).toEqual({ version: 1, stores: ["raw-exports"] });
    await context.close();
    active.delete(context);
    const upgraded = await launchCoordinator(current, profile);
    active.add(upgraded.context);
    const after = await snapshot(upgraded.worker);
    expect(after.version).toBe(2);
    expect(after.stores).toEqual(["operation-attempts", "raw-exports", "reservations"]);
    await upgraded.context.close();
    active.delete(upgraded.context);
    const repeated = await launchCoordinator(current, profile);
    active.add(repeated.context);
    const again = await snapshot(repeated.worker);
    expect(again.version).toBe(2);
    expect(again.stores).toEqual(after.stores);
    retain(`connector-coordinator-upgrade-${round}`, { sourceHead: retentionProductHead, before, after, again });
  });

test("connector-coordinator-upgrade-chromium v3 owner is preserved with zero writes @tcgplayer-connector-extension-authority", async () => {
  const first = await launchCoordinator(current);
  active.add(first.context);
  await first.worker.evaluate(
    async () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("connector-raw-exports", 3);
        request.onupgradeneeded = () =>
          request.result.createObjectStore("future-owner").put("SYNTHETIC_V3_OWNER", "marker");
        request.onsuccess = () => {
          request.result.close();
          resolve();
        };
        request.onerror = () => reject(request.error);
      }),
  );
  await first.context.close();
  active.delete(first.context);
  const second = await launchCoordinator(current, first.profile);
  active.add(second.context);
  const after = await snapshot(second.worker);
  expect(after.version).toBe(3);
  expect(after.stores).toContain("future-owner");
  expect(after.observation.writes).toEqual({ storage: 0, alarms: 0 });
  expect(await second.worker.evaluate(() => chrome.action.getTitle({}))).toBe("upgrade-required");
  retain("connector-coordinator-upgrade-v3", after);
});
