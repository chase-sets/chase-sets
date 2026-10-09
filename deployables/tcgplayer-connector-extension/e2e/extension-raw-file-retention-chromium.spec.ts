import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Worker } from "@playwright/test";
import {
  bootRetention,
  chromiumVersion,
  clockAt,
  launchRetention,
  observeRetention,
  prepareRetention,
  productDigest,
  retentionCallback,
} from "./retention-observation";

test.use({ trace: "off", screenshot: "off" });

async function custodyWitness(worker: Worker) {
  return worker.evaluate(async () => {
    const db =
      globalThis.__retentionSyntheticHolder ??
      (await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("connector-raw-exports");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }));
    try {
      const rows = await new Promise<unknown[]>((resolve, reject) => {
        const request = db.transaction("raw-exports").objectStore("raw-exports").getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return JSON.stringify({ rows, session: await chrome.storage.session.get(null) }, (_key, value) =>
        value instanceof ArrayBuffer
          ? Array.from(new Uint8Array(value))
          : value instanceof Uint8Array
            ? Array.from(value)
            : value,
      );
    } finally {
      if (db !== globalThis.__retentionSyntheticHolder) db.close();
    }
  });
}

for (const blocked of [false, true]) {
  test(`extension-raw-file-retention-chromium synthetic ${blocked ? "blocked open" : "versionchange"} preserves custody`, async () => {
    const { context, worker } = await launchRetention();
    const phases: unknown[] = [];
    try {
      const time = await prepareRetention(worker);
      await clockAt(worker, time.before);
      phases.push({ phase: "before", ...(await observeRetention(worker)) });
      const before = await custodyWitness(worker);
      await worker.evaluate(async (block) => {
        const nativeOpen = indexedDB.open.bind(indexedDB);
        const currentVersion = (await indexedDB.databases()).find((db) => db.name === "connector-raw-exports")?.version;
        if (!currentVersion) throw new Error("fixture-database-missing");
        let changed = false;
        let closedOnChange = false;
        const startUpgrade = () => {
          const request = nativeOpen("connector-raw-exports", currentVersion + 1);
          request.onupgradeneeded = () =>
            request.result.createObjectStore("pending-operations").add("SYNTHETIC_COMPETING_OWNER_7922", "pending");
          const committed = new Promise<void>((resolve, reject) => {
            request.onsuccess = () => {
              request.result.close();
              resolve();
            };
            request.onerror = () => reject(request.error);
          });
          Reflect.set(globalThis, "__retentionSyntheticUpgrade", committed);
          return { request, committed };
        };
        if (block) {
          const holder = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = nativeOpen("connector-raw-exports", currentVersion);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          globalThis.__retentionSyntheticHolder = holder;
          holder.onversionchange = () => {};
          const { request } = startUpgrade();
          await new Promise<void>((resolve) => {
            request.onblocked = () => resolve();
          });
        } else {
          indexedDB.open = (name, version) => {
            indexedDB.open = nativeOpen;
            const request = nativeOpen(name, version!);
            request.addEventListener("success", () => {
              const db = request.result;
              db.addEventListener("versionchange", () => {
                changed = true;
              });
              const close = db.close.bind(db);
              db.close = () => {
                closedOnChange ||= changed;
                close();
              };
              startUpgrade();
            });
            return request;
          };
          await globalThis.__retentionProduct.retentionStore.inspect();
          await Reflect.get(globalThis, "__retentionSyntheticUpgrade");
          if (!changed || !closedOnChange) throw new Error("product-versionchange-close-not-observed");
        }
      }, blocked);
      if (blocked) {
        await clockAt(worker, time.deadline);
        expect(
          await worker.evaluate(() =>
            globalThis.__retentionProduct.retentionStore.run({ reason: "retention", deleteAll: false }),
          ),
        ).toEqual({ ok: false, nextDeadline: null, error: "cleanup-failed" });
        await bootRetention(worker);
        const observation = await observeRetention(worker, true);
        phases.push({ phase: "blocked", ...observation });
        expect(observation).toMatchObject({
          P: true,
          K: true,
          R: false,
          ciphertext: true,
          state: { state: "paused", pauseReason: "cleanup-failed" },
        });
        const signals = await worker.evaluate(async () => ({
          alarm: await chrome.alarms.get("connector-retention-deadline"),
          badge: await chrome.action.getBadgeText({}),
          title: await chrome.action.getTitle({}),
        }));
        expect(signals.alarm?.scheduledTime).toBe(time.deadline + 30_000);
        expect(signals.badge).toBe("II");
        expect(signals.title).toBe("paused");
        expect(await custodyWitness(worker)).toBe(before);
        await worker.evaluate(async () => {
          globalThis.__retentionSyntheticHolder!.close();
          globalThis.__retentionSyntheticHolder = undefined;
          await Reflect.get(globalThis, "__retentionSyntheticUpgrade");
        });
      }
      await bootRetention(worker);
      const after = await observeRetention(worker);
      phases.push({ phase: "newer-owner", ...after });
      expect(after).toMatchObject({
        P: true,
        K: true,
        R: false,
        ciphertext: true,
        state: { state: "upgrade-required" },
      });
      expect(await custodyWitness(worker)).toBe(before);
      expect(
        await worker.evaluate(
          () =>
            new Promise<string>((resolve, reject) => {
              const request = indexedDB.open("connector-raw-exports");
              request.onsuccess = () => {
                const db = request.result;
                const witness = db.transaction("pending-operations").objectStore("pending-operations").get("pending");
                witness.onsuccess = () => {
                  db.close();
                  resolve(witness.result);
                };
                witness.onerror = () => {
                  db.close();
                  reject(witness.error);
                };
              };
              request.onerror = () => reject(request.error);
            }),
        ),
      ).toBe("SYNTHETIC_COMPETING_OWNER_7922");
    } finally {
      const evidence = resolve(import.meta.dirname, "../../../artifacts/7922-retention");
      mkdirSync(evidence, { recursive: true });
      writeFileSync(
        resolve(evidence, blocked ? "blocked-open.json" : "versionchange.json"),
        JSON.stringify(
          {
            scenario: blocked ? "synthetic-blocked-newer-owner" : "synthetic-newer-owner-versionchange",
            chromium: await chromiumVersion(context),
            digest: productDigest(),
            phases,
            observationScope:
              "Native IndexedDB/session recovery only; controlled application clock, no V8/OS heap absence claim.",
          },
          null,
          2,
        ),
      );
      await context.close();
    }
  });
}

test("extension-raw-file-retention-chromium acceptance and unpair", async () => {
  for (const reason of ["accept", "unpair"]) {
    const { context, worker } = await launchRetention();
    try {
      await prepareRetention(worker);
      await worker.evaluate(async (action) => {
        const product = globalThis.__retentionProduct;
        if (action === "accept") await product.retentionStore.accept("synthetic_raw");
        else await product.retentionStore.run({ reason: "unpair", deleteAll: true });
      }, reason);
      expect(await observeRetention(worker)).toMatchObject({ P: false, K: false, R: false, ciphertext: false });
    } finally {
      await context.close();
    }
  }
});

test("extension-raw-file-retention-chromium deadline-cleared mutant is caught independently of read refusal", async () => {
  const candidate = await launchRetention();
  const arms = [candidate];
  const phases: unknown[] = [];
  try {
    arms.push(await launchRetention());
    const before = Date.now();
    for (const { worker } of arms) {
      await clockAt(worker, before);
      const time = await prepareRetention(worker);
      expect(time).toEqual({ before, deadline: before + 86400000 });
      await clockAt(worker, time.deadline);
      const observation = await observeRetention(worker);
      phases.push({ phase: "before-callback", observedAtUtc: new Date().toISOString(), ...observation });
      expect(observation).toMatchObject({ R: false, ciphertext: true });
    }
    const callbackAt = Date.now() + 3000;
    const windowEnd = callbackAt + 3000;
    const callbacks = await Promise.all(
      arms.map(({ worker }, index) =>
        worker.evaluate(
          async ({ callbackAt, windowEnd, clearDeadline }) => {
            const deadlineName = "connector-retention-deadline";
            const windowName = "synthetic-retention-control-window-7922";
            let deadlineCallbacks = 0;
            const window = new Promise<void>((resolve) => {
              const listener = (alarm: chrome.alarms.Alarm) => {
                if (alarm.name === deadlineName) deadlineCallbacks++;
                if (alarm.name === windowName) {
                  chrome.alarms.onAlarm.removeListener(listener);
                  resolve();
                }
              };
              chrome.alarms.onAlarm.addListener(listener);
            });
            await chrome.alarms.create(deadlineName, { when: callbackAt });
            const scheduledTime = (await chrome.alarms.get(deadlineName))?.scheduledTime;
            await chrome.alarms.create(windowName, { when: windowEnd });
            if (clearDeadline) await chrome.alarms.clear(deadlineName);
            await window;
            return { scheduledTime, deadlineCallbacks };
          },
          { callbackAt, windowEnd, clearDeadline: index === 1 },
        ),
      ),
    );
    // Neither arm schedules a replacement deadline callback after the mutation.
    const assertCleanup = (observation: Awaited<ReturnType<typeof observeRetention>>) =>
      expect(observation.ciphertext).toBe(false);
    const observations: Awaited<ReturnType<typeof observeRetention>>[] = [];
    for (const [index, { worker }] of arms.entries()) {
      const observation = await observeRetention(worker);
      phases.push({
        phase: index === 0 ? "candidate-window-end" : "cleared-deadline-window-end",
        observedAtUtc: new Date().toISOString(),
        callbackAt,
        windowEnd,
        ...callbacks[index],
        ...observation,
      });
      expect(callbacks[index]?.scheduledTime).toBe(callbackAt);
      expect(observation.R).toBe(false);
      observations.push(observation);
    }
    assertCleanup(observations[0]!);
    expect(() => assertCleanup(observations[1]!)).toThrow();
  } finally {
    const evidence = resolve(import.meta.dirname, "../../../artifacts/7922-retention");
    mkdirSync(evidence, { recursive: true });
    writeFileSync(
      resolve(evidence, "deadline-cleared.json"),
      JSON.stringify({ digest: productDigest(), phases }, null, 2),
    );
    await Promise.all(arms.map(({ context }) => context.close()));
  }
});

test("extension-raw-store-mixed-version Chromium preserves newer state; deleteDatabase mutant destroys the witness", async () => {
  const { context, worker } = await launchRetention();
  try {
    const time = await prepareRetention(worker);
    await clockAt(worker, time.before);
    await worker.evaluate(async () => {
      const currentVersion = (await indexedDB.databases()).find((db) => db.name === "connector-raw-exports")?.version;
      if (!currentVersion) throw new Error("fixture-database-missing");
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("connector-raw-exports", currentVersion + 1);
        request.onupgradeneeded = () => {
          request.result
            .createObjectStore("pending-operations", { keyPath: "id" })
            .add({ id: "pending", marker: "SYNTHETIC_EXTERNAL_EFFECT_7922", reconciled: false });
        };
        request.onsuccess = () => {
          request.result.close();
          resolve();
        };
        request.onerror = () => reject(new Error("fixture-upgrade-failed"));
      });
    });
    const before = await observeRetention(worker);
    expect(before).toMatchObject({
      P: true,
      K: true,
      R: false,
      ciphertext: true,
      state: { state: "upgrade-required" },
    });
    for (const entry of ["boot", "unpair", "retention", "cleanup"] as const) {
      await worker.evaluate(async (event) => {
        const product = globalThis.__retentionProduct;
        if (event === "boot") await product.background.boot();
        else if (event === "unpair") await product.retentionStore.run({ reason: "unpair", deleteAll: true });
        else await product.retentionStore.run({ reason: "retention", deleteAll: event === "cleanup" });
      }, entry);
      expect(await observeRetention(worker)).toEqual(before);
    }
    const evidence = resolve(import.meta.dirname, "../../../artifacts/7922-retention");
    mkdirSync(evidence, { recursive: true });
    writeFileSync(
      resolve(evidence, "newer-owner.json"),
      JSON.stringify(
        {
          scenario: "f-older-client-newer-database",
          mechanism: "real Chromium next-version fixture; unchanged product module through static-import observer",
          chromium: await chromiumVersion(context),
          digest: productDigest(),
          phases: { before, afterCallbacks: await observeRetention(worker) },
          observationScope: "Native recovery from IndexedDB/session only; no V8/OS heap absence claim.",
        },
        null,
        2,
      ),
    );
    const witness = () =>
      worker.evaluate(async () => {
        const databases = await indexedDB.databases();
        if (!databases.some((db) => db.name === "connector-raw-exports")) return false;
        return new Promise<boolean>((resolve, reject) => {
          const request = indexedDB.open("connector-raw-exports");
          request.onsuccess = () => {
            const db = request.result;
            const row = db.transaction("pending-operations").objectStore("pending-operations").get("pending");
            row.onsuccess = () => {
              db.close();
              resolve(row.result?.marker === "SYNTHETIC_EXTERNAL_EFFECT_7922" && row.result?.reconciled === false);
            };
            row.onerror = () => {
              db.close();
              reject(new Error("witness-read-failed"));
            };
          };
        });
      });
    expect(await witness()).toBe(true);
    await worker.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const request = indexedDB.deleteDatabase("connector-raw-exports");
          request.onsuccess = () => resolve();
          request.onerror = () => reject(new Error("mutant-failed-to-execute"));
        }),
    );
    const mutantWitness = await witness();
    expect(() => expect(mutantWitness).toBe(true)).toThrow();
    expect(mutantWitness).toBe(false);
  } finally {
    await context.close();
  }
});

test("extension-raw-file-retention-chromium worker-only restart retains keys then sweep refuses expired use", async () => {
  const { context, worker } = await launchRetention();
  try {
    const time = await prepareRetention(worker);
    const session = await context.newCDPSession(context.pages()[0]!);
    let versionId: string | undefined;
    let runningStatus: string | undefined;
    session.on("ServiceWorker.workerVersionUpdated", ({ versions }) => {
      const version = versions.find((candidate) => candidate.scriptURL === worker.url());
      if (version) {
        versionId = version.versionId;
        runningStatus = version.runningStatus;
      }
    });
    await test.step("identify the exact native service-worker version", async () => {
      await session.send("ServiceWorker.enable");
      await expect.poll(() => versionId).toBeTruthy();
    });
    await worker.evaluate(() => {
      Object.defineProperty(globalThis, "__retentionWorkerLifetime", { value: "SYNTHETIC_WORKER_LIFETIME_7922" });
    });
    await worker.evaluate(() => chrome.alarms.create("connector-retention-deadline", { delayInMinutes: 0.05 }));
    await test.step("terminate that worker without closing Chrome or clearing session", async () => {
      await session.send("ServiceWorker.stopWorker", { versionId: versionId! });
      await expect.poll(() => runningStatus).toBe("stopped");
    });
    await test.step("observe a fresh execution context at the real alarm wake", async () => {
      await expect.poll(() => runningStatus).toBe("running");
      // Chromium retains the DevTools worker target across an execution-context restart.
      // Native stopped/running plus loss of a memory-only sentinel proves the boundary.
      expect(await worker.evaluate(() => Reflect.get(globalThis, "__retentionWorkerLifetime"))).toBeUndefined();
    });
    await bootRetention(worker);
    expect(await observeRetention(worker)).toMatchObject({ P: true, K: true, R: true });
    await clockAt(worker, time.deadline);
    await retentionCallback(worker);
    expect(await observeRetention(worker)).toMatchObject({ P: false, K: false, R: false });
    await session.detach();
  } finally {
    await context.close();
  }
});
