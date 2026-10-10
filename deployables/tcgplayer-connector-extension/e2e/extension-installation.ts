import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type BrowserContext, type Worker } from "@playwright/test";
import type { Plugin } from "vite";
import { fixtureWorker, launchFixture } from "../__tests__/support/browser-observation";

export type BundleIdentity = { sourceSha256: string; transform: string };
declare global {
  var __connectorExecutedBundle: BundleIdentity | undefined;
  var __connectorHistoricalReasons: string[] | undefined;
}

export const bundleIdentity = (source: string | Buffer, transform: string): BundleIdentity => ({
  sourceSha256: createHash("sha256").update(source).digest("hex"),
  transform,
});

// The marker is emitted with the compiled bytes, not read back from the installed
// directory at runtime. A stale worker therefore reports the old identity.
export function executionIdentityPlugin(transform: string): Plugin {
  return {
    name: "synthetic-executed-bundle-identity",
    generateBundle(_options, bundle) {
      const entry = bundle["background.js"];
      if (entry?.type !== "chunk") throw new Error("background-bundle-missing");
      const identity = bundleIdentity(entry.code, transform);
      entry.code += `\nReflect.set(globalThis, "__connectorExecutedBundle", ${JSON.stringify(identity)});\n`;
      this.emitFile({ type: "asset", fileName: "execution-identity.json", source: JSON.stringify(identity) });
    },
  };
}

const openProfiles = new Set<string>();
export async function launchInstallation(
  source: string,
  profile = mkdtempSync(join(tmpdir(), "connector-7940-")),
  debug = true,
) {
  if (openProfiles.has(profile)) throw new Error("extension-installation-context-still-open");
  const directory = join(profile, "extension-under-test");
  mkdirSync(directory, { recursive: true });
  for (const name of ["background.js", "manifest.json", "execution-identity.json", "seed.js"])
    if (existsSync(join(source, name))) cpSync(join(source, name), join(directory, name));
  const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8"));
  const identity: BundleIdentity = JSON.parse(readFileSync(join(source, "execution-identity.json"), "utf8"));
  openProfiles.add(profile);
  try {
    const context = await launchFixture(directory, profile, [
      `--disable-extensions-except=${directory}`,
      ...(debug ? ["--enable-unsafe-extension-debugging"] : []),
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    ]);
    context.on("close", () => openProfiles.delete(profile));
    return { context, profile, directory, manifest, identity };
  } catch (error) {
    openProfiles.delete(profile);
    throw error;
  }
}

export async function executedIdentity(worker: Worker) {
  return worker.evaluate(() => ({
    workerUrl: globalThis.location.href,
    manifest: chrome.runtime.getManifest(),
    bundle: globalThis.__connectorExecutedBundle ?? null,
    installReasons:
      globalThis.__connectorHistoricalReasons ?? globalThis.__connectorHarness?.observation.snapshot().reasons ?? [],
  }));
}

export async function attestInstallation(installation: Awaited<ReturnType<typeof launchInstallation>>) {
  expect(installation.context.browser()!.version()).toBe("148.0.7778.96");
  const worker = await fixtureWorker(installation.context, `/${installation.manifest.background.service_worker}`);
  const executed = await executedIdentity(worker);
  expect(executed.workerUrl).toBe(worker.url());
  expect(executed.manifest).toEqual(installation.manifest);
  expect(executed.bundle).toEqual(installation.identity);
  return worker;
}

export async function installationDiagnostics(context: BrowserContext) {
  return Promise.all(
    context.serviceWorkers().map(async (worker) => {
      try {
        return await worker.evaluate(async () => {
          const identity = {
            workerUrl: globalThis.location.href,
            manifest: chrome.runtime.getManifest(),
            bundle: globalThis.__connectorExecutedBundle ?? null,
            installReasons:
              globalThis.__connectorHistoricalReasons ??
              globalThis.__connectorHarness?.observation.snapshot().reasons ??
              [],
          };
          const databases = await indexedDB.databases();
          if (!databases.some((db) => db.name === "connector-raw-exports")) return { identity, journal: null };
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open("connector-raw-exports");
            request.onupgradeneeded = () => request.transaction!.abort();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
            request.onblocked = () => reject(new Error("diagnostic-journal-blocked"));
          });
          try {
            const rows = async (name: string) =>
              db.objectStoreNames.contains(name)
                ? new Promise<unknown[]>((resolve, reject) => {
                    const request = db.transaction(name).objectStore(name).getAll();
                    request.onsuccess = () => resolve(request.result);
                    request.onerror = () => reject(request.error);
                  })
                : [];
            return {
              identity,
              journal: {
                version: db.version,
                stores: Array.from(db.objectStoreNames),
                members: await rows("operation-attempts"),
                reservations: await rows("reservations"),
              },
            };
          } finally {
            db.close();
          }
        });
      } catch (error) {
        return { workerUrl: worker.url(), error: String(error) };
      }
    }),
  );
}
