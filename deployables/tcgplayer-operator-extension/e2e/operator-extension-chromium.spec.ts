/// <reference types="chrome" />

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { chromium, expect, test } from "@playwright/test";
import { build } from "vite";
import { operatorExtensionId } from "../src/manifest-contract";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
const evidence = resolve(root, "../../artifacts/operator-extension");
function inventory(directory: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(directory, { recursive: true, withFileTypes: true })
      .filter((file) => file.isFile())
      .map((file) => {
        const path = join(file.parentPath, file.name);
        return [
          relative(directory, path).replaceAll("\\", "/"),
          createHash("sha256").update(readFileSync(path)).digest("hex"),
        ];
      })
      .sort(([left], [right]) => left!.localeCompare(right!)),
  );
}

test("operator-extension-deterministic-build @tcgplayer-operator-extension", async () => {
  const first = inventory(dist);
  await build({ root, configFile: resolve(root, "vite.config.ts"), logLevel: "error" });
  const second = inventory(dist);
  expect(second).toEqual(first);
  expect({ ...second, "unlisted.js": "unexpected" }).not.toEqual(first);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  mkdirSync(evidence, { recursive: true });
  writeFileSync(
    join(evidence, "handoff.json"),
    JSON.stringify({ schemaVersion: 1, sourceHead: head, extensionId: operatorExtensionId, files: second }, null, 2) +
      "\n",
  );
});

test("operator-extension-chromium: opaque UI, exact-host cookies and retained reload @tcgplayer-operator-extension", async () => {
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
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    expect(new URL(worker.url()).host).toBe(operatorExtensionId);
    // Direct loopback CDP setup is outside Playwright recording. Only synthetic values enter this profile.
    const port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split(/\r?\n/)[0];
    const targets: unknown = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    if (!Array.isArray(targets)) throw new Error("Missing synthetic debug target");
    const target: unknown = targets.find(
      (candidate: unknown) =>
        typeof candidate === "object" && candidate !== null && "url" in candidate && candidate.url === worker.url(),
    );
    if (
      typeof target !== "object" ||
      target === null ||
      !("webSocketDebuggerUrl" in target) ||
      typeof target.webSocketDebuggerUrl !== "string"
    )
      throw new Error("Missing synthetic worker target");
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((done, reject) => {
      socket.onopen = () => done();
      socket.onerror = () => reject(new Error("Synthetic setup unavailable"));
    });
    let sequence = 0;
    async function setup(expression: string) {
      const id = ++sequence;
      return new Promise<void>((done, reject) => {
        const timer = setTimeout(() => reject(new Error("Synthetic setup deadline")), 5000);
        const receive = (event: MessageEvent) => {
          const reply: unknown = JSON.parse(String(event.data));
          if (typeof reply !== "object" || reply === null || !("id" in reply) || reply.id !== id) return;
          clearTimeout(timer);
          socket.removeEventListener("message", receive);
          if (
            "error" in reply ||
            !("result" in reply) ||
            typeof reply.result !== "object" ||
            reply.result === null ||
            "exceptionDetails" in reply.result
          )
            reject(new Error("Synthetic setup refused"));
          else done();
        };
        socket.addEventListener("message", receive);
        socket.send(
          JSON.stringify({
            id,
            method: "Runtime.evaluate",
            params: { expression, awaitPromise: true, returnByValue: true },
          }),
        );
      });
    }
    const cookieMarker = ["SYNTHETIC", "OPERATOR", "COOKIE", "CHROMIUM"].join("_");
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
    socket.close();
    await worker.evaluate(async () => {
      await chrome.action.openPopup();
    });
    const popup =
      context.pages().find((page) => page.url().endsWith("/popup.html")) ?? (await context.waitForEvent("page"));
    const ui = popup.frameLocator("iframe");
    await expect(ui.getByRole("heading", { name: "TCGplayer Operator Extension" })).toBeVisible();
    await expect(ui.getByRole("status")).not.toHaveText("Loading status");
    await ui.getByLabel("Pairing grant").fill(grantMarker);
    await ui.getByRole("button", { name: "Pair", exact: true }).click();
    await expect(ui.getByLabel("Pairing grant")).toHaveValue("");
    await expect(ui.getByRole("status")).toContainText("Paired.");
    const sandbox = popup.frames().find((frame) => frame.url().endsWith("/sandbox.html"));
    if (!sandbox) throw new Error("Sandbox missing");
    expect(await sandbox.evaluate(() => typeof chrome === "undefined" || (!chrome.storage && !chrome.cookies))).toBe(
      true,
    );
    expect(
      await sandbox.evaluate(() => {
        try {
          void parent.document;
          return false;
        } catch {
          return true;
        }
      }),
    ).toBe(true);
    // No grant or cookie setup is traced. The retained screenshot is status-only.
    await popup.screenshot({ path: join(evidence, "sandbox-status.png") });
    await popup.close();
    const compatibleWorker = context.waitForEvent("serviceworker");
    await worker.evaluate(() => {
      setTimeout(() => chrome.runtime.reload(), 0);
    });
    const compatible = await compatibleWorker;
    await compatible.evaluate(async () => {
      await chrome.action.openPopup();
    });
    const retainedPopup =
      context.pages().find((page) => page.url().endsWith("/popup.html")) ?? (await context.waitForEvent("page"));
    await expect(retainedPopup.frameLocator("iframe").getByRole("status")).toContainText("Paired.");
    await retainedPopup.close();
    // This record contains no secret and tests unknown-version byte preservation only.
    await compatible.evaluate(async (storageKey) => {
      await chrome.storage.local.set({ [storageKey]: { schemaVersion: 999, opaque: "preserve" } });
    }, key);
    const unknownWorker = context.waitForEvent("serviceworker");
    await compatible.evaluate(() => {
      setTimeout(() => chrome.runtime.reload(), 0);
    });
    const restarted = await unknownWorker;
    await restarted.evaluate(async () => {
      await chrome.action.openPopup();
    });
    const reloaded =
      context.pages().find((page) => page.url().endsWith("/popup.html")) ?? (await context.waitForEvent("page"));
    await expect(reloaded.frameLocator("iframe").getByRole("status")).toContainText("Update required");
    expect(
      await restarted.evaluate(
        async () =>
          JSON.stringify(
            (await chrome.storage.local.get("catalog.operator-session.staging"))["catalog.operator-session.staging"],
          ) === JSON.stringify({ schemaVersion: 999, opaque: "preserve" }),
      ),
    ).toBe(true);
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
