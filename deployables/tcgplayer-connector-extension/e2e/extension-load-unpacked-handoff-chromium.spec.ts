import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium, expect, test, type BrowserContext } from "@playwright/test";
import { build } from "vite";
import { TCGPLAYER_CONNECTOR_EXTENSION_ID } from "@chase-sets/channels/client";
import { fixtureWorker } from "../__tests__/support/browser-observation";
import { connectorTargets } from "../vite.config";

test.setTimeout(90_000);
test.use({ trace: "off", screenshot: "off" });

const packageRoot = resolve(import.meta.dirname, "..");
const clientId = "cc_client_00000000-0000-4000-8000-000000000000";
let dist: string;
let platformOrigin: string;
let context: BrowserContext | undefined;

test.beforeAll(async () => {
  dist = mkdtempSync(join(tmpdir(), "connector-handoff-staging-"));
  platformOrigin = connectorTargets.staging;
  process.env.VITE_PLATFORM_API_URL = platformOrigin;
  process.env.VITE_CONNECTOR_CLIENT_ID = clientId;
  await build({
    root: packageRoot,
    configFile: resolve(packageRoot, "vite.config.ts"),
    configLoader: "runner",
    mode: "connector-staging",
    logLevel: "warn",
    build: { outDir: dist, emptyOutDir: true },
  });
});

test.afterAll(async () => {
  await context?.close();
  if (dist) rmSync(dist, { recursive: true, force: true });
  delete process.env.VITE_PLATFORM_API_URL;
  delete process.env.VITE_CONNECTOR_CLIENT_ID;
});

test("extension-load-unpacked-handoff-chromium", async () => {
  const requests: string[] = [];
  context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "connector-handoff-profile-")), {
    channel: "chromium",
    headless: false,
    args: [
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
      "--enable-unsafe-extension-debugging",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    ],
  });
  await context.route("**/*", async (route) => {
    requests.push(route.request().url());
    await route.abort();
  });
  const worker = await fixtureWorker(context, "/background.js");
  expect(await worker.evaluate(() => chrome.runtime.id)).toBe(TCGPLAYER_CONNECTOR_EXTENSION_ID);
  expect(await worker.evaluate(() => chrome.action.getTitle({}))).toBe("unpaired");
  const manifest = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"));
  expect(manifest.host_permissions).toContain(`${platformOrigin}/*`);
  await new Promise((resolve) => setTimeout(resolve, 60_000));
  expect(requests).toEqual([]);
});
