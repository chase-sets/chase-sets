/// <reference types="chrome" />

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, test } from "@playwright/test";
import { build } from "vite";
import { operatorExtensionId } from "../../src/manifest-contract";
import { syntheticTarget } from "./synthetic-cdp";
import {
  operatorEvidenceIdentity,
  operatorFileInventory,
} from "../../../../scripts/prepare-operator-extension-evidence.mjs";

const root = resolve(import.meta.dirname, "../..");
const dist = resolve(root, "dist");
const evidence = resolve(root, "../../artifacts/operator-extension");
const identity = operatorEvidenceIdentity(resolve(root, "../.."));

test("operator-extension-deterministic-build @tcgplayer-operator-extension", async () => {
  const first = operatorFileInventory(dist);
  await build({ root, configFile: resolve(root, "vite.config.ts"), logLevel: "error" });
  const second = operatorFileInventory(dist);
  expect(second).toEqual(first);
  expect({ ...second, "unlisted.js": "unexpected" }).not.toEqual(first);
  mkdirSync(evidence, { recursive: true });
  writeFileSync(
    join(evidence, "handoff.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        identity,
        extensionId: operatorExtensionId,
        version: "0.1.0",
        twoBuildsIdentical: true,
        files: second,
      },
      null,
      2,
    ) + "\n",
  );
});

test("operator-extension-chromium: opaque UI, exact-host cookies and retained reload @tcgplayer-operator-extension", async () => {
  const stages: string[] = [];
  function stage(name: string) {
    console.log(`Operator Chromium stage: ${name}`);
    stages.push(name);
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, "chromium-stages.json"), JSON.stringify({ identity, stages }));
  }
  stage("launch");
  const profile = mkdtempSync(join(tmpdir(), "synthetic-operator-extension-"));
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: false,
    args: [
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
      "--enable-unsafe-extension-debugging",
      "--remote-debugging-port=0",
      "--host-resolver-rules=MAP * ~NOTFOUND",
    ],
  });
  await context.route(/^https?:\/\//, (route) => route.abort("blockedbyclient"));
  stage("launched");
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    stage("worker");
    expect(new URL(worker.url()).host).toBe(operatorExtensionId);
    // Direct loopback CDP setup is outside Playwright recording. Only synthetic values enter this profile.
    const port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split(/\r?\n/)[0];
    if (!port || !/^\d+$/.test(port)) throw new Error("Synthetic debug port missing");
    const cookieTarget = await syntheticTarget(port, worker.url());
    async function setup(expression: string) {
      await cookieTarget.evaluate(expression);
    }
    const cookieMarker = ["SYNTHETIC", "OPERATOR", "COOKIE", "CHROMIUM"].join("_");
    stage("setup-connected");
    const grantMarker = "A".repeat(43);
    const key = "catalog.operator-session.staging";
    for (const domain of [undefined, ".tcgplayer.com"]) {
      for (const path of ["/", "/admin", "/inapplicable"]) {
        await setup(`(async () => {
          await chrome.cookies.set(${JSON.stringify({ url: "https://store.tcgplayer.com" + (path === "/" ? "/" : path + "/pricing"), name: "TCGAuthTicket_Production", value: cookieMarker, path, ...(domain ? { domain } : {}) })});
          const cookie = await chrome.cookies.get({url:"https://store.tcgplayer.com/admin/pricing",name:"TCGAuthTicket_Production",storeId:"0"});
          if (${path === "/inapplicable" ? "cookie !== null" : `cookie?.value !== ${JSON.stringify(cookieMarker)}`}) throw Error("applicability");
          await chrome.cookies.remove({url:${JSON.stringify("https://store.tcgplayer.com" + (path === "/" ? "/" : path + "/pricing"))},name:"TCGAuthTicket_Production",storeId:"0"});
        })()`);
      }
    }
    cookieTarget.close();
    stage("cookies-proved");
    async function openPopup(current: typeof worker, unknownVersion = false) {
      await current.evaluate(async () => {
        const window = (await chrome.windows.getAll({ windowTypes: ["normal"] }))[0];
        if (window?.id === undefined) throw new Error("Synthetic browser window missing");
        await chrome.action.openPopup({ windowId: window.id });
      });
      if (unknownVersion) stage("unknown-popup-opened");
      const popup = await syntheticTarget(port, `chrome-extension://${operatorExtensionId}/popup.html`);
      if (unknownVersion) stage("unknown-popup-attached");
      await expect.poll(() => popup.sandboxContext()).toBeDefined();
      const frame = await popup.sandboxContext();
      if (frame === undefined) throw new Error("Synthetic sandbox context missing");
      if (unknownVersion) stage("unknown-sandbox-ready");
      return {
        evaluate: (expression: string) => popup.evaluate(expression, frame),
        async close() {
          await context.pages()[0]?.bringToFront();
          popup.close();
        },
      };
    }
    const popup = await openPopup(worker);
    stage("popup-open");
    await expect
      .poll(() => popup.evaluate('document.querySelector("h1")?.textContent'))
      .toBe("TCGplayer Operator Extension");
    await expect
      .poll(() =>
        popup.evaluate(
          'document.querySelector("h1")?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })',
        ),
      )
      .toBe(true);
    await expect
      .poll(() => popup.evaluate('document.querySelector("[role=status]")?.textContent'))
      .toContain("Not paired");
    await popup.evaluate(`(() => {
      const input = document.querySelector('input[type=password]');
      if (!input || !document.querySelector('label[for="' + input.id + '"]')?.textContent.includes('Pairing grant')) throw Error('Synthetic input missing');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(grantMarker)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await expect
      .poll(() =>
        popup.evaluate(
          "Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Pair')?.disabled",
        ),
      )
      .toBe(false);
    await popup.evaluate(
      "Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Pair').click()",
    );
    await expect.poll(() => popup.evaluate('document.querySelector("input[type=password]")?.value === ""')).toBe(true);
    await expect
      .poll(() => popup.evaluate('document.querySelector("[role=status]")?.textContent'))
      .toContain("Paired.");
    stage("paired");
    expect(await popup.evaluate('typeof chrome === "undefined" || (!chrome.storage && !chrome.cookies)')).toBe(true);
    expect(
      await popup.evaluate("(() => { try { void parent.document; return false; } catch { return true; } })()"),
    ).toBe(true);
    await popup.close();
    stage("isolated");
    const compatibleWorker = context.waitForEvent("serviceworker");
    await worker.evaluate(() => {
      setTimeout(() => chrome.runtime.reload(), 0);
    });
    const compatible = await compatibleWorker;
    stage("compatible-reloaded");
    const retainedPopup = await openPopup(compatible);
    await expect
      .poll(() => retainedPopup.evaluate('document.querySelector("[role=status]")?.textContent'))
      .toContain("Paired.");
    await retainedPopup.close();
    // This record contains no secret and tests unknown-version byte preservation only.
    const unknownRecordBeforeReload = await compatible.evaluate(async (storageKey) => {
      await chrome.storage.local.set({ [storageKey]: { schemaVersion: 999, opaque: "preserve" } });
      // Chrome storage, not the object literal's insertion order, defines the serialized baseline.
      return JSON.stringify((await chrome.storage.local.get(storageKey))[storageKey]);
    }, key);
    const unknownWorker = context.waitForEvent("serviceworker");
    await compatible.evaluate(() => {
      setTimeout(() => chrome.runtime.reload(), 0);
    });
    const restarted = await unknownWorker;
    stage("unknown-reloaded");
    const reloaded = await openPopup(restarted, true);
    await expect
      .poll(() => reloaded.evaluate('document.querySelector("[role=status]")?.textContent'))
      .toContain("Update required");
    stage("unknown-status-proved");
    expect(
      await restarted.evaluate(async () => {
        const record = (await chrome.storage.local.get("catalog.operator-session.staging"))[
          "catalog.operator-session.staging"
        ];
        return (
          typeof record === "object" &&
          record !== null &&
          !Array.isArray(record) &&
          "schemaVersion" in record &&
          "opaque" in record &&
          JSON.stringify(Object.keys(record).sort()) === JSON.stringify(["opaque", "schemaVersion"]) &&
          record.schemaVersion === 999 &&
          record.opaque === "preserve"
        );
      }),
    ).toBe(true);
    expect(
      await restarted.evaluate(
        async (beforeReload) =>
          JSON.stringify(
            (await chrome.storage.local.get("catalog.operator-session.staging"))["catalog.operator-session.staging"],
          ) === beforeReload,
        unknownRecordBeforeReload,
      ),
    ).toBe(true);
    stage("unknown-record-preserved");
    await reloaded.close();
    stage("reload-proved");
    const retained = readdirSync(evidence, { recursive: true, withFileTypes: true }).filter((file) => file.isFile());
    for (const file of retained) {
      const bytes = readFileSync(join(file.parentPath, file.name));
      expect(
        bytes.includes(Buffer.from(cookieMarker)) || bytes.includes(Buffer.from(grantMarker)),
        "retained artifact marker scan",
      ).toBe(false);
    }
  } finally {
    await context.close();
  }
});
