/// <reference types="chrome" />

import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { chromium, expect, test, type BrowserContext, type Worker } from "@playwright/test";
import { extensionIdCandidate, extensionKeyCandidate, extensionRedirectUriCandidate } from "../src/authority-candidate";
import { SYNTHETIC_PLATFORM_URL } from "../src/probe-canary";
import {
  parseIdentityNegativeControlsRecord,
  parseIdentityProbeRecord,
  parsePopupCapabilityProbeRecord,
} from "../src/probe-records";

const packageRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(packageRoot, "../..");
const distRoot = resolve(packageRoot, "dist");
const artifactRoot = resolve(repoRoot, "artifacts/chromium-authority");
const differentPublicKey =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEApFhoONA2G33rY2UWGXzOJcnx+SwgBC99JLq+I2GKGxERrYYNEq++7Mxd/NAUTzb5mkXsyjZcVSJzEBsOWS/n3o90mZAagGlMAwUYa2qn/0MY7t1DpLt02hISSjj9mbXu2kqzy6ZXndumuMJrjIuLF0uDClL6lZ5SCwmiRMFvrTikfKtGFzJxX0t3aQM6HgUpnAPYFjyPSTI/3Md7V6sAfr51N4do2pE5ueH9PSGSV9H0Rp67nG/7igkwRaXrw6+v2V2qiSQxEBtsTLsJ5K+khbwMVosXjlMgtEEAYrbqhKwJPK4FOnNHHm9zMyhzGDoD9fh2DLnt8LTxwNa7K5g6XQIDAQAB";

type TrustedObservation = Readonly<{
  origin: string;
  storageLocalCanaryReadable: boolean;
  storageSessionCanaryReadable: boolean;
  indexedDbCanaryReadable: boolean;
  workerMessageReached: boolean;
}>;

type SandboxedObservation = Readonly<{
  origin: string;
  chromeType: string;
  storageLocalReachable: boolean;
  storageSessionReachable: boolean;
  indexedDbReachable: boolean;
  queryReceived: boolean;
  windowOpenReturnedWindow: boolean;
}>;

function listFiles(root: string, directory = root): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const absolute = join(directory, entry.name);
      return entry.isDirectory() ? listFiles(root, absolute) : [absolute];
    })
    .sort((left, right) => relative(root, left).localeCompare(relative(root, right)));
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function directorySha256(root: string): string {
  const hash = createHash("sha256");
  for (const file of listFiles(root)) {
    hash.update(relative(root, file).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function launchExtension(extensionRoot: string): Promise<{
  context: BrowserContext;
  worker: Worker;
  assignedId: string;
  chromiumVersion: string;
  externalRequests: string[];
}> {
  const userDataDir = mkdtempSync(join(tmpdir(), "chase-sets-chromium-authority-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: false,
    args: [`--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
  });
  const externalRequests: string[] = [];
  await context.route(/^https?:\/\//, async (route) => {
    externalRequests.push(route.request().url());
    await route.abort("blockedbyclient");
  });
  const worker =
    context.serviceWorkers().find((candidate) => candidate.url().endsWith("/background.js")) ??
    (await context.waitForEvent("serviceworker", {
      predicate: (candidate) => candidate.url().endsWith("/background.js"),
      timeout: 15_000,
    }));
  return {
    context,
    worker,
    assignedId: new URL(worker.url()).host,
    chromiumVersion: context.browser()!.version(),
    externalRequests,
  };
}

async function readPopupRecord<T>(page: import("@playwright/test").Page): Promise<T> {
  await page.locator("#result").waitFor({ state: "attached" });
  await expect(page.locator("#result")).not.toHaveText("pending");
  return JSON.parse((await page.locator("#result").textContent()) ?? "") as T;
}

async function openActionPopup(worker: Worker): Promise<boolean> {
  return worker
    .evaluate(async () => {
      const browserWindow = (await chrome.windows.getAll({ windowTypes: ["normal"] }))[0];
      if (browserWindow?.id === undefined) throw new Error("Chromium reported no normal extension window");
      await chrome.action.openPopup({ windowId: browserWindow.id });
      return true;
    })
    .catch(() => false);
}

async function captureTrustedPopup(
  context: BrowserContext,
  worker: Worker,
  extensionId: string,
): Promise<{
  observation: TrustedObservation;
  actionPopupOpened: boolean;
  fallbackTabNavigationUsed: boolean;
  observationMode: "actual-action-popup" | "tab-navigation-fallback";
}> {
  if (await openActionPopup(worker)) {
    await expect
      .poll(() =>
        worker.evaluate(() =>
          (
            globalThis as typeof globalThis & {
              __chaseSetsChromiumAuthorityProbe: { trustedPopupObservation(): unknown };
            }
          ).__chaseSetsChromiumAuthorityProbe.trustedPopupObservation(),
        ),
      )
      .not.toBeUndefined();
    const observation = await worker.evaluate(() =>
      (
        globalThis as typeof globalThis & {
          __chaseSetsChromiumAuthorityProbe: { trustedPopupObservation(): unknown };
        }
      ).__chaseSetsChromiumAuthorityProbe.trustedPopupObservation(),
    );
    await context.pages()[0]?.bringToFront();
    return {
      observation: observation as TrustedObservation,
      actionPopupOpened: true,
      fallbackTabNavigationUsed: false,
      observationMode: "actual-action-popup",
    };
  }
  const fallbackPage = await context.newPage();
  await fallbackPage.goto(`chrome-extension://${extensionId}/popup.html`);
  return {
    observation: await readPopupRecord<TrustedObservation>(fallbackPage),
    actionPopupOpened: false,
    fallbackTabNavigationUsed: true,
    observationMode: "tab-navigation-fallback",
  };
}

async function captureSandboxedPopup(
  context: BrowserContext,
  worker: Worker,
  extensionId: string,
  popupPath: string,
  externalRequests: string[],
): Promise<{
  observation: SandboxedObservation;
  actionPopupOpened: boolean;
  fallbackTabNavigationUsed: boolean;
  observationMode: "actual-action-popup" | "tab-navigation-fallback";
}> {
  const requestsBefore = externalRequests.length;
  if (await openActionPopup(worker)) {
    await expect
      .poll(() => externalRequests.slice(requestsBefore).find((url) => url.startsWith(`${SYNTHETIC_PLATFORM_URL}?`)))
      .toBeTruthy();
    const reportUrl = externalRequests
      .slice(requestsBefore)
      .find((url) => url.startsWith(`${SYNTHETIC_PLATFORM_URL}?`))!;
    const observation = JSON.parse(new URL(reportUrl).searchParams.get("observation") ?? "") as SandboxedObservation;
    await context.pages()[0]?.bringToFront();
    return {
      observation,
      actionPopupOpened: true,
      fallbackTabNavigationUsed: false,
      observationMode: "actual-action-popup",
    };
  }
  const fallbackPage = await context.newPage();
  await fallbackPage.goto(`chrome-extension://${extensionId}/${popupPath}`);
  return {
    observation: await readPopupRecord<SandboxedObservation>(fallbackPage),
    actionPopupOpened: false,
    fallbackTabNavigationUsed: true,
    observationMode: "tab-navigation-fallback",
  };
}

function writeJson(name: string, value: unknown): void {
  mkdirSync(artifactRoot, { recursive: true });
  writeFileSync(resolve(artifactRoot, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("extension-pinned-identity-chromium-probe", async () => {
  const baseDistSha256 = directorySha256(distRoot);
  const publicKeySha256 = sha256(Buffer.from(extensionKeyCandidate, "base64"));
  const baseline = await launchExtension(distRoot);
  const redirectUri = await baseline.worker.evaluate(() => chrome.identity.getRedirectURL("ucp/oauth/callback"));
  const identity = parseIdentityProbeRecord({
    schemaVersion: 1,
    publicKeySha256,
    distSha256: baseDistSha256,
    chromiumVersion: baseline.chromiumVersion,
    assignedId: baseline.assignedId,
    redirectUri,
    capturedAt: new Date().toISOString(),
  });
  writeJson("extension-pinned-identity-chromium-probe.json", identity);
  await baseline.context.close();

  const mutantRoot = mkdtempSync(join(tmpdir(), "chase-sets-chromium-authority-mutants-"));
  const keyRemovedRoot = resolve(mutantRoot, "key-removed");
  const differentKeyRoot = resolve(mutantRoot, "different-key");
  cpSync(distRoot, keyRemovedRoot, { recursive: true });
  cpSync(distRoot, differentKeyRoot, { recursive: true });
  const baselineManifest = JSON.parse(readFileSync(resolve(distRoot, "manifest.json"), "utf8")) as Record<
    string,
    unknown
  >;
  const { key: _removedKey, ...keyRemovedManifest } = baselineManifest;
  writeFileSync(resolve(keyRemovedRoot, "manifest.json"), `${JSON.stringify(keyRemovedManifest, null, 2)}\n`, "utf8");
  writeFileSync(
    resolve(differentKeyRoot, "manifest.json"),
    `${JSON.stringify({ ...baselineManifest, key: differentPublicKey }, null, 2)}\n`,
    "utf8",
  );

  const keyRemoved = await launchExtension(keyRemovedRoot);
  await keyRemoved.context.close();
  const differentKey = await launchExtension(differentKeyRoot);
  await differentKey.context.close();
  const controls = parseIdentityNegativeControlsRecord({
    schemaVersion: 1,
    baseline: { assignedId: identity.assignedId, distSha256: identity.distSha256 },
    keyRemoved: { assignedId: keyRemoved.assignedId, distSha256: directorySha256(keyRemovedRoot) },
    differentKey: { assignedId: differentKey.assignedId, distSha256: directorySha256(differentKeyRoot) },
    mutationContract: "only manifest.key varied; key-removed omits it and different-key replaces it",
    capturedAt: new Date().toISOString(),
  });
  writeJson("extension-pinned-identity-negative-controls.json", controls);

  const identityArtifacts = [identity, controls].map((value) => JSON.stringify(value)).join("\n");
  expect(identityArtifacts).not.toMatch(/PRIVATE KEY|privateKey|BEGIN (?:RSA )?PRIVATE KEY/);

  expect(keyRemoved.assignedId).not.toBe(identity.assignedId);
  expect(differentKey.assignedId).not.toBe(identity.assignedId);
  expect(differentKey.assignedId).not.toBe(keyRemoved.assignedId);
  expect(identity.assignedId).toBe(extensionIdCandidate);
  expect(identity.redirectUri).toBe(extensionRedirectUriCandidate);
});

test("extension-popup-capability-chromium-probe", async () => {
  const distSha256 = directorySha256(distRoot);
  const publicKeySha256 = sha256(Buffer.from(extensionKeyCandidate, "base64"));
  const launched = await launchExtension(distRoot);
  const firstPage = launched.context.pages()[0];
  if (firstPage) await firstPage.bringToFront();
  await launched.worker.evaluate(async () => {
    const probe = (
      globalThis as typeof globalThis & {
        __chaseSetsChromiumAuthorityProbe: { prepare(): Promise<void> };
      }
    ).__chaseSetsChromiumAuthorityProbe;
    await probe.prepare();
    await chrome.action.setPopup({ popup: "popup.html" });
  });

  const trusted = await captureTrustedPopup(launched.context, launched.worker, launched.assignedId);
  await launched.context.pages()[0]?.waitForTimeout(250);
  const status = encodeURIComponent(JSON.stringify({ schemaVersion: 1, state: "synthetic-status" }));
  const sandboxedPath = `popup-sandboxed.html?status=${status}`;
  const setPopupSucceeded = await launched.worker
    .evaluate(async (popup) => {
      await chrome.action.setPopup({ popup });
      return true;
    }, sandboxedPath)
    .catch(() => false);
  const sandboxed = await captureSandboxedPopup(
    launched.context,
    launched.worker,
    launched.assignedId,
    sandboxedPath,
    launched.externalRequests,
  );

  const popupLessAction = await launched.worker.evaluate(async () => {
    await chrome.action.setPopup({ popup: "" });
    const popupCleared = (await chrome.action.getPopup({})) === "";
    const probe = (
      globalThis as typeof globalThis & {
        __chaseSetsChromiumAuthorityProbe: { actionClickCount(): number };
      }
    ).__chaseSetsChromiumAuthorityProbe;
    const before = probe.actionClickCount();
    let openPopupRejected = false;
    try {
      const browserWindow = (await chrome.windows.getAll({ windowTypes: ["normal"] }))[0];
      if (browserWindow?.id === undefined) throw new Error("Chromium reported no normal extension window");
      await chrome.action.openPopup({ windowId: browserWindow.id });
    } catch {
      openPopupRejected = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    let badgeTextSucceeded = false;
    let titleSucceeded = false;
    try {
      await chrome.action.setBadgeText({ text: "P" });
      badgeTextSucceeded = true;
    } catch {
      // Chromium's refusal is the measured capability.
    }
    try {
      await chrome.action.setTitle({ title: "Synthetic Chromium authority probe" });
      titleSucceeded = true;
    } catch {
      // Chromium's refusal is the measured capability.
    }
    return {
      popupCleared,
      openPopupAttempted: true,
      openPopupRejected,
      onClickedFired: probe.actionClickCount() > before,
      badgeTextSucceeded,
      titleSucceeded,
    };
  });

  const capability = parsePopupCapabilityProbeRecord({
    schemaVersion: 1,
    publicKeySha256,
    distSha256,
    chromiumVersion: launched.chromiumVersion,
    capturedAt: new Date().toISOString(),
    platformOrigin: new URL(SYNTHETIC_PLATFORM_URL).origin,
    trustedPopup: {
      actionPopupOpened: trusted.actionPopupOpened,
      observationMode: trusted.observationMode,
      fallbackTabNavigationUsed: trusted.fallbackTabNavigationUsed,
      ...trusted.observation,
    },
    sandboxedPopup: {
      setPopupSucceeded,
      actionPopupOpened: sandboxed.actionPopupOpened,
      observationMode: sandboxed.observationMode,
      fallbackTabNavigationUsed: sandboxed.fallbackTabNavigationUsed,
      ...sandboxed.observation,
    },
    popupLessAction,
  });
  writeJson("extension-popup-capability-chromium-probe.json", capability);

  expect(launched.externalRequests.every((url) => url.startsWith(`${SYNTHETIC_PLATFORM_URL}?observation=`))).toBe(true);
  expect(capability.trustedPopup.storageLocalCanaryReadable).toBe(true);
  expect(capability.trustedPopup.storageSessionCanaryReadable).toBe(true);
  expect(capability.trustedPopup.indexedDbCanaryReadable).toBe(true);
  expect(capability.trustedPopup.workerMessageReached).toBe(true);
  expect(capability.trustedPopup.actionPopupOpened).toBe(true);
  expect(capability.sandboxedPopup.queryReceived).toBe(true);
  expect(capability.sandboxedPopup.setPopupSucceeded).toBe(true);

  const distText = listFiles(distRoot)
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  expect(distText).not.toMatch(/PRIVATE KEY|privateKey|BEGIN (?:RSA )?PRIVATE KEY/);
  expect(JSON.parse(readFileSync(resolve(distRoot, "manifest.json"), "utf8"))).not.toHaveProperty("host_permissions");
  await launched.context.close();
});
