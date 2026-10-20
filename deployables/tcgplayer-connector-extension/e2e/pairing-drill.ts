import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chromium,
  expect,
  type BrowserContext,
  type Page,
  type Response as PlaywrightResponse,
  type Route,
  type Worker,
} from "@playwright/test";
import { linkIntentOrigins } from "@chase-sets/platform-runtime/link-intents";
import { TCGPLAYER_CONNECTOR_EXTENSION_ID, TCGPLAYER_CONNECTOR_REDIRECT_URI } from "@chase-sets/channels/client";

const localOrigin = /^http:\/\/127\.0\.0\.1:\d+$/;
const providerEnvironment = /^(?:TCGPLAYER_|PROVIDER.*(?:SESSION|CREDENTIAL)|CONNECTOR.*CONFIG_ROOT)/i;
const forbiddenReceiptValues = ["access_token", "refresh_token", "code_verifier", "Bearer ", "cc_at_", "cc_rt_"];

export type DrillRequestRow = Readonly<{ origin: string; source: "worker" | "page"; count: number }>;
export type PairingDrillReceipt = Readonly<{
  artifactDigest: string;
  clientIdSuffix: string;
  pairingIdSuffix: string;
  pageOpenedPath: string;
  pageStatus: number;
  pageResponseMs: number;
  pairedState: "paired-idle";
  requests: readonly DrillRequestRow[];
  trace: "none";
  reservation: "none" | "present";
  lifecycle: readonly string[];
}>;

export type PairingDrillInput = Readonly<{
  dist: string;
  platformOrigin: string;
  clientId: string;
  artifactDigest: string;
  signIn(context: BrowserContext): Promise<void>;
  preparePairing(context: BrowserContext): Promise<string | void>;
  revoke(context: BrowserContext): Promise<void>;
  /** The callback URI can be changed only by a test control; the default is the pinned extension URI. */
  callbackUri?: string;
  traceActive?: boolean;
}>;

function assertPlatformOrigin(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("connector-drill-platform-origin-refused");
  }
  const generated = [linkIntentOrigins["marketplace-web"].staging, linkIntentOrigins["marketplace-web"].production];
  if (
    parsed.origin !== value ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    !(generated.includes(parsed.origin) || localOrigin.test(parsed.origin))
  )
    throw new Error("connector-drill-platform-origin-refused");
  return parsed.origin;
}

function assertIsolatedEnvironment() {
  if (Object.keys(process.env).some((key) => providerEnvironment.test(key)))
    throw new Error("connector-drill-provider-environment-refused");
}

function requestSource(request: { frame(): unknown }): "worker" | "page" {
  try {
    return request.frame() ? "page" : "worker";
  } catch {
    return "worker";
  }
}

function suffix(value: string, label: string) {
  if (!value || value.length < 4) throw new Error(`${label}-receipt-refused`);
  return value.slice(-4);
}

async function triggerAction(context: BrowserContext, page: Page) {
  const cdp = await context.browser()!.newBrowserCDPSession();
  try {
    const targets = (await cdp.send("Target.getTargets", { filter: [{ type: "tab" }, { exclude: true }] })).targetInfos;
    const target = targets.find((candidate) => candidate.url === page.url());
    if (!target) throw new Error("connector-drill-action-target-missing");
    await cdp.send("Extensions.triggerAction", { id: TCGPLAYER_CONNECTOR_EXTENSION_ID, targetId: target.targetId });
  } finally {
    await cdp.detach();
  }
}

async function workerFor(context: BrowserContext): Promise<Worker> {
  return (
    context.serviceWorkers().find((worker) => worker.url().endsWith("/background.js")) ??
    context.waitForEvent("serviceworker", {
      predicate: (worker) => worker.url().endsWith("/background.js"),
      timeout: 10_000,
    })
  );
}

function safeHeaders(headers: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !["cookie", "host", "content-length"].includes(name.toLowerCase())),
  );
}

async function forwardWorkerRequest(route: Route, platformOrigin: string) {
  const request = route.request();
  const url = new URL(request.url());
  if (url.origin !== platformOrigin) {
    await route.abort();
    return;
  }
  const response = await fetch(request.url(), {
    method: request.method(),
    headers: safeHeaders(request.headers()),
    body: ["GET", "HEAD"].includes(request.method()) ? undefined : (request.postData() ?? undefined),
    redirect: "manual",
  });
  if ((response.status >= 300 && response.status < 400) || response.type === "opaqueredirect") {
    await route.abort();
    return;
  }
  const headers = Object.fromEntries(
    [...response.headers].filter(
      ([name]) => !["set-cookie", "content-encoding", "content-length"].includes(name.toLowerCase()),
    ),
  );
  await route.fulfill({ status: response.status, headers, body: Buffer.from(await response.arrayBuffer()) });
}

function assertBoundDist(dist: string, platformOrigin: string, clientId: string) {
  const manifest = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8")) as { host_permissions?: unknown };
  if (!Array.isArray(manifest.host_permissions) || !manifest.host_permissions.includes(`${platformOrigin}/*`))
    throw new Error("connector-drill-dist-origin-refused");
  if (!readFileSync(join(dist, "background.js"), "utf8").includes(clientId))
    throw new Error("connector-drill-dist-client-refused");
}

export async function runPairingDrill(input: PairingDrillInput): Promise<PairingDrillReceipt> {
  const platformOrigin = assertPlatformOrigin(input.platformOrigin);
  assertIsolatedEnvironment();
  if (!input.clientId.startsWith("cc_client_") || input.clientId.length < 4)
    throw new Error("connector-drill-client-id-refused");
  if (!input.artifactDigest || !/^[a-f0-9]{16,128}$/i.test(input.artifactDigest))
    throw new Error("connector-drill-artifact-digest-refused");
  assertBoundDist(input.dist, platformOrigin, input.clientId);

  const requests = new Map<string, DrillRequestRow>();
  const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "connector-drill-")), {
    channel: "chromium",
    headless: false,
    args: [
      `--disable-extensions-except=${input.dist}`,
      `--load-extension=${input.dist}`,
      "--enable-unsafe-extension-debugging",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    ],
  });
  let pageResponse: PlaywrightResponse | null = null;
  const routeRows: Array<{ origin: string; path: string; source: "worker" | "page" }> = [];
  const record = (url: URL, source: "worker" | "page") => {
    const key = `${url.origin}|${source}`;
    const previous = requests.get(key);
    requests.set(key, { origin: url.origin, source, count: (previous?.count ?? 0) + 1 });
  };
  const callbackUri = input.callbackUri ?? TCGPLAYER_CONNECTOR_REDIRECT_URI;
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const source = requestSource(request);
    routeRows.push({ origin: url.origin, path: url.pathname, source });
    if (url.origin === new URL(callbackUri).origin && url.pathname === new URL(callbackUri).pathname) {
      record(url, source);
      await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>callback</title>" });
      return;
    }
    if (source === "page") {
      record(url, source);
      await route.continue();
      if (url.pathname === "/account/channels/connection_synthetic") {
        try {
          pageResponse = await request.response();
        } catch {
          pageResponse = null;
        }
      }
      return;
    }
    if (url.origin === platformOrigin) {
      record(url, source);
      await forwardWorkerRequest(route, platformOrigin);
      return;
    }
    record(url, source);
    await route.abort();
  });

  try {
    if (input.traceActive) await context.tracing.start({ snapshots: false, screenshots: false, sources: false });
    try {
      await context.tracing.start({ snapshots: false, screenshots: false, sources: false });
    } catch {
      throw new Error("connector-drill-trace-active");
    }
    await context.tracing.stop();
    const worker = await workerFor(context);
    await expect.poll(() => worker.evaluate(() => chrome.action.getTitle({})), { timeout: 10_000 }).toBe("unpaired");
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto("data:text/html,<title>connector drill action target</title>");
    await page.bringToFront();
    await input.signIn(context);
    const pairingId = await input.preparePairing(context);
    await worker.evaluate(async (origin) => {
      try {
        await fetch(`${origin}/forward-redirect`, { redirect: "error" });
      } catch {
        // A 3xx is refused by the cookie-less forwarder and never followed.
      }
    }, platformOrigin);
    await worker.evaluate(async () => {
      try {
        await fetch("https://connector-drill.invalid/canary", { redirect: "error" });
      } catch {
        // The route records and aborts this worker canary by design.
      }
    });
    await triggerAction(context, page);
    await expect.poll(() => worker.evaluate(() => chrome.action.getTitle({})), { timeout: 10_000 }).toBe("paired-idle");

    const pairedState = (await worker.evaluate(() => chrome.action.getTitle({}))) as "paired-idle";
    const openedAt = Date.now();
    const opened = context.waitForEvent("page", { timeout: 10_000 });
    await triggerAction(context, page);
    const pageOpened = await opened;
    await expect.poll(() => pageResponse, { timeout: 10_000 }).not.toBeNull();
    const response = pageResponse as unknown as { ok(): boolean; status(): number };
    const openedUrl = new URL(pageOpened.url());
    if (openedUrl.pathname !== "/account/channels/connection_synthetic" || !response.ok())
      throw new Error("connector-drill-page-status");
    const pageResponseMs = Date.now() - openedAt;
    if (pageResponseMs > 10_000) throw new Error("connector-drill-page-status");

    await worker.evaluate(() => {
      const root = globalThis as typeof globalThis & { connectorDrillLifecycle?: string[] };
      const lifecycle: string[] = [];
      root.connectorDrillLifecycle = lifecycle;
      const original = chrome.storage.local.set.bind(chrome.storage.local);
      Object.assign(chrome.storage.local, { set: (values: Record<string, unknown>) => {
        const profile = values["channel-connector-profile"] as { state?: string } | undefined;
        if (profile?.state && lifecycle.at(-1) !== profile.state) lifecycle.push(profile.state);
        return original(values);
      } });
    });
    await worker.evaluate(() => chrome.alarms.create("connector-work", { when: Date.now() }));
    await expect
      .poll(
        () => worker.evaluate(() => chrome.storage.local.get(["channel-connector-profile"]).then((row) => (row["channel-connector-profile"] as { state?: string } | undefined)?.state ?? "absent")),
        { timeout: 10_000 },
      )
      .toBe("revoked");
    const lifecycle = await worker.evaluate(() => (globalThis as typeof globalThis & { connectorDrillLifecycle?: string[] }).connectorDrillLifecycle ?? []);
    if (lifecycle.indexOf("cleanup-pending") < 0 || lifecycle.indexOf("cleanup-pending") > lifecycle.indexOf("revoked"))
      throw new Error("connector-drill-lifecycle-refused");
    await input.revoke(context);
    const receipt: PairingDrillReceipt = {
      artifactDigest: input.artifactDigest,
      clientIdSuffix: suffix(input.clientId, "client-id"),
      pairingIdSuffix: suffix(pairingId ?? "", "pairing-id"),
      pageOpenedPath: openedUrl.pathname,
      pageStatus: response.status(),
      pageResponseMs,
      pairedState,
      requests: [...requests.values()].sort((a, b) =>
        `${a.origin}|${a.source}`.localeCompare(`${b.origin}|${b.source}`),
      ),
      trace: "none",
      reservation: "none",
      lifecycle,
    };
    const serialized = JSON.stringify(receipt);
    if (forbiddenReceiptValues.some((marker) => serialized.includes(marker)))
      throw new Error("connector-drill-receipt-secret");
    return receipt;
  } catch (error) {
    if (routeRows.length) console.log(`CONNECTOR_DRILL_ROUTE ${JSON.stringify(routeRows)}`);
    throw error;
  } finally {
    await context.close();
  }
}

export { assertPlatformOrigin };
