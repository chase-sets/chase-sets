/// <reference types="chrome" />
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, type BrowserContext, type Worker } from "@playwright/test";

type Product = typeof import("../src/background");
export const retentionDist = resolve(import.meta.dirname, "../dist");
export const productDigest = () =>
  createHash("sha256")
    .update(readFileSync(join(retentionDist, "background.js")))
    .digest("hex");
export async function launchRetention(profile = mkdtempSync(join(tmpdir(), "connector-retention-"))) {
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: false,
    args: [
      `--disable-extensions-except=${retentionDist}`,
      `--load-extension=${retentionDist}`,
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    ],
  });
  const worker =
    context.serviceWorkers().find((item) => item.url().endsWith("/background.js")) ??
    (await context.waitForEvent("serviceworker"));
  await worker.evaluate(async () => {
    const product = (await import(chrome.runtime.getURL("background.js"))) as Product;
    await product.boot;
  });
  return { context, worker, profile };
}

export async function prepareRetention(worker: Worker) {
  return worker.evaluate(async () => {
    const product = (await import(chrome.runtime.getURL("background.js"))) as Product;
    const now = Date.now();
    const state = "paired-idle";
    await chrome.storage.local.set({
      "channel-connector-profile": {
        schemaVersion: 1,
        revision: 7,
        state,
        connectionId: "connection_A",
        servedPollWindowSeconds: 60,
        pauseReason: null,
      },
      "channel-connector-credential": {
        schemaVersion: 1,
        issuer: "https://platform.example",
        clientId: "cc_client_synthetic",
        connectionId: "connection_A",
        accessToken: "cc_at_SYNTHETIC_RETENTION_TOKEN",
        refreshToken: "cc_rt_SYNTHETIC_RETENTION_TOKEN",
        accessExpiresAt: "2099-01-01T00:00:00.000Z",
        rotatedAt: new Date(now).toISOString(),
        boundProfileRevision: 7,
        boundProfileState: state,
      },
    });
    await product.retentionStore.write({
      rawExportId: "synthetic_raw",
      connectionId: "connection_A",
      downloadedAt: new Date(now).toISOString(),
      bytes: new TextEncoder().encode("SYNTHETIC_RETENTION_RAW_7922"),
      maxBytes: 100,
    });
    return { before: now, deadline: now + 86400000 };
  });
}

export async function clockAt(worker: Worker, now: number) {
  await worker.evaluate((value) => {
    Date.now = () => value;
  }, now);
}

export async function observeRetention(worker: Worker) {
  return worker.evaluate(async () => {
    const product = (await import(chrome.runtime.getURL("background.js"))) as Product;
    const rows = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      const request = indexedDB.open("connector-raw-exports");
      request.onerror = () => reject(new Error("observation-open-failed"));
      request.onsuccess = () => {
        const db = request.result;
        const read = db.transaction("raw-exports").objectStore("raw-exports").getAll();
        read.onsuccess = () => {
          db.close();
          resolve(read.result as Record<string, unknown>[]);
        };
        read.onerror = () => {
          db.close();
          reject(new Error("observation-read-failed"));
        };
      };
    });
    const allSession = await chrome.storage.session.get(null);
    let materiallyObtainableKey = Object.entries(allSession).some(
      ([name, value]) => name.startsWith("connector-raw-key:") && Array.isArray(value) && value.length === 32,
    );
    let recoverablePlaintext = false;
    for (const row of rows) {
      const bytes = (await chrome.storage.session.get(row.keyId as string))[row.keyId as string];
      if (!Array.isArray(bytes) || bytes.length !== 32) continue;
      materiallyObtainableKey = true;
      try {
        const key = await crypto.subtle.importKey("raw", new Uint8Array(bytes), "AES-GCM", false, ["decrypt"]);
        const aad = new TextEncoder().encode(
          JSON.stringify([
            row.schemaVersion,
            row.rawExportId,
            row.connectionId,
            row.downloadedAt,
            row.expiresAt,
            row.digest,
            row.byteLength,
            row.acceptedSnapshotAt,
            row.revision,
            row.keyId,
          ]),
        );
        const raw = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: row.nonce as Uint8Array<ArrayBuffer>, additionalData: aad },
          key,
          row.ciphertext as ArrayBuffer,
        );
        recoverablePlaintext ||= new TextDecoder().decode(raw) === "SYNTHETIC_RETENTION_RAW_7922";
      } catch {
        /* P is observed recoverability, not inferred from key presence. */
      }
    }
    let readAllowed = false;
    try {
      readAllowed = (await product.retentionStore.read("synthetic_raw")).length > 0;
    } catch {
      /* refusal */
    }
    return {
      at: new Date(Date.now()).toISOString(),
      P: recoverablePlaintext,
      K: materiallyObtainableKey,
      R: readAllowed,
      ciphertext: rows.some((row) => row.ciphertext instanceof ArrayBuffer),
      state: await product.background.status(),
    };
  });
}

export async function retentionCallback(worker: Worker) {
  // Exercise a real Chrome alarm callback, using Chrome's real clock rather than the controlled application clock.
  await worker.evaluate(() => chrome.alarms.create("connector-retention-deadline", { delayInMinutes: 0.001 }));
  await expect.poll(async () => (await observeRetention(worker)).ciphertext).toBe(false);
}

export async function bootRetention(worker: Worker) {
  await worker.evaluate(async () => {
    const product = (await import(chrome.runtime.getURL("background.js"))) as Product;
    await product.background.boot();
  });
}

export async function chromiumVersion(context: BrowserContext) {
  const session = await context.newCDPSession(context.pages()[0]!);
  const version = await session.send("Browser.getVersion");
  await session.detach();
  return version.product;
}
