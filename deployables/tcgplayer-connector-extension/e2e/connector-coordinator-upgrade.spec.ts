import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test, type BrowserContext } from "@playwright/test";
import { startLoopback } from "../__tests__/harness/loopback";
import { attestInstallation, installationDiagnostics, launchInstallation } from "./extension-installation";
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

for (const round of [1, 2, "old-bundle-no-swap"] as const)
  test(`connector-coordinator-upgrade-chromium product v1 round ${round} @tcgplayer-connector-extension-authority`, async () => {
    const evidence: Record<string, unknown> = { sourceHead: retentionProductHead, round };
    try {
      const profile = mkdtempSync(join(tmpdir(), "connector-7940-upgrade-"));
      const initial = await launchInstallation(historical, profile, false);
      const { context } = initial;
      active.add(context);
      const worker = await attestInstallation(initial);
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
      evidence.before = before;
      evidence.initialWorkers = await installationDiagnostics(context);
      evidence.profile = profile;
      evidence.installation = initial.directory;
      await context.close();
      active.delete(context);
      if (round === "old-bundle-no-swap") {
        const unchanged = await launchInstallation(historical, profile);
        active.add(unchanged.context);
        const currentIdentity = JSON.parse(readFileSync(join(current, "execution-identity.json"), "utf8"));
        const currentManifest = JSON.parse(readFileSync(join(current, "manifest.json"), "utf8"));
        const error = await attestInstallation({
          ...unchanged,
          identity: currentIdentity,
          manifest: currentManifest,
        }).then(
          () => null,
          (error: unknown) => String(error),
        );
        evidence.currentWorkerWitnessError = error;
        expect(error).not.toBeNull();
        const actual = await attestInstallation(unchanged);
        const retained = await actual.evaluate(async () =>
          (await indexedDB.databases()).find((db) => db.name === "connector-raw-exports"),
        );
        evidence.after = retained;
        expect(retained?.version).toBe(1);
        expect(() => expect(retained?.version).toBe(3)).toThrow();
        return;
      }
      const upgraded = await launchCoordinator(current, profile);
      active.add(upgraded.context);
      expect(upgraded.directory).toBe(initial.directory);
      const after = await snapshot(upgraded.worker);
      evidence.after = after;
      expect(after.version).toBe(3);
      expect(after.stores).toEqual(["operation-attempts", "raw-exports", "reservations"]);
      await upgraded.context.close();
      active.delete(upgraded.context);
      const repeated = await launchCoordinator(current, profile);
      active.add(repeated.context);
      const again = await snapshot(repeated.worker);
      evidence.again = again;
      expect(again.version).toBe(3);
      expect(again.stores).toEqual(after.stores);
      expect(again.members).toEqual(after.members);
      expect(again.reservations).toEqual(after.reservations);
      expect(again.rawExports).toEqual(after.rawExports);
    } catch (error) {
      evidence.error = String(error);
      throw error;
    } finally {
      evidence.workers = await Promise.all([...active].map(installationDiagnostics));
      retain(`connector-coordinator-upgrade-${round}`, evidence);
    }
  });

test("connector-coordinator-upgrade-chromium v4 owner is preserved with zero writes @tcgplayer-connector-extension-authority", async () => {
  const first = await launchCoordinator(current);
  active.add(first.context);
  const upgrade = await first.worker.evaluate(
    async () =>
      new Promise<{ oldVersion: number; newVersion: number | null } | null>((resolve, reject) => {
        let upgrade: { oldVersion: number; newVersion: number | null } | null = null;
        const request = indexedDB.open("connector-raw-exports", 4);
        request.onupgradeneeded = (event) => {
          upgrade = { oldVersion: event.oldVersion, newVersion: event.newVersion };
          request.result.createObjectStore("future-owner").put("SYNTHETIC_V4_OWNER", "marker");
        };
        request.onsuccess = () => {
          request.result.close();
          resolve(upgrade);
        };
        request.onerror = () => reject(request.error);
      }),
  );
  retain("connector-coordinator-upgrade-v4-fixture", { upgrade });
  expect(upgrade).toEqual({ oldVersion: 3, newVersion: 4 });
  await first.context.close();
  active.delete(first.context);
  const second = await launchCoordinator(current, first.profile);
  active.add(second.context);
  const after = await snapshot(second.worker);
  expect(after.version).toBe(4);
  expect(after.stores).toContain("future-owner");
  expect(after.observation.writes).toEqual({ storage: 0, alarms: 0 });
  expect(await second.worker.evaluate(() => chrome.action.getTitle({}))).toBe("upgrade-required");
  retain("connector-coordinator-upgrade-v4", after);
});
