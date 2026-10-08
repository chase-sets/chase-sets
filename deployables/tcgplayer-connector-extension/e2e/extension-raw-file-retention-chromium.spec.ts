import { expect, test } from "@playwright/test";
import {
  bootRetention,
  clockAt,
  launchRetention,
  observeRetention,
  prepareRetention,
  retentionCallback,
} from "./retention-observation";

test.use({ trace: "off", screenshot: "off" });

test("extension-raw-file-retention-chromium acceptance and unpair", async () => {
  for (const reason of ["accept", "unpair"]) {
    const { context, worker } = await launchRetention();
    try {
      await prepareRetention(worker);
      await worker.evaluate(async (action) => {
        const product = (await import(chrome.runtime.getURL("background.js"))) as typeof import("../src/background");
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
  const { context, worker } = await launchRetention();
  try {
    const time = await prepareRetention(worker);
    await clockAt(worker, time.deadline);
    await worker.evaluate(() => chrome.alarms.clear("connector-retention-deadline"));
    const uncleared = await observeRetention(worker);
    expect(uncleared.R).toBe(false);
    expect(() => expect(uncleared.ciphertext).toBe(false)).toThrow();
    await retentionCallback(worker);
    expect((await observeRetention(worker)).ciphertext).toBe(false);
  } finally {
    await context.close();
  }
});

test("extension-raw-store-mixed-version Chromium preserves newer state; deleteDatabase mutant destroys the witness", async () => {
  const { context, worker } = await launchRetention();
  try {
    const time = await prepareRetention(worker);
    await clockAt(worker, time.before);
    await worker.evaluate(async () => {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("connector-raw-exports", 2);
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
        const product = (await import(chrome.runtime.getURL("background.js"))) as typeof import("../src/background");
        if (event === "boot") await product.background.boot();
        else if (event === "unpair") await product.retentionStore.run({ reason: "unpair", deleteAll: true });
        else await product.retentionStore.run({ reason: "retention", deleteAll: event === "cleanup" });
      }, entry);
      expect(await observeRetention(worker)).toEqual(before);
    }
    const witness = () =>
      worker.evaluate(async () => {
        const databases = await indexedDB.databases();
        if (!databases.some((db) => db.name === "connector-raw-exports")) return false;
        return new Promise<boolean>((resolve, reject) => {
          const request = indexedDB.open("connector-raw-exports", 2);
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
    session.on("ServiceWorker.workerVersionUpdated", ({ versions }) => {
      versionId = versions.find((version) => version.scriptURL === worker.url())?.versionId ?? versionId;
    });
    await session.send("ServiceWorker.enable");
    await expect.poll(() => versionId).toBeTruthy();
    await session.send("ServiceWorker.stopWorker", { versionId: versionId! });
    const next = context.waitForEvent("serviceworker");
    await session.send("ServiceWorker.startWorker", { scopeURL: worker.url().replace("background.js", "") });
    const restarted = await next;
    await bootRetention(restarted);
    expect(await observeRetention(restarted)).toMatchObject({ P: true, K: true, R: true });
    await clockAt(restarted, time.deadline);
    await retentionCallback(restarted);
    expect(await observeRetention(restarted)).toMatchObject({ P: false, K: false, R: false });
    await session.detach();
  } finally {
    await context.close();
  }
});
