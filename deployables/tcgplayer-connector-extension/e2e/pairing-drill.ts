import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { chromium, type BrowserContext, type Page, type Request, type Route, type Worker } from "@playwright/test";
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
  | "connector-drill-reservation-replay"
  | "connector-drill-canary-unaccounted"
  | "connector-drill-page-source-mismatch"
  | "connector-drill-seam-ignored"
  | "connector-drill-post-revoke"
  | "connector-drill-input-incomplete"
  | "connector-drill-production-origin-refused"
  | "connector-drill-deploy-binding-refused"
  | "connector-drill-preflight-mount-refused"
  | "connector-drill-preflight-client-refused"
  | "connector-drill-persona-refused"
  | "connector-drill-sign-in-unavailable"
  | "connector-drill-profile-cleanup-refused";

export type PairingDrillPreflightRow = Readonly<{
  name: "deploy" | "mount" | "client";
  host: string;
  path: string;
  status: number | string;
  contentType?: string;
  bodyCode?: string;
  locationHost?: string;
  errorDescription?: string;
  unregisteredStatus?: number;
}>;

export type PairingDrillPreflight = Readonly<{
  deployRun: string;
  deployCommit: string;
  rows: readonly PairingDrillPreflightRow[];
  binding?: Readonly<{
    state: "completed";
    skipped: boolean;
    superseded: boolean;
    requiredMerges: readonly number[];
  }>;
}>;

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
  abandonedReportCount: number;
  tokenCookieArrived: boolean;
  claimCookieArrived: boolean;
  plantedPageServed?: number;
  letThroughServed?: number;
  droppedPageCount?: number;
}>;
/** The lifecycle entry the served claims must end in: a reservation the shipped dist abandons, or a 401. */
export type PairingDrillLifecycleEnd = "paused:unsupported-operation" | "revoked";
export type PairingDrillFixture = Readonly<{
  observe(): PairingDrillObservation;
  redirectPath: string;
  headersPath: string;
  lifecycleEnd: PairingDrillLifecycleEnd;
  secondOrigin?: string;
}>;
export type PairingDrillSeams = Readonly<{
  pageRoute?: (route: Route, request: Request) => Promise<void>;
  classify?: (request: Request) => "worker" | "page";
  routeFilter?: (url: URL, request: Request) => boolean;
  resolveOrigin?: (url: URL) => string;
  forward?: (
    request: ForwardRequest,
    handles: ForwardHandles,
    defaultForward: () => Promise<void>,
    context: BrowserContext,
  ) => Promise<void>;
  trigger?: (
    context: BrowserContext,
    page: Page,
    phase: "pairing" | "page",
    defaultTrigger: () => Promise<boolean>,
  ) => Promise<boolean>;
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
  seams?: PairingDrillSeams;
  /** Trace-active mutant: starts real tracing before the probe. */
  traceActive?: boolean;
  /** Deployed mode is the only mode allowed to claim staging evidence. */
  mode?: "loopback" | "deployed";
  deployRun?: string;
  deployCommit?: string;
  personaAlias?: string;
  preflight?: PairingDrillPreflight;
  /** Smoke only observes the page route and never signs in or creates a connection. */
  smoke?: boolean;
  /** Test-only resolver; evidence from it is explicitly fake, never staging authority. */
  resolveOrigin?: (url: URL) => string;
}>;
export type PairingDrillReceipt = Readonly<{
  fixture: "present" | "none";
  artifactDigest: string;
  clientIdSuffix: string;
  pairingIdSuffix: string;
  pageOpenedPath: string;
  pageStatus: number | null;
  pairedState: "paired-idle" | "smoke";
  requests: readonly DrillRequestRow[];
  trace: "none";
  reservation: "present" | "none";
  claimCount: number | null;
  reservationClaimCount: number | null;
  invalidCredentialClaimCount: number | null;
  lifecycle: readonly string[];
  mode?: "loopback" | "deployed";
  origin?: "staging" | "fake";
  deployRun?: string;
  deployCommit?: string;
  personaAlias?: string;
  preflight?: PairingDrillPreflight;
  profilePath?: string;
  profileDeleted?: boolean;
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

export type ForwardRequest = Readonly<{
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Buffer | null;
}>;
export type ForwardHandles = Readonly<{
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

export function acceptedPlatformOrigin(value: string, mode: "loopback" | "deployed" = "loopback") {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  const generated: string[] =
    mode === "deployed"
      ? [linkIntentOrigins["marketplace-web"].staging]
      : [linkIntentOrigins["marketplace-web"].staging, linkIntentOrigins["marketplace-web"].production];
  // A value equal to its own origin carries no userinfo, path, query or fragment.
  return parsed.origin === value && (loopbackOrigin.test(value) || generated.includes(value));
}

function preflightRefusal(input: PairingDrillInput, deployed: boolean) {
  if (!deployed) return null;
  if (
    input.smoke !== true &&
    (!input.deployRun || !input.deployCommit || !input.clientId || !input.artifactDigest || !input.personaAlias)
  )
    return "connector-drill-input-incomplete" as const;
  if (input.platformOrigin === linkIntentOrigins["marketplace-web"].production)
    return "connector-drill-production-origin-refused" as const;
  if (!acceptedPlatformOrigin(input.platformOrigin, "deployed"))
    return "connector-drill-platform-origin-refused" as const;
  const preflight = input.preflight;
  if (!preflight || preflight.deployRun !== input.deployRun || preflight.deployCommit !== input.deployCommit)
    return "connector-drill-deploy-binding-refused" as const;
  if (
    preflight.binding &&
    (preflight.binding.state !== "completed" ||
      preflight.binding.skipped ||
      preflight.binding.superseded ||
      ![10110, 9985, 10639, 10640].every((number) => preflight.binding!.requiredMerges.includes(number)))
  )
    return "connector-drill-deploy-binding-refused" as const;
  if (input.smoke) return null;
  const mount = preflight.rows.find((row) => row.name === "mount");
  if (
    !mount ||
    mount.status !== 400 ||
    mount.contentType?.split(";", 1)[0].toLowerCase() !== "application/json" ||
    mount.bodyCode !== "invalid-request"
  )
    return "connector-drill-preflight-mount-refused" as const;
  const client = preflight.rows.find((row) => row.name === "client");
  if (
    !client ||
    client.status !== 302 ||
    client.locationHost !== new URL(TCGPLAYER_CONNECTOR_REDIRECT_URI).host ||
    client.errorDescription !== "authorization_refused" ||
    client.unregisteredStatus !== 400
  )
    return "connector-drill-preflight-client-refused" as const;
  return null;
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
export async function forwardWorkerRequest(request: ForwardRequest, handles: ForwardHandles) {
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
/** The stored profile as a lifecycle entry: `state`, or `state:pauseReason` while paused. */
const profileEntry = (worker: Worker) =>
  worker.evaluate(
    (key) =>
      chrome.storage.local.get([key]).then((row) => {
        const profile = row[key] as { state?: string; pauseReason?: string | null } | undefined;
        if (!profile?.state) return "absent";
        return profile.pauseReason ? `${profile.state}:${profile.pauseReason}` : profile.state;
      }),
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
  const { platformOrigin, fixture, seams } = input;
  const deployed = input.mode === "deployed";
  const observe = fixture?.observe;
  const preflightCode = preflightRefusal(input, deployed);
  if (preflightCode) fail(preflightCode);
  if (!acceptedPlatformOrigin(platformOrigin, deployed ? "deployed" : "loopback"))
    fail(
      deployed && platformOrigin === linkIntentOrigins["marketplace-web"].production
        ? "connector-drill-production-origin-refused"
        : "connector-drill-platform-origin-refused",
    );
  if (deployed && !input.smoke && !input.signIn) fail("connector-drill-sign-in-unavailable");
  if (Object.keys(process.env).some((key) => providerEnvironmentPattern.test(key)))
    fail("connector-drill-provider-environment-refused");
  if (!input.smoke) {
    if (!distGrantsOrigin(input.dist, platformOrigin)) fail("connector-drill-dist-origin-refused");
    if (!distCarriesClient(input.dist, input.clientId)) fail("connector-drill-dist-client-refused");
    if (digestConnectorDist(input.dist) !== input.artifactDigest) fail("connector-drill-artifact-digest-refused");
  }

  const profilePath = mkdtempSync(join(tmpdir(), "connector-drill-"));
  const minimalEnv = Object.fromEntries(
    ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "HOME"]
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]!]),
  );
  const context = await chromium.launchPersistentContext(profilePath, {
    channel: "chromium",
    headless: false,
    env: minimalEnv,
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
      if (seams?.routeFilter && !seams.routeFilter(url, request)) {
        await route.continue();
        return;
      }
      const source = seams?.classify?.(request) ?? (request.serviceWorker() ? "worker" : "page");
      const key = `${url.origin}|${source}`;
      rows.set(key, { origin: url.origin, source, count: (rows.get(key)?.count ?? 0) + 1 });
      if (url.origin === callback.origin && url.pathname === callback.pathname)
        await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>callback</title>" });
      else if (source === "page" && url.origin === platformOrigin && (seams?.resolveOrigin || input.resolveOrigin))
        await route.continue({ url: seams?.resolveOrigin?.(url) ?? input.resolveOrigin!(url) });
      else if (source === "page") await (seams?.pageRoute ? seams.pageRoute(route, request) : route.continue());
      else if (url.origin === platformOrigin) {
        const forwardRequest = {
          url: seams?.resolveOrigin?.(url) ?? input.resolveOrigin?.(url) ?? url.href,
          method: request.method(),
          headers: request.headers(),
          body: request.postDataBuffer(),
        };
        const handles = recordingHandles(route, url.pathname, forwards);
        const defaultForward = () => forwardWorkerRequest(forwardRequest, handles);
        await (seams?.forward ? seams.forward(forwardRequest, handles, defaultForward, context) : defaultForward());
      } else await route.abort();
    });
    if (input.traceActive) await context.tracing.start(traceOptions);
    try {
      await context.tracing.start(traceOptions);
    } catch {
      fail("connector-drill-trace-active");
    }
    await context.tracing.stop();

    if (input.smoke) {
      const page = context.pages()[0] ?? (await context.newPage());
      const pageResponse = await page.goto(`${platformOrigin}/account/channels`).catch(() => null);
      await page.bringToFront();
      const smokeReceipt: PairingDrillReceipt = {
        fixture: "none",
        artifactDigest: input.artifactDigest,
        clientIdSuffix: input.clientId.slice(-4),
        pairingIdSuffix: "",
        pageOpenedPath: new URL(page.url()).pathname || "/account/channels",
        pageStatus: pageResponse?.status() ?? null,
        pairedState: "smoke",
        requests: requests(),
        trace: "none",
        reservation: "none",
        claimCount: null,
        reservationClaimCount: null,
        invalidCredentialClaimCount: null,
        lifecycle: [],
        mode: "deployed",
        origin: input.resolveOrigin || seams?.resolveOrigin ? "fake" : "staging",
        deployRun: input.deployRun,
        deployCommit: input.deployCommit,
        personaAlias: input.personaAlias,
        preflight: input.preflight,
        profilePath,
        profileDeleted: true,
      };
      return { receipt: smokeReceipt, forwards: [...forwards] };
    }

    const worker = await connectorWorker(context);
    if (!worker || !(await waitFor(async () => (await actionTitle(worker)) === "unpaired")))
      fail("connector-drill-bootstrap-refused");
    const connector = worker!;

    await connector.evaluate(async () => {
      try {
        await fetch("https://connector-drill.invalid/canary");
      } catch {
        // The route abort is the evidence; the worker fetch rejection is expected.
      }
    });
    const canary = rows.get("https://connector-drill.invalid|worker");
    if (!canary || canary.count !== 1) fail("connector-drill-canary-unaccounted");

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
    const pageResponse = await page.goto(`${platformOrigin}/account/channels`).catch(() => null);
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
      !(await (seams?.trigger
        ? seams.trigger(context, page, "pairing", () => triggerAction(context, page))
        : triggerAction(context, page))) ||
      !(await waitFor(async () => (await actionTitle(connector)) === "paired-idle"))
    )
      fail("connector-drill-pairing-refused");

    if (fixture?.secondOrigin) {
      const seamPage = await context.newPage();
      try {
        await seamPage.goto(`${platformOrigin}/account/channels`).catch(() => null);
        await seamPage
          .evaluate(async (url) => {
            try {
              await fetch(url, { mode: "no-cors" });
            } catch {
              // The route and fake-server counter are the evidence.
            }
          }, `${fixture.secondOrigin}/drill/planted-page`)
          .catch(() => null);
        await seamPage.goto(`${fixture.secondOrigin}/drill/let-through`).catch(() => null);
      } finally {
        await seamPage.close();
      }
      const seamObservation = observe?.();
      const planted = rows.get(`${fixture.secondOrigin}|page`);
      if (!seamObservation || seamObservation.plantedPageServed !== 1 || !planted || planted.count < 1)
        fail("connector-drill-page-source-mismatch");
      if (seamObservation.letThroughServed !== 1) fail("connector-drill-seam-ignored");
    }

    if (
      !(await (seams?.trigger
        ? seams.trigger(context, page, "page", () => triggerAction(context, page))
        : triggerAction(context, page)))
    )
      fail("connector-drill-page-status");
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
    const lifecycleEnd = fixture?.lifecycleEnd ?? "revoked";
    const ended = await waitFor(async () => (await profileEntry(connector)) === lifecycleEnd);
    lifecycle = await readLifecycle(connector);
    const settledObservation = observe?.();
    const cleanupAt = lifecycle.indexOf("cleanup-pending");
    // Each end must follow the served claim that causes it, not only a matching stored state.
    const caused =
      lifecycleEnd === "revoked"
        ? cleanupAt >= 0 &&
          cleanupAt < lifecycle.lastIndexOf("revoked") &&
          (!settledObservation || settledObservation.invalidCredentialClaimCount > 0)
        : !!settledObservation &&
          settledObservation.reservationClaimCount > 0 &&
          settledObservation.abandonedReportCount > 0 &&
          lifecycle.at(-1) === lifecycleEnd;
    if (!ended || !caused) fail("connector-drill-lifecycle-refused");
    if (settledObservation?.tokenCookieArrived || settledObservation?.claimCookieArrived)
      fail("connector-drill-forward-cookie");
    if (settledObservation && settledObservation.reservationClaimCount > 1) fail("connector-drill-reservation-replay");

    const claimCountBeforeRevoke = settledObservation?.claimCount ?? null;
    await input.revoke(context);
    if (settledObservation) {
      await fire();
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      if (observe!().claimCount !== claimCountBeforeRevoke) fail("connector-drill-post-revoke");
    }
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
        mode: deployed ? "deployed" : "loopback",
        origin: deployed && (input.resolveOrigin || seams?.resolveOrigin) ? "fake" : deployed ? "staging" : undefined,
        deployRun: input.deployRun,
        deployCommit: input.deployCommit,
        personaAlias: input.personaAlias,
        preflight: input.preflight,
        profilePath,
        profileDeleted: true,
      },
      forwards: [...forwards],
    };
  } finally {
    await context.close();
    try {
      rmSync(profilePath, { recursive: true, force: false });
    } catch {
      fail("connector-drill-profile-cleanup-refused");
    }
  }
}
