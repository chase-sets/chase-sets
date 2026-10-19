import { resolve } from "node:path";
import type { BrowserContext, Page, Worker } from "@playwright/test";
import { TCGPLAYER_CONNECTOR_EXTENSION_ID, TCGPLAYER_CONNECTOR_REDIRECT_URI } from "@chase-sets/channels/client";
import { fixtureWorker } from "../__tests__/support/browser-observation";
import { launchInstallation } from "./extension-installation";

const providerEnvironment = /^(?:TCGPLAYER_|PROVIDER.*(?:SESSION|CREDENTIAL)|CONNECTOR.*CONFIG_ROOT)/i;
export const pairingDrillForbiddenMarkers = ["code=", "token=", "pkce", "cookie=", "session=", "magic-link"] as const;

export type PairingDrillReceipt = {
  artifactDigest: string;
  extensionId: string;
  platformOrigin: string;
  clientIdSuffix: string;
  preparedAt: string;
  clickedAt: string;
  states: { state: string; badge: string; title: string; at: string }[];
  pageOpenedPath: string | null;
  platformRequests: { method: string; path: string; status: number; at: string; reservation: "none" | "present" }[];
  abortedRequests: { origin: string; source: "worker" | "page"; count: number }[];
};

export type PairingDrillInput = {
  dist: string;
  platformOrigin: string;
  clientId: string;
  artifactDigest: string;
  signIn: (page: Page, platformOrigin: string) => Promise<void>;
  preparePairing: (platformOrigin: string) => Promise<void>;
  revoke: () => Promise<void>;
  routing?: {
    continueLoopbackOrigin?: string;
    classifyWorkerRequests?: boolean;
  };
  tracePath?: string;
  launch?: typeof launchInstallation;
};

function refuseProviderEnvironment(env: NodeJS.ProcessEnv) {
  if (Object.keys(env).some((key) => providerEnvironment.test(key)))
    throw new Error("connector-drill-provider-environment-refused");
}

function suffix(value: string) {
  return value.slice(-4);
}

function safePath(url: URL) {
  return url.pathname
    .split("/")
    .map((segment) => (segment.startsWith("connection_") ? segment.slice(-4) : segment))
    .join("/");
}

async function clickAction(context: BrowserContext, page: Page) {
  const cdp = await context.browser()!.newBrowserCDPSession();
  try {
    const targets = (await cdp.send("Target.getTargets", { filter: [{ type: "tab" }, { exclude: true }] })).targetInfos;
    const target = targets.find((value) => value.url === page.url());
    if (!target) throw new Error("connector-drill-action-target-missing");
    await cdp.send("Extensions.triggerAction", { id: TCGPLAYER_CONNECTOR_EXTENSION_ID, targetId: target.targetId });
  } finally {
    await cdp.detach();
  }
}

export async function runPairingDrill(input: PairingDrillInput): Promise<PairingDrillReceipt> {
  refuseProviderEnvironment(process.env);
  if (!/^https?:\/\//.test(input.platformOrigin)) throw new Error("connector-drill-platform-origin-refused");
  const install = await (input.launch ?? launchInstallation)(input.dist);
  const { context } = install;
  const platform = new URL(input.platformOrigin);
  const callback = new URL(TCGPLAYER_CONNECTOR_REDIRECT_URI);
  const platformRequests: PairingDrillReceipt["platformRequests"] = [];
  const aborted = new Map<string, { origin: string; source: "worker" | "page"; count: number }>();
  const states: PairingDrillReceipt["states"] = [];
  let letThrough = false;
  if (input.routing?.continueLoopbackOrigin) {
    const target = new URL(input.routing.continueLoopbackOrigin);
    if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || target.origin === platform.origin)
      throw new Error("connector-drill-loopback-routing-refused");
  }
  const recordState = async (worker: Worker) => {
    const value = await worker.evaluate(async () => ({
      state: await chrome.action.getTitle({}),
      badge: await chrome.action.getBadgeText({}),
      title: await chrome.action.getTitle({}),
    }));
    states.push({ ...value, at: new Date().toISOString() });
    return value.state;
  };
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const source =
      route.request().serviceWorker() && input.routing?.classifyWorkerRequests !== false ? "worker" : "page";
    if (url.origin === platform.origin) {
      const response = await route.fetch();
      const body = url.pathname.endsWith("/claim") && response.ok() ? await response.json() : null;
      platformRequests.push({
        method: route.request().method(),
        path: safePath(url),
        status: response.status(),
        at: new Date().toISOString(),
        reservation: body?.reservation == null ? "none" : "present",
      });
      await route.fulfill(body === null ? { response } : { response, json: body });
      return;
    }
    if (url.origin === callback.origin && url.pathname === callback.pathname) {
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    if (!letThrough && url.origin === input.routing?.continueLoopbackOrigin) {
      letThrough = true;
      await route.continue();
      return;
    }
    const key = `${url.origin}|${source}`;
    const row = aborted.get(key) ?? { origin: url.origin, source, count: 0 };
    row.count++;
    aborted.set(key, row);
    await route.abort();
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await input.signIn(page, input.platformOrigin);
    await context.tracing.start({ screenshots: false, snapshots: false, sources: false });
    const worker = await fixtureWorker(context, "/background.js");
    await recordState(worker);
    await worker.evaluate(() => fetch("https://connector-drill-canary.invalid/").catch(() => null));
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (aborted.get("https://connector-drill-canary.invalid|worker")?.count !== 1)
      throw new Error("connector-drill-canary-unobserved");
    if (input.routing?.continueLoopbackOrigin) {
      await page.evaluate((origin) => fetch(origin).catch(() => null), input.routing.continueLoopbackOrigin);
      if (letThrough) throw new Error("connector-drill-non-platform-request-continued");
    }
    const preparedAt = new Date().toISOString();
    await input.preparePairing(input.platformOrigin);
    const clickedAt = new Date().toISOString();
    await clickAction(context, page);
    const pairedAt = Date.now() + 30_000;
    while (Date.now() < pairedAt) {
      if ((await recordState(worker)) === "paired-idle") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!states.some((row) => row.state === "paired-idle")) throw new Error("connector-drill-pairing-timeout");
    await clickAction(context, page);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await recordState(worker);
    await page.evaluate(() => fetch("https://connector-drill-planted.invalid/").catch(() => null));
    await worker.evaluate(() => {
      const observation = globalThis as typeof globalThis & { pairingDrillPersistedStates: string[] };
      observation.pairingDrillPersistedStates = [];
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        const next = changes["channel-connector-profile"]?.newValue;
        const state = next && typeof next === "object" && "state" in next ? next.state : undefined;
        if (typeof state === "string") observation.pairingDrillPersistedStates.push(state);
      });
    });
    await input.revoke();
    await worker.evaluate(() => chrome.alarms.create("connector-work", { when: Date.now() + 50 }));
    const revokedAt = Date.now() + 30_000;
    while (Date.now() < revokedAt) {
      const state = await recordState(worker);
      if (state === "revoked") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const persistedStates = await worker.evaluate(
      () => (globalThis as typeof globalThis & { pairingDrillPersistedStates: string[] }).pairingDrillPersistedStates,
    );
    const cleanupAt = persistedStates.indexOf("cleanup-pending");
    if (
      cleanupAt < 0 ||
      persistedStates.indexOf("revoked") <= cleanupAt ||
      !states.some((row) => row.state === "revoked")
    )
      throw new Error("connector-drill-revocation-transition-missing");
    const opened = context
      .pages()
      .find((candidate) => candidate !== page && new URL(candidate.url()).origin === platform.origin);
    return {
      artifactDigest: input.artifactDigest,
      extensionId: TCGPLAYER_CONNECTOR_EXTENSION_ID,
      platformOrigin: input.platformOrigin,
      clientIdSuffix: suffix(input.clientId),
      preparedAt,
      clickedAt,
      states,
      pageOpenedPath: opened ? safePath(new URL(opened.url())) : null,
      platformRequests,
      abortedRequests: [...aborted.values()],
    };
  } finally {
    await context.tracing
      .stop({ path: input.tracePath ?? resolve("artifacts/connector-extension/pairing-drill-trace.zip") })
      .catch(() => {});
    await context.close();
  }
}
