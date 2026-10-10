import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type BrowserContext, type Worker } from "@playwright/test";
import { startLoopback } from "../__tests__/harness/loopback";
import { stageExtension } from "../__tests__/support/extension-staging";
import { fixtureWorker } from "../__tests__/support/browser-observation";
import {
  attestInstallation,
  installationDiagnostics,
  launchInstallation,
  type BundleIdentity,
} from "./extension-installation";
import { buildHarness, retain } from "./coordinator-observation";
import {
  assertUpgradeWitness,
  buildHistoricalRetentionProduct,
  consumeReplacementAuthority,
  currentStores,
  instrumentUpgradeBundle,
  retentionProductHead,
} from "./historical-retention-product";

test.use({ trace: "off", screenshot: "off" });
let server: Awaited<ReturnType<typeof startLoopback>>;
let historical: string;
let current: string;
let currentIdentity: BundleIdentity;
const active = new Set<BrowserContext>();
const authority = consumeReplacementAuthority();
const markerDatabase = "synthetic-9258-profile-continuity";
const rawExportId = "synthetic-9258-v1";

test.beforeAll(async () => {
  retain("connector-coordinator-upgrade-authority", authority);
  server = await startLoopback();
  historical = await buildHistoricalRetentionProduct();
  current = await buildHarness("operation");
  currentIdentity = instrumentUpgradeBundle(current, "current-9258-upgrade-observed");
  for (const directory of [historical, current]) {
    const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.background).toEqual({ service_worker: "background.js", type: "module" });
  }
});
async function close(context: BrowserContext) {
  await context.close();
  active.delete(context);
}
test.afterEach(async () => {
  for (const context of active) await close(context);
});
test.afterAll(async () => {
  await server?.close();
});

async function settle(worker: Worker, historicalWorker: boolean) {
  await worker.evaluate(async (historicalWorker) => {
    const product = historicalWorker ? globalThis.__connectorSeed : globalThis.__connectorHarness.product;
    await product.boot;
    // Same onInstalled observation window as the accepted replacement probe.
    const remaining = Date.parse(globalThis.__connectorUpgradeProbe.startedAt) + 2_000 - Date.now();
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  }, historicalWorker);
  await expect.poll(() => worker.evaluate(() => globalThis.__connectorUpgradeProbe.installs.length)).toBeGreaterThan(0);
}

async function seed(worker: Worker, marker: string) {
  return worker.evaluate(
    async ({ marker, markerDatabase, rawExportId }) => {
      await globalThis.__connectorSeed.retentionStore.write({
        rawExportId,
        connectionId: "connection_synthetic",
        downloadedAt: new Date().toISOString(),
        bytes: new TextEncoder().encode("SYNTHETIC_9258_V1_PRODUCT_WRITE"),
        maxBytes: 100,
      });
      const keyId = await new Promise<string>((resolve, reject) => {
        const request = indexedDB.open("connector-raw-exports");
        request.onupgradeneeded = () => request.transaction!.abort();
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const transaction = db.transaction("raw-exports");
          const read = transaction.objectStore("raw-exports").get(rawExportId);
          transaction.oncomplete = () => {
            db.close();
            if (typeof read.result?.keyId !== "string") reject(new Error("historical-product-row-missing"));
            else resolve(read.result.keyId);
          };
          transaction.onabort = () => {
            db.close();
            reject(transaction.error);
          };
        };
      });
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(markerDatabase, 1);
        request.onupgradeneeded = () => request.result.createObjectStore("markers");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const transaction = db.transaction("markers", "readwrite");
          transaction.objectStore("markers").add(marker, "profile");
          transaction.oncomplete = () => {
            db.close();
            resolve();
          };
          transaction.onabort = () => {
            db.close();
            reject(transaction.error);
          };
        };
      });
      return keyId;
    },
    { marker, markerDatabase, rawExportId },
  );
}

async function observe(worker: Worker, keyId: string | null) {
  return worker.evaluate(
    async ({ keyId, markerDatabase }) => {
      const open = (name: string) =>
        new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open(name);
          request.onupgradeneeded = () => request.transaction!.abort();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
          request.onblocked = () => reject(new Error("observation-database-blocked"));
        });
      const database = await open("connector-raw-exports");
      let journal: { version: number; stores: string[]; rows: Record<string, unknown[]> };
      try {
        const stores = Array.from(database.objectStoreNames);
        const rows = await new Promise<Record<string, unknown[]>>((resolve, reject) => {
          const transaction = database.transaction(stores);
          const reads = stores.map((name) => [name, transaction.objectStore(name).getAll()] as const);
          transaction.oncomplete = () =>
            resolve(Object.fromEntries(reads.map(([name, request]) => [name, request.result])));
          transaction.onabort = () => reject(transaction.error);
        });
        journal = { version: database.version, stores, rows };
      } finally {
        database.close();
      }
      let marker: string | null = null;
      if (keyId !== null) {
        const db = await open(markerDatabase);
        try {
          marker = await new Promise<string | null>((resolve, reject) => {
            const transaction = db.transaction("markers");
            const read = transaction.objectStore("markers").get("profile");
            transaction.oncomplete = () => resolve(read.result ?? null);
            transaction.onabort = () => reject(transaction.error);
          });
        } finally {
          db.close();
        }
      }
      const probe = globalThis.__connectorUpgradeProbe;
      return {
        observedAt: new Date().toISOString(),
        identity: {
          workerUrl: globalThis.location.href,
          manifest: chrome.runtime.getManifest(),
          bundle: globalThis.__connectorExecutedBundle ?? null,
          installReasons: probe.installs,
        },
        version: journal.version,
        stores: journal.stores,
        members: journal.rows["operation-attempts"] ?? [],
        reservations: journal.rows.reservations ?? [],
        rawExports: journal.rows["raw-exports"] ?? [],
        journal: journal.rows,
        marker,
        keyPresent: keyId !== null && (await chrome.storage.session.get([keyId]))[keyId] != null,
        probe,
        observation: globalThis.__connectorHarness?.observation.snapshot() ?? null,
        title: await chrome.action.getTitle({}),
      };
    },
    { keyId, markerDatabase },
  );
}

async function failureObservations(keyId: string | null) {
  return Promise.all(
    [...active].flatMap((context) =>
      context.serviceWorkers().map(async (worker) => {
        try {
          return await observe(worker, keyId);
        } catch (error) {
          return { workerUrl: worker.url(), error: String(error) };
        }
      }),
    ),
  );
}

for (const round of ["old-bundle-no-swap", 1, 2] as const)
  test(`connector-coordinator-upgrade-chromium product v1 round ${round} @tcgplayer-connector-extension-authority`, async () => {
    const evidence: Record<string, unknown> = {
      sourceHead: retentionProductHead,
      round,
      authority: authority.authority,
    };
    let keyId: string | null = null;
    try {
      const initial = await launchInstallation(historical);
      active.add(initial.context);
      evidence.profile = initial.profile;
      evidence.installation = initial.directory;
      evidence.initialStaging = initial.staging;
      const worker = await attestInstallation(initial);
      await settle(worker, true);
      const marker = `SYNTHETIC_9258_PROFILE_${randomUUID()}`;
      keyId = await seed(worker, marker);
      const before = await observe(worker, keyId);
      evidence.before = before;
      expect(before.version).toBe(1);
      expect(before.stores).toEqual(["raw-exports"]);
      expect(before.rawExports).toHaveLength(1);
      expect(before.rawExports[0]).toMatchObject({ rawExportId, schemaVersion: 1 });
      expect(before.keyPresent).toBe(true);
      expect(before.marker).toBe(marker);
      expect(before.probe.upgrades).toMatchObject([
        { oldVersion: 0, newVersion: 1, status: "committed", stores: ["raw-exports"] },
      ]);
      await close(initial.context);

      if (round !== "old-bundle-no-swap") evidence.replacementStaging = stageExtension(current, initial.directory);
      const relaunched = await launchInstallation(
        round === "old-bundle-no-swap" ? historical : current,
        initial.profile,
      );
      active.add(relaunched.context);
      evidence.relaunchStaging = relaunched.staging;
      expect(relaunched.directory).toBe(initial.directory);
      expect(relaunched.context.browser()!.version()).toBe(authority.packet.pins.chromiumVersion);
      const oldWorker = await fixtureWorker(relaunched.context, "/background.js");
      await settle(oldWorker, true);
      const historicalRelaunch = await observe(oldWorker, keyId);
      evidence.historicalRelaunch = historicalRelaunch;
      expect(historicalRelaunch.identity.bundle).toEqual(initial.identity);
      expect(historicalRelaunch.identity.manifest).toEqual(relaunched.manifest);
      expect(historicalRelaunch.identity.workerUrl).toBe(before.identity.workerUrl);
      expect(historicalRelaunch.version).toBe(1);
      expect(historicalRelaunch.stores).toEqual(["raw-exports"]);
      expect(historicalRelaunch.probe.upgrades).toEqual([]);
      expect(historicalRelaunch.marker).toBe(marker);
      expect(historicalRelaunch.keyPresent).toBe(false);
      expect(historicalRelaunch.rawExports).toEqual([]);
      if (round === "old-bundle-no-swap") {
        let error: string | null = null;
        try {
          assertUpgradeWitness(historicalRelaunch, currentIdentity, marker);
        } catch (failure) {
          error = String(failure);
        }
        evidence.currentWorkerWitnessError = error;
        expect(error).toContain("current executed identity");
        expect(() => expect(historicalRelaunch.version).toBe(3)).toThrow();
        return;
      }

      const cdp = await relaunched.context.browser()!.newBrowserCDPSession();
      evidence.replacementRequest = { route: "Extensions.loadUnpacked", requestedAt: new Date().toISOString() };
      try {
        const { id } = await cdp.send("Extensions.loadUnpacked", { path: relaunched.directory });
        evidence.replacementResponse = { id, observedAt: new Date().toISOString() };
        expect(id).toBe(new URL(before.identity.workerUrl).host);
      } finally {
        await cdp.detach();
      }
      let replacement: Worker | undefined;
      await expect
        .poll(
          () => {
            replacement = relaunched.context
              .serviceWorkers()
              .find((candidate) => candidate !== oldWorker && candidate.url() === oldWorker.url());
            return replacement !== undefined;
          },
          { timeout: 10_000 },
        )
        .toBe(true);
      const upgradedWorker = replacement!;
      await settle(upgradedWorker, false);
      const after = await observe(upgradedWorker, keyId);
      evidence.after = after;
      expect(after.identity.manifest).toEqual(relaunched.manifest);
      expect(after.identity.workerUrl).toBe(before.identity.workerUrl);
      assertUpgradeWitness(after, currentIdentity, marker);
      await close(relaunched.context);

      const repeated = await launchInstallation(current, initial.profile);
      active.add(repeated.context);
      evidence.repeatStaging = repeated.staging;
      const repeatedWorker = await attestInstallation(repeated);
      await settle(repeatedWorker, false);
      const again = await observe(repeatedWorker, keyId);
      evidence.again = again;
      expect(again.version).toBe(3);
      expect(again.stores).toEqual(after.stores);
      expect(again.journal).toEqual(after.journal);
      expect(again.rawExports).toEqual([]);
      expect(again.marker).toBe(marker);
      expect(again.keyPresent).toBe(false);
      expect(again.probe.upgrades).toEqual([]);
    } catch (error) {
      evidence.error = String(error);
      evidence.failureObservations = await failureObservations(keyId);
      throw error;
    } finally {
      evidence.workers = await Promise.all([...active].map(installationDiagnostics));
      retain(`connector-coordinator-upgrade-${round}`, evidence);
    }
  });

test("connector-coordinator-upgrade-chromium v4 owner is preserved with zero writes @tcgplayer-connector-extension-authority", async () => {
  const evidence: Record<string, unknown> = { authority: authority.authority };
  try {
    const first = await launchInstallation(current);
    active.add(first.context);
    evidence.initialStaging = first.staging;
    const worker = await attestInstallation(first);
    await settle(worker, false);
    evidence.before = await observe(worker, null);
    const upgrade = await worker.evaluate(
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
    evidence.upgrade = upgrade;
    expect(upgrade).toEqual({ oldVersion: 3, newVersion: 4 });
    const fixture = await observe(worker, null);
    evidence.fixture = fixture;
    expect(fixture.journal["future-owner"]).toEqual(["SYNTHETIC_V4_OWNER"]);
    await close(first.context);
    const second = await launchInstallation(current, first.profile);
    active.add(second.context);
    evidence.relaunchStaging = second.staging;
    const repeatedWorker = await attestInstallation(second);
    await settle(repeatedWorker, false);
    const after = await observe(repeatedWorker, null);
    evidence.after = after;
    expect(after.version).toBe(4);
    expect(after.stores).toEqual(["future-owner", ...currentStores]);
    expect(after.journal).toEqual(fixture.journal);
    expect(after.observation?.writes).toEqual({ storage: 0, alarms: 0 });
    expect(after.probe.upgrades).toEqual([]);
    expect(after.title).toBe("upgrade-required");
  } catch (error) {
    evidence.error = String(error);
    evidence.failureObservations = await failureObservations(null);
    throw error;
  } finally {
    evidence.workers = await Promise.all([...active].map(installationDiagnostics));
    retain("connector-coordinator-upgrade-v4", evidence);
  }
});

test("connector-coordinator-upgrade-chromium witness rejects missing continuity and non-native migrations @tcgplayer-connector-extension-authority", () => {
  const identity = { sourceSha256: "SYNTHETIC_9258_BUNDLE", transform: "SYNTHETIC_9258_CONTROL" };
  const marker = "SYNTHETIC_9258_MARKER";
  const upgrade = {
    oldVersion: 1,
    newVersion: 3,
    status: "committed" as const,
    stores: currentStores,
    observedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:00.001Z",
  };
  const state = {
    identity: { bundle: identity },
    version: 3,
    stores: currentStores,
    marker,
    keyPresent: false,
    rawExports: [],
    probe: { upgrades: [upgrade] },
  };
  expect(() => assertUpgradeWitness(state, identity, marker)).not.toThrow();
  for (const absent of [null, "SYNTHETIC_9258_CHANGED"])
    expect(() => assertUpgradeWitness({ ...state, marker: absent }, identity, marker)).toThrow();
  for (const upgrades of [
    [],
    [{ ...upgrade, oldVersion: 0 }],
    [{ ...upgrade, status: "aborted" as const }],
    [{ ...upgrade, status: "pending" as const }],
  ])
    expect(() => assertUpgradeWitness({ ...state, probe: { upgrades } }, identity, marker)).toThrow();
});
