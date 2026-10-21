import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { chromium, type BrowserContext, type Page, type Route, type Worker } from "@playwright/test";
import { linkIntentOrigins } from "@chase-sets/platform-runtime/link-intents";
import { TCGPLAYER_CONNECTOR_EXTENSION_ID, TCGPLAYER_CONNECTOR_REDIRECT_URI } from "@chase-sets/channels/client";

/** Provider session, credential and config-root variables; the harness build refuses the same set. */
export const providerEnvironmentPattern = /^TCGPLAYER_|PROVIDER.*(?:SESSION|CREDENTIAL)|CONNECTOR.*CONFIG_ROOT/i;
/** The body a fixture `headersPath` serves gzip-encoded; the worker must read it back decoded. */
export const drillHeadersBody = "drill-headers";

const loopbackOrigin = /^http:\/\/127\.0\.0\.1:\d+$/;
const clientIdPattern = /^cc_client_[A-Za-z0-9_-]+$/;
const droppedRequestHeaders = ["cookie", "host", "content-length"];
const droppedResponseHeaders = ["set-cookie", "content-encoding", "content-length"];
const profileKey = "channel-connector-profile";
const channelPagePath = "/account/channels/connection_synthetic";
const legMs = 10_000;
const traceOptions = { snapshots: false, screenshots: false, sources: false };

export type PairingDrillRefusalCode =
  | "connector-drill-platform-origin-refused"
  | "connector-drill-provider-environment-refused"
  | "connector-drill-dist-origin-refused"
  | "connector-drill-dist-client-refused"
  | "connector-drill-artifact-digest-refused"
  | "connector-drill-trace-active"
  | "connector-drill-bootstrap-refused"
  | "connector-drill-redirect"
  | "connector-drill-forward-headers"
  | "connector-drill-pairing-refused"
  | "connector-drill-page-status"
  | "connector-drill-lifecycle-refused"
  | "connector-drill-forward-cookie"
  | "connector-drill-reservation-replay";

export type DrillRequestRow = Readonly<{ origin: string; source: "worker" | "page"; count: number }>;
export type ForwardRecord = Readonly<{
  path: string;
  action: "fulfill" | "abort" | "continue";
  status: number | null;
  fulfilledHeaderNames: readonly string[];
}>;
/** Counters written only by the fake server's handlers and the spec's planted-path handler. */
export type PairingDrillObservation = Readonly<{
  redirectTargetCount: number;
  headersServed: number;
  channelPageServed: number;
  pageStatus: number | null;
  claimCount: number;
  reservationClaimCount: number;
  invalidCredentialClaimCount: number;
  reportCount: number;
  tokenCookieArrived: boolean;
  claimCookieArrived: boolean;
}>;
export type PairingDrillFixture = Readonly<{
  observe(): PairingDrillObservation;
  redirectPath: string;
  headersPath: string;
}>;
export type PairingDrillInput = Readonly<{
  dist: string;
  platformOrigin: string;
  clientId: string;
  artifactDigest: string;
  signIn(context: BrowserContext): Promise<void>;
  /** Creates the pairing code and returns the served `pairingId`. */
  preparePairing(context: BrowserContext): Promise<string>;
  revoke(context: BrowserContext): Promise<void>;
  /** Absent skips the fixture legs and every server-counter read; such a receipt says `fixture: "none"`. */
  fixture?: PairingDrillFixture;
  /** Trace-active mutant: starts real tracing before the probe. */
  traceActive?: boolean;
}>;
export type PairingDrillReceipt = Readonly<{
  fixture: "present" | "none";
  artifactDigest: string;
  clientIdSuffix: string;
  pairingIdSuffix: string;
  pageOpenedPath: string;
  pageStatus: number | null;
  pairedState: "paired-idle";
  requests: readonly DrillRequestRow[];
  trace: "none";
  reservation: "present" | "none";
  claimCount: number | null;
  reservationClaimCount: number | null;
  invalidCredentialClaimCount: number | null;
  lifecycle: readonly string[];
}>;
export type PairingDrillEvidence = Readonly<{
  forwardCount: number;
  forwards: readonly ForwardRecord[];
  requests: readonly DrillRequestRow[];
  lifecycle: readonly string[];
}>;

export class PairingDrillRefusal extends Error {
  readonly code: PairingDrillRefusalCode;
  readonly evidence: PairingDrillEvidence;
  constructor(code: PairingDrillRefusalCode, evidence: PairingDrillEvidence) {
    super(code);
    this.name = "PairingDrillRefusal";
    this.code = code;
    this.evidence = evidence;
  }
}

type ForwardRequest = Readonly<{ url: string; method: string; headers: Record<string, string>; body: Buffer | null }>;
type ForwardHandles = Readonly<{
  fulfill(response: { status: number; headers: Record<string, string>; body: Buffer }): Promise<void>;
  abort(status: number | null): Promise<void>;
  continue(): Promise<void>;
}>;

/** SHA-256 over every dist file in path order, each framed by its relative name and byte length. */
export function digestConnectorDist(dist: string) {
  const hash = createHash("sha256");
  const files = readdirSync(dist, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dist, join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
    .sort();
  for (const file of files) {
    const bytes = readFileSync(join(dist, file));
    hash.update(file).update("\0").update(String(bytes.byteLength)).update("\0").update(bytes);
  }
  return hash.digest("hex");
}

function acceptedPlatformOrigin(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  const generated: string[] = [
    linkIntentOrigins["marketplace-web"].staging,
    linkIntentOrigins["marketplace-web"].production,
  ];
  // A value equal to its own origin carries no userinfo, path, query or fragment.
  return parsed.origin === value && (loopbackOrigin.test(value) || generated.includes(value));
}

function distFile(dist: string, file: string) {
  try {
    return readFileSync(join(dist, file), "utf8");
  } catch {
    return "";
  }
}

function distGrantsOrigin(dist: string, origin: string) {
  try {
    const manifest = JSON.parse(distFile(dist, "manifest.json")) as { host_permissions?: unknown };
    return Array.isArray(manifest.host_permissions) && manifest.host_permissions.includes(`${origin}/*`);
  } catch {
    return false;
  }
}

function distCarriesClient(dist: string, clientId: string) {
  return clientIdPattern.test(clientId) && new RegExp(`["'\`]${clientId}["'\`]`).test(distFile(dist, "background.js"));
}

/** Cookie-less forwarder: it acts only through the recording handles and never follows a redirect. */
async function forwardWorkerRequest(request: ForwardRequest, handles: ForwardHandles) {
  let response: Response;
  try {
    response = await fetch(request.url, {
      method: request.method,
      headers: Object.fromEntries(
        Object.entries(request.headers).filter(([name]) => !droppedRequestHeaders.includes(name.toLowerCase())),
      ),
      body: request.body ? new Uint8Array(request.body) : undefined,
      redirect: "manual",
    });
  } catch {
    await handles.abort(null);
    return;
  }
  if ((response.status >= 300 && response.status < 400) || response.type === "opaqueredirect") {
    await response.body?.cancel();
    await handles.abort(response.status);
    return;
  }
  const headers = Object.fromEntries([...response.headers].filter(([name]) => !droppedResponseHeaders.includes(name)));
  await handles.fulfill({ status: response.status, headers, body: Buffer.from(await response.arrayBuffer()) });
}

function recordingHandles(route: Route, path: string, forwards: ForwardRecord[]): ForwardHandles {
  const record = (action: ForwardRecord["action"], status: number | null, fulfilledHeaderNames: string[] = []) =>
    forwards.push({ path, action, status, fulfilledHeaderNames });
  return {
    async fulfill(response) {
      record(
        "fulfill",
        response.status,
        Object.keys(response.headers).map((name) => name.toLowerCase()),
      );
      await route.fulfill(response);
    },
    async abort(status) {
      record("abort", status);
      await route.abort();
    },
    async continue() {
      record("continue", null);
      await route.continue();
    },
  };
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = legMs) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      if (await check()) return true;
    } catch {
      // A transient worker evaluation failure is retried until the leg's deadline.
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function connectorWorker(context: BrowserContext): Promise<Worker | null> {
  const isConnector = (worker: Worker) => worker.url().endsWith("/background.js");
  return (
    context.serviceWorkers().find(isConnector) ??
    context.waitForEvent("serviceworker", { predicate: isConnector, timeout: legMs }).catch(() => null)
  );
}

async function triggerAction(context: BrowserContext, page: Page) {
  try {
    const cdp = await context.browser()!.newBrowserCDPSession();
    try {
      const targets = (await cdp.send("Target.getTargets", { filter: [{ type: "tab" }, { exclude: true }] }))
        .targetInfos;
      const target = targets.find((candidate) => candidate.url === page.url());
      if (!target) return false;
      await cdp.send("Extensions.triggerAction", { id: TCGPLAYER_CONNECTOR_EXTENSION_ID, targetId: target.targetId });
      return true;
    } finally {
      await cdp.detach();
    }
  } catch {
    return false;
  }
}

const actionTitle = (worker: Worker) => worker.evaluate(() => chrome.action.getTitle({}));
const profileState = (worker: Worker) =>
  worker.evaluate(
    (key) =>
      chrome.storage.local.get([key]).then((row) => (row[key] as { state?: string } | undefined)?.state ?? "absent"),
    profileKey,
  );
const readLifecycle = (worker: Worker) =>
  worker.evaluate(
    () => (globalThis as typeof globalThis & { connectorDrillLifecycle?: string[] }).connectorDrillLifecycle ?? [],
  );

/**
 * Drives the built connector dist through pairing, the served channel page and the claim lifecycle in a
 * trace-free Chromium. Every outcome is read from the fake server's counters, the forwarder's records or
 * extension storage; each refusal carries its code and the records gathered so far.
 */
export async function runPairingDrill(
  input: PairingDrillInput,
): Promise<{ receipt: PairingDrillReceipt; forwards: readonly ForwardRecord[] }> {
  const forwards: ForwardRecord[] = [];
  const rows = new Map<string, DrillRequestRow>();
  let lifecycle: readonly string[] = [];
  const requests = () =>
    [...rows.values()].sort((a, b) => `${a.origin}|${a.source}`.localeCompare(`${b.origin}|${b.source}`));
  const fail: (code: PairingDrillRefusalCode) => never = (code) => {
    throw new PairingDrillRefusal(code, {
      forwardCount: forwards.length,
      forwards: [...forwards],
      requests: requests(),
      lifecycle,
    });
  };
  const { platformOrigin, fixture } = input;
  const observe = fixture?.observe;
  if (!acceptedPlatformOrigin(platformOrigin)) fail("connector-drill-platform-origin-refused");
  if (Object.keys(process.env).some((key) => providerEnvironmentPattern.test(key)))
    fail("connector-drill-provider-environment-refused");
  if (!distGrantsOrigin(input.dist, platformOrigin)) fail("connector-drill-dist-origin-refused");
  if (!distCarriesClient(input.dist, input.clientId)) fail("connector-drill-dist-client-refused");
  if (digestConnectorDist(input.dist) !== input.artifactDigest) fail("connector-drill-artifact-digest-refused");

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
  try {
    const callback = new URL(TCGPLAYER_CONNECTOR_REDIRECT_URI);
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const source = request.serviceWorker() ? "worker" : "page";
      const key = `${url.origin}|${source}`;
      rows.set(key, { origin: url.origin, source, count: (rows.get(key)?.count ?? 0) + 1 });
      if (url.origin === callback.origin && url.pathname === callback.pathname)
        await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>callback</title>" });
      else if (source === "page") await route.continue();
      else if (url.origin === platformOrigin)
        await forwardWorkerRequest(
          { url: url.href, method: request.method(), headers: request.headers(), body: request.postDataBuffer() },
          recordingHandles(route, url.pathname, forwards),
        );
      else await route.abort();
    });
    if (input.traceActive) await context.tracing.start(traceOptions);
    try {
      await context.tracing.start(traceOptions);
    } catch {
      fail("connector-drill-trace-active");
    }
    await context.tracing.stop();

    const worker = await connectorWorker(context);
    if (!worker || !(await waitFor(async () => (await actionTitle(worker)) === "unpaired")))
      fail("connector-drill-bootstrap-refused");
    const connector = worker!;

    if (fixture) {
      await connector.evaluate(async (url) => {
        try {
          await fetch(url);
        } catch {
          // The forwarder aborts the redirect; the record, not this rejection, is the evidence.
        }
      }, `${platformOrigin}${fixture.redirectPath}`);
      const redirect = forwards.find((row) => row.path === fixture.redirectPath);
      if (redirect?.action !== "abort" || redirect.status !== 302 || fixture.observe().redirectTargetCount !== 0)
        fail("connector-drill-redirect");
      const body = await connector.evaluate(async (url) => {
        try {
          return await (await fetch(url)).text();
        } catch {
          return null;
        }
      }, `${platformOrigin}${fixture.headersPath}`);
      const headers = forwards.find((row) => row.path === fixture.headersPath);
      if (
        headers?.action !== "fulfill" ||
        headers.fulfilledHeaderNames.some((name) => droppedResponseHeaders.includes(name)) ||
        body !== drillHeadersBody ||
        fixture.observe().headersServed !== 1
      )
        fail("connector-drill-forward-headers");
    }

    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`${platformOrigin}/account/channels`).catch(() => null);
    await page.bringToFront();
    await connector.evaluate((key) => {
      const lifecycle: string[] = [];
      (globalThis as typeof globalThis & { connectorDrillLifecycle?: string[] }).connectorDrillLifecycle = lifecycle;
      chrome.storage.onChanged.addListener((changes, area) => {
        const profile = changes[key]?.newValue as { state?: string; pauseReason?: string | null } | undefined;
        if (area !== "local" || !profile?.state) return;
        const entry = profile.pauseReason ? `${profile.state}:${profile.pauseReason}` : profile.state;
        if (lifecycle.at(-1) !== entry) lifecycle.push(entry);
      });
    }, profileKey);

    await input.signIn(context);
    const pairingId = await input.preparePairing(context);
    if (
      typeof pairingId !== "string" ||
      pairingId.length < 4 ||
      !(await triggerAction(context, page)) ||
      !(await waitFor(async () => (await actionTitle(connector)) === "paired-idle"))
    )
      fail("connector-drill-pairing-refused");

    if (!(await triggerAction(context, page))) fail("connector-drill-page-status");
    let opened: URL | undefined;
    const served = await waitFor(() => {
      opened = context
        .pages()
        .map((candidate) => new URL(candidate.url()))
        .find((url) => url.origin === platformOrigin && url.pathname === channelPagePath);
      return !!opened && (!observe || observe().channelPageServed >= 1);
    });
    const pageStatus = observe ? observe().pageStatus : null;
    if (!served || (observe && (observe().channelPageServed !== 1 || pageStatus !== 200)))
      fail("connector-drill-page-status");

    const fire = () => connector.evaluate(() => chrome.alarms.create("connector-work", { when: Date.now() }));
    if (observe) {
      for (let fires = 0; fires < 3; fires++) {
        const before = observe().claimCount;
        let seen = before;
        let changedAt = Date.now();
        await fire();
        // A claim settles once every served reservation is reported and no further claim arrives for 1 s.
        const settled = await waitFor(() => {
          const now = observe();
          if (now.claimCount !== seen) [seen, changedAt] = [now.claimCount, Date.now()];
          return (
            now.claimCount > before && now.reportCount >= now.reservationClaimCount && Date.now() - changedAt >= 1000
          );
        });
        if (!settled || observe().invalidCredentialClaimCount > 0) break;
      }
    } else await fire();
    const revoked = await waitFor(async () => (await profileState(connector)) === "revoked");
    lifecycle = await readLifecycle(connector);
    const cleanupAt = lifecycle.indexOf("cleanup-pending");
    if (!revoked || cleanupAt < 0 || cleanupAt > lifecycle.lastIndexOf("revoked"))
      fail("connector-drill-lifecycle-refused");
    const settledObservation = observe?.();
    if (settledObservation?.tokenCookieArrived || settledObservation?.claimCookieArrived)
      fail("connector-drill-forward-cookie");
    if (settledObservation && settledObservation.reservationClaimCount > 1) fail("connector-drill-reservation-replay");

    await input.revoke(context);
    return {
      receipt: {
        fixture: fixture ? "present" : "none",
        artifactDigest: input.artifactDigest,
        clientIdSuffix: input.clientId.slice(-4),
        pairingIdSuffix: pairingId.slice(-4),
        pageOpenedPath: opened!.pathname,
        pageStatus,
        pairedState: "paired-idle",
        requests: requests(),
        trace: "none",
        reservation: settledObservation && settledObservation.reservationClaimCount > 0 ? "present" : "none",
        claimCount: settledObservation?.claimCount ?? null,
        reservationClaimCount: settledObservation?.reservationClaimCount ?? null,
        invalidCredentialClaimCount: settledObservation?.invalidCredentialClaimCount ?? null,
        lifecycle,
      },
      forwards: [...forwards],
    };
  } finally {
    await context.close();
  }
}
