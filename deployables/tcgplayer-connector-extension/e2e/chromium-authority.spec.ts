/// <reference types="chrome" />
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, test, type BrowserContext, type Worker } from "@playwright/test";
import { build } from "vite";
import { TCGPLAYER_CONNECTOR_EXTENSION_ID, TCGPLAYER_CONNECTOR_REDIRECT_URI } from "@chase-sets/channels/client";
import { buildConnectorManifest } from "@chase-sets/channels";
import { closedErrors, loopbackPlatform, synthetic } from "./loopback-platform";
import { scanRetainedArtifacts } from "./retained-artifacts";

const packageRoot = resolve(import.meta.dirname, "..");
const dist = resolve(packageRoot, "dist");
let platform: Awaited<ReturnType<typeof loopbackPlatform>>;
let firstBuild: Record<string, string>;
const active: BrowserContext[] = [];
test.beforeAll(async () => {
  platform = await loopbackPlatform();
  process.env.VITE_PLATFORM_API_URL = platform.origin;
  process.env.VITE_CONNECTOR_CLIENT_ID = synthetic.clientId;
  const snapshot = () =>
    Object.fromEntries(
      readdirSync(dist)
        .sort()
        .map((file) => [file, readFileSync(join(dist, file), "base64")]),
    );
  await build({ root: packageRoot, configFile: resolve(packageRoot, "vite.config.ts"), logLevel: "warn" });
  firstBuild = snapshot();
  await build({ root: packageRoot, configFile: resolve(packageRoot, "vite.config.ts"), logLevel: "warn" });
  expect(snapshot()).toEqual(firstBuild);
});
test.afterEach(async () => {
  for (const context of active.splice(0)) await context.close();
});
test.afterAll(async () => {
  await platform?.close();
});

async function launch(extensionRoot = dist) {
  const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "connector-product-")), {
    channel: "chromium",
    headless: false,
    args: [
      `--disable-extensions-except=${extensionRoot}`,
      `--load-extension=${extensionRoot}`,
      "--enable-unsafe-extension-debugging",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    ],
  });
  active.push(context);
  const worker =
    context.serviceWorkers().find((candidate) => candidate.url().endsWith("/background.js")) ??
    (await context.waitForEvent("serviceworker", {
      predicate: (candidate) => candidate.url().endsWith("/background.js"),
    }));
  await expect.poll(() => worker.evaluate(() => chrome.action.getTitle({}))).toBe("unpaired");
  // Secret setup is outside tracing and uses the context cookie store, never traced requests.
  await context.addCookies([
    { name: synthetic.cookieName, value: synthetic.cookieValue, url: platform.origin, httpOnly: true, sameSite: "Lax" },
  ]);
  const page = context.pages()[0]!;
  await page.goto("data:text/html,<title>Connector action target</title>");
  await page.bringToFront();
  return { context, worker, page };
}

async function click(context: BrowserContext, pageUrl: string) {
  const cdp = await context.browser()!.newBrowserCDPSession();
  try {
    const targets = (await cdp.send("Target.getTargets", { filter: [{ type: "tab" }, { exclude: true }] })).targetInfos;
    const target = targets.find((candidate) => candidate.url === pageUrl);
    if (!target) throw new Error("action-target-missing");
    await cdp.send("Extensions.triggerAction", { id: TCGPLAYER_CONNECTOR_EXTENSION_ID, targetId: target.targetId });
  } finally {
    await cdp.detach();
  }
}

async function counters(worker: Worker) {
  return worker.evaluate(() => {
    const root = globalThis as typeof globalThis & {
      connectorCounts?: { writes: number; alarms: number; identity: number; transport: number };
    };
    if (!root.connectorCounts) {
      const counts = { writes: 0, alarms: 0, identity: 0, transport: 0 };
      root.connectorCounts = counts;
      for (const area of [chrome.storage.local, chrome.storage.session]) {
        for (const key of ["set", "remove"] as const) {
          const original = area[key].bind(area);
          Object.assign(area, {
            [key]: (...args: Parameters<typeof original>) => {
              counts.writes++;
              return Reflect.apply(original, area, args);
            },
          });
        }
      }
      for (const key of ["create", "clear"] as const) {
        const original = chrome.alarms[key].bind(chrome.alarms);
        Object.assign(chrome.alarms, {
          [key]: (...args: unknown[]) => {
            counts.alarms++;
            return Reflect.apply(original, chrome.alarms, args);
          },
        });
      }
      const identity = chrome.identity.launchWebAuthFlow.bind(chrome.identity);
      chrome.identity.launchWebAuthFlow = ((...args: Parameters<typeof identity>) => {
        counts.identity++;
        return Reflect.apply(identity, chrome.identity, args);
      }) as typeof identity;
      const transport = globalThis.fetch;
      globalThis.fetch = (...args) => {
        counts.transport++;
        return transport(...args);
      };
    }
    return root.connectorCounts;
  });
}

test("extension-deterministic-build-and-thin-root", () => {
  expect(Object.keys(firstBuild)).toEqual(["background.js", "manifest.json"]);
  const manifest = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"));
  expect(manifest).toEqual(
    buildConnectorManifest({
      platformOrigin: platform.origin,
      hostRegistry: [],
      permissionRegistry: ["identity", "storage", "alarms"],
    }),
  );
  expect(readFileSync(join(dist, "background.js"), "utf8")).not.toMatch(/\bnode:|default_popup|setPopup|<html/i);
});

test("extension-package-vitest-discovery-control", () => {
  const misplaced = resolve(packageRoot, "__tests__/extension-discovery-negative.test.ts");
  writeFileSync(misplaced, 'throw new Error("misplaced-control-discovered");\n', { flag: "wx" });
  try {
    const require = createRequire(import.meta.url);
    const list = execFileSync(
      process.execPath,
      [require.resolve("vitest/vitest.mjs"), "list", "--config", "./vitest.config.ts"],
      {
        cwd: packageRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    expect(list).toContain("tests/extension-production-bootstrap-day-after.test.ts");
    expect(list).toContain("tests/extension-deterministic-build-and-thin-root.test.ts");
    expect(list).toContain("__tests__/support/probe-record.test.ts");
    expect(list).not.toContain("extension-discovery-negative");
  } finally {
    unlinkSync(misplaced);
  }
});

test("extension-pinned-identity-chromium-probe", async () => {
  const { worker } = await launch();
  expect(new URL(worker.url()).host).toBe(TCGPLAYER_CONNECTOR_EXTENSION_ID);
  expect(await worker.evaluate(() => chrome.runtime.id)).toBe(TCGPLAYER_CONNECTOR_EXTENSION_ID);
  expect(await worker.evaluate(() => chrome.identity.getRedirectURL("ucp/oauth/callback"))).toBe(
    TCGPLAYER_CONNECTOR_REDIRECT_URI,
  );
});

test("extension-action-pairing-entry-chromium-probe", async () => {
  platform.select("hold");
  const { context, worker, page } = await launch();
  await counters(worker);
  await click(context, page.url());
  await expect.poll(() => platform.observation().authorizeCount).toBe(1);
  expect(platform.observation()).toMatchObject({ queryClosed: true, cookieArrived: true, tokenCount: 0 });
  await expect.poll(() => worker.evaluate(() => chrome.action.getTitle({}))).toBe("pairing-pending");
  const pending = await counters(worker);
  await click(context, page.url());
  expect(await counters(worker)).toEqual(pending);
  platform.release();
  await expect.poll(() => worker.evaluate(() => chrome.action.getTitle({}))).toBe("paired-idle");
  expect(platform.observation()).toEqual({
    authorizeCount: 1,
    tokenCount: 1,
    cookieArrived: true,
    queryClosed: true,
    tokenClosed: true,
  });
  expect(await worker.evaluate(() => chrome.action.getBadgeText({}))).toBe("ON");
  const before = await counters(worker);
  const pages = context.pages().length;
  await click(context, page.url());
  await expect
    .poll(
      () =>
        context.pages().filter((tab) => tab.url() === `${platform.origin}/account/channels/connection_synthetic`)
          .length,
    )
    .toBe(1);
  expect(context.pages()).toHaveLength(pages + 1);
  expect(await counters(worker)).toEqual(before);
});

for (const error of closedErrors)
  test(`extension-action-pairing-entry-chromium-probe ${error}`, async () => {
    platform.select(error);
    const { context, worker, page } = await launch();
    await click(context, page.url());
    await expect.poll(() => platform.observation().authorizeCount).toBe(1);
    await expect.poll(() => worker.evaluate(() => chrome.action.getTitle({}))).toBe("unpaired");
    expect(platform.observation()).toMatchObject({ cookieArrived: true, queryClosed: true, tokenCount: 0 });
  });

test("extension-popup-less-contract default_popup mutant prevents actual action pairing", async () => {
  platform.select("success");
  const mutant = mkdtempSync(join(tmpdir(), "connector-popup-mutant-"));
  cpSync(dist, mutant, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(mutant, "manifest.json"), "utf8"));
  manifest.action.default_popup = "popup.html";
  writeFileSync(join(mutant, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(mutant, "popup.html"), "<!doctype html><title>Controlled popup mutant</title>");
  const { context, worker, page } = await launch(mutant);
  await click(context, page.url());
  const cdp = await context.browser()!.newBrowserCDPSession();
  await expect
    .poll(async () =>
      (await cdp.send("Target.getTargets")).targetInfos.some((target) => target.url.endsWith("/popup.html")),
    )
    .toBe(true);
  await cdp.detach();
  expect(platform.observation().authorizeCount).toBe(0);
  expect(await worker.evaluate(() => chrome.action.getTitle({}))).toBe("unpaired");
  expect(() => expect(platform.observation().authorizeCount).toBe(1)).toThrow();
});

test("extension-retained-artifact-scan", async ({}, testInfo) => {
  platform.select("success");
  const { context, worker, page } = await launch();
  const output = testInfo.outputPath("retained-failure");
  mkdirSync(output, { recursive: true });
  // Keep API-call trace evidence, but never network bodies, DOM snapshots or source attachments.
  await context.tracing.start({ screenshots: false, snapshots: false, sources: false });
  await click(context, page.url());
  await expect.poll(() => worker.evaluate(() => chrome.action.getTitle({}))).toBe("paired-idle");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      expect(await page.title()).toBe("controlled-retained-failure");
    } catch (error) {
      writeFileSync(join(output, `attempt-${attempt}.txt`), String(error));
    }
  }
  await context.tracing.stop({ path: join(output, "failure.zip") });
  expect(readdirSync(output)).toContain("attempt-0.txt");
  expect(scanRetainedArtifacts(output, platform.forbidden())).toBeGreaterThan(2);
  await testInfo.attach("retained-artifact-scan", {
    body: JSON.stringify({ attempts: 2, secretsFound: false }),
    contentType: "application/json",
  });
});
