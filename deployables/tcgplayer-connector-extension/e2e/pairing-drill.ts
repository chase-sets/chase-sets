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
  revoke: (worker: Worker) => Promise<void>;
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
    const source = route.request().serviceWorker() ? "worker" : "page";
    if (url.origin === platform.origin) {
      const response = await route.fetch();
      platformRequests.push({
        method: route.request().method(),
        path: safePath(url),
        status: response.status(),
        at: new Date().toISOString(),
        reservation: url.pathname.endsWith("/claim") && response.ok() ? "present" : "none",
      });
      await route.fulfill({ response });
      return;
    }
    if (url.origin === callback.origin && url.pathname === callback.pathname) {
      await route.fulfill({ status: 204, body: "" });
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
    await input.revoke(worker);
    const revokedAt = Date.now() + 30_000;
    while (Date.now() < revokedAt) {
      const state = await recordState(worker);
      if (state === "revoked") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!states.some((row) => row.state === "cleanup-pending") || !states.some((row) => row.state === "revoked"))
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
