import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  chromium,
  type BrowserContext,
  type Page,
  type Request,
  type Response as BrowserResponse,
  type Route,
  type Worker,
} from "@playwright/test";
import { linkIntentOrigins } from "@chase-sets/platform-runtime/link-intents";
import { TCGPLAYER_CONNECTOR_EXTENSION_ID, TCGPLAYER_CONNECTOR_REDIRECT_URI } from "@chase-sets/channels/client";
import { scanRetainedArtifacts } from "./retained-artifacts";

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
  | "connector-drill-sign-in-unavailable"
  | "connector-drill-deploy-binding-refused"
  | "connector-drill-preflight-mount-refused"
  | "connector-drill-preflight-client-refused"
  | "connector-drill-persona-refused"
  | "connector-drill-connection-refused"
  | "connector-drill-paused-claim-refused"
  | "connector-drill-unpair-refused"
  | "connector-drill-display-refused"
  | "connector-drill-tcgplayer-refused"
  | "connector-drill-worker-origin-refused"
  | "connector-drill-smoke-refused"
  | "connector-drill-retained-secret"
  | "connector-drill-profile-cleanup-refused";

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
  mode?: "loopback";
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
  /** Deployed mode only: every row recorded before the refusal, and the profile's fate. */
  deployed?: DeployedDrillRows & Readonly<{ profile: DeployedDrillProfile | null }>;
  /** The deploy-authority adapter's stop code when it bound no deploy. */
  deployStop?: string;
}>;

/** The owning Deploy Staging job, as the delivery-owned deploy-authority adapter read it just before launch. */
export type PairingDrillDeployBinding = Readonly<{
  runId: string;
  runAttempt: number;
  jobId: string;
  jobCompletedAt: string;
  deployedHead: string;
  /** Each required issue's closing-PR merge commit, compared with `deployedHead`. */
  requiredMerges: readonly Readonly<{
    issue: number;
    pullRequest: number | null;
    mergeCommit: string | null;
    contained: boolean;
  }>[];
  /** The run staging sign-in's deployed receipt binds; a pairing run may be no older. */
  receiptFloorRunId: string | null;
}>;
/** One unauthenticated, never-redirected edge probe, sent from Node before Chromium launches. */
export type PairingDrillPreflightRow = Readonly<{
  row: "mount" | "client" | "unregistered-client";
  host: string;
  path: string;
  status: number;
  contentType: string | null;
  bodyCode: string | null;
  locationHost: string | null;
  errorDescription: string | null;
}>;
export type PairingDrillPreflight = Readonly<{
  deploy: PairingDrillDeployBinding;
  rows: readonly PairingDrillPreflightRow[];
}>;
/** Fake seam only: the exact staging host resolves to this loopback address, trusted through one test certificate. */
export type PairingDrillResolver = Readonly<{
  address: string;
  port: number;
  certificateSpki: string;
  certificatePem: string;
}>;
export type DrillLaunchOptions = Readonly<{
  channel: "chromium";
  headless: false;
  env: Record<string, string>;
  args: string[];
}>;
export type DeployedPairingDrillInput = Readonly<{
  mode: "deployed";
  /** Smoke loads `/account/channels` only: it never signs in, loads the extension or creates a connection. */
  smoke: boolean;
  platformOrigin: string;
  deployRun: string;
  deployCommit: string;
  preflight: PairingDrillPreflight | null;
  dist?: string;
  clientId?: string;
  artifactDigest?: string;
  personaAlias?: string;
  signIn?: (context: BrowserContext) => Promise<void>;
  resolver?: PairingDrillResolver;
  /** Literal values the caller held; the retained receipt must contain none of them. */
  secretMarkers?: readonly string[];
  /** A fresh directory the receipt is retained and scanned in before PASS. */
  outputDir: string;
  traceActive?: boolean;
  /** Test seam: launches the drill profile's persistent context. */
  launch?: (profilePath: string, options: DrillLaunchOptions) => Promise<BrowserContext>;
}>;
export type DeployedStepRow = Readonly<{
  step: string;
  method: string;
  host: string;
  path: string;
  status: number;
  contentType: string | null;
  bodyCode: string | null;
}>;
export type DeployedPageRow = Readonly<{
  method: string;
  host: string;
  path: string;
  status: number;
  contentType: string | null;
  locationHost: string | null;
  at: number;
}>;
export type DeployedClaimRow = Readonly<{
  phase: "paused" | "unpaired";
  path: string;
  status: number;
  reservation: null | "present" | "unreadable";
  bodyCode: string | null;
}>;
export type DeployedDisplayRow = Readonly<{ state: string; title: string; badge: string }>;
export type DeployedDrillProfile = Readonly<{ path: string; deleted: boolean }>;
type DeployedDrillRows = Readonly<{
  steps: readonly DeployedStepRow[];
  pages: readonly DeployedPageRow[];
  claims: readonly DeployedClaimRow[];
  display: readonly DeployedDisplayRow[];
  aborted: readonly DrillRequestRow[];
}>;
export type DeployedPairingDrillReceipt = DeployedDrillRows &
  Readonly<{
    mode: "deployed";
    kind: "pairing" | "staging-smoke";
    /** `fake` when the resolver seam carried the run; such a receipt is never staging evidence. */
    origin: "staging" | "fake";
    platformHost: string;
    deploy: PairingDrillDeployBinding;
    preflight: readonly PairingDrillPreflightRow[];
    personaAlias: string | null;
    clientIdSuffix: string | null;
    artifactDigest: string | null;
    extensionId: string | null;
    connectionIdSuffix: string | null;
    pairingIdSuffix: string | null;
    generateToClickMs: number | null;
    lifecycle: readonly string[];
    requests: readonly DrillRequestRow[];
    cookies: readonly Readonly<{ domain: string; count: number }>[];
    trace: "none";
    profile: DeployedDrillProfile;
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
 * trace-free Chromium. Loopback mode reads every outcome from the fake server's counters, the forwarder's records
 * or extension storage; deployed mode reads only what the browser and extension observe. Each refusal carries its
 * code and the records gathered so far.
 */
export function runPairingDrill(input: DeployedPairingDrillInput): Promise<{ receipt: DeployedPairingDrillReceipt }>;
export function runPairingDrill(
  input: PairingDrillInput,
): Promise<{ receipt: PairingDrillReceipt; forwards: readonly ForwardRecord[] }>;
export function runPairingDrill(input: PairingDrillInput | DeployedPairingDrillInput) {
  return input.mode === "deployed" ? deployedDrill(input) : loopbackDrill(input);
}

async function loopbackDrill(
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
      if (seams?.routeFilter && !seams.routeFilter(url, request)) {
        await route.continue();
        return;
      }
      const source = seams?.classify?.(request) ?? (request.serviceWorker() ? "worker" : "page");
      const key = `${url.origin}|${source}`;
      rows.set(key, { origin: url.origin, source, count: (rows.get(key)?.count ?? 0) + 1 });
      if (url.origin === callback.origin && url.pathname === callback.pathname)
        await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>callback</title>" });
      else if (source === "page") await (seams?.pageRoute ? seams.pageRoute(route, request) : route.continue());
      else if (url.origin === platformOrigin) {
        const forwardRequest = {
          url: url.href,
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
      },
      forwards: [...forwards],
    };
  } finally {
    await context.close();
  }
}

const stagingOrigin = linkIntentOrigins["marketplace-web"].staging;
const productionOrigin = linkIntentOrigins["marketplace-web"].production;
const canaryOrigin = "https://connector-drill.invalid";
const tcgplayerHost = /(^|\.)tcgplayer\.com$/i;
const callbackHost = new URL(TCGPLAYER_CONNECTOR_REDIRECT_URI).host;
const generateButton = 'form:has(input[name="intent"][value="connector-code"]) button[type="submit"]';
const unpairButton = 'form:has(input[name="intent"][value="connector-unpair"]) button[type="submit"]';
const claimPath = /^\/channel-connector\/oauth\/connections\/[^/]+\/claim$/;
const pairingWindowMs = 600_000;
/** Issues whose closing-PR merges the deployed commit must contain: client registration, the pinned callback route, this drill and staging sign-in. */
export const deployedRequiredIssues = { pairing: [10110, 9985, 10639, 10640], smoke: [10639] } as const;
/** Marker names no retained deployed receipt may contain, before any caller-held literal. */
export const retainedSecretMarkers = ["access_token", "refresh_token", "code_verifier", "Bearer ", "cc_at_", "cc_rt_"];
/** The only variables Chromium inherits: process, temp-directory and display plumbing, never agent or provider values. */
const browserEnvironmentKeys = [
  "PATH",
  "Path",
  "HOME",
  "USER",
  "LANG",
  "TMPDIR",
  "TEMP",
  "TMP",
  "DISPLAY",
  "XAUTHORITY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "SystemDrive",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "ProgramFiles",
  "ProgramData",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const mediaType = (value: string | null | undefined) => value?.split(";", 1)[0].trim().toLowerCase() ?? null;
const succeeded = (status: number) => status >= 200 && status < 300;

/** A JSON body's code: its `error` (or `error.code`), else the `status` or `state` it reports. */
function bodyCode(body: unknown) {
  if (!isRecord(body)) return null;
  if (typeof body.error === "string") return body.error;
  if (isRecord(body.error) && typeof body.error.code === "string") return body.error.code;
  for (const key of ["status", "state"]) if (typeof body[key] === "string") return body[key] as string;
  return null;
}

export function drillBrowserEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(
    browserEnvironmentKeys.flatMap((key) => (source[key] === undefined ? [] : [[key, source[key]!]])),
  );
}

/** Only the exact platform host resolves; the fake seam maps it to its loopback port and trusts one SPKI. */
export function deployedBrowserArgs(platformOrigin: string, resolver?: PairingDrillResolver, dist?: string) {
  const host = new URL(platformOrigin).hostname;
  return [
    ...(dist
      ? [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, "--enable-unsafe-extension-debugging"]
      : []),
    resolver
      ? `--host-resolver-rules=MAP ${host}:443 ${resolver.address}:${resolver.port}, MAP * ~NOTFOUND`
      : `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${host}`,
    ...(resolver ? [`--ignore-certificate-errors-spki-list=${resolver.certificateSpki}`] : []),
  ];
}

/** Deletes the drill profile; true only when nothing remains, however the removal failed. */
export function cleanDrillProfile(
  path: string,
  remove = (target: string) => rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }),
) {
  try {
    remove(path);
  } catch {
    // The existence check below is the verdict.
  }
  return !existsSync(path);
}

/** Writes the receipt alone into `outputDir` and scans it; a marker hit deletes the file and throws. */
export function retainDeployedReceipt(outputDir: string, receipt: unknown, markers: readonly string[]) {
  mkdirSync(outputDir, { recursive: true });
  const file = join(outputDir, "receipt.json");
  writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`);
  try {
    return scanRetainedArtifacts(
      outputDir,
      markers.filter((marker) => marker.length > 0),
    );
  } catch (error) {
    rmSync(file, { force: true });
    throw error;
  }
}

/** The pre-launch verdict on a deployed input: its inputs, origin, deploy binding and preflight rows. */
export function deployedInputRefusal(input: DeployedPairingDrillInput): PairingDrillRefusalCode | null {
  if (input.platformOrigin === productionOrigin) return "connector-drill-production-origin-refused";
  if (input.platformOrigin !== stagingOrigin) return "connector-drill-platform-origin-refused";
  if (
    !/^[1-9]\d{0,19}$/.test(input.deployRun) ||
    !/^[a-f0-9]{40}$/.test(input.deployCommit) ||
    !input.outputDir ||
    (!input.smoke && (!input.dist || !input.clientId || !input.artifactDigest || !input.personaAlias))
  )
    return "connector-drill-input-incomplete";
  if (!input.smoke && !input.signIn) return "connector-drill-sign-in-unavailable";
  const deploy = input.preflight?.deploy;
  const floor = deploy?.receiptFloorRunId;
  if (
    !deploy ||
    deploy.runId !== input.deployRun ||
    deploy.deployedHead !== input.deployCommit ||
    !deployedRequiredIssues[input.smoke ? "smoke" : "pairing"].every((issue) =>
      deploy.requiredMerges.some((merge) => merge.issue === issue && merge.contained),
    ) ||
    (!input.smoke && (!floor || !/^[1-9]\d{0,19}$/.test(floor) || BigInt(deploy.runId) < BigInt(floor)))
  )
    return "connector-drill-deploy-binding-refused";
  if (input.smoke) return null;
  const host = new URL(input.platformOrigin).host;
  const row = (name: PairingDrillPreflightRow["row"]) =>
    input.preflight!.rows.find((candidate) => candidate.row === name && candidate.host === host);
  const mount = row("mount");
  if (
    mount?.status !== 400 ||
    mediaType(mount.contentType) !== "application/json" ||
    mount.bodyCode !== "invalid-request"
  )
    return "connector-drill-preflight-mount-refused";
  const client = row("client");
  if (
    client?.status !== 302 ||
    client.locationHost !== callbackHost ||
    client.errorDescription !== "authorization_refused" ||
    row("unregistered-client")?.status !== 400
  )
    return "connector-drill-preflight-client-refused";
  return null;
}

type LegOutcome = Readonly<{
  connectionIdSuffix: string | null;
  pairingIdSuffix: string | null;
  generateToClickMs: number | null;
  cookies: readonly Readonly<{ domain: string; count: number }>[];
  heldValues: readonly string[];
}>;

async function deployedDrill(input: DeployedPairingDrillInput): Promise<{ receipt: DeployedPairingDrillReceipt }> {
  const { platformOrigin } = input;
  const platformHost = new URL(platformOrigin).host;
  const requests = new Map<string, DrillRequestRow>();
  const aborted = new Map<string, DrillRequestRow>();
  const steps: DeployedStepRow[] = [];
  const pages: DeployedPageRow[] = [];
  const claims: DeployedClaimRow[] = [];
  const display: DeployedDisplayRow[] = [];
  const isolation = { tcgplayer: 0, workerEscapes: 0, connectionWrites: 0 };
  let lifecycle: readonly string[] = [];
  let profile: DeployedDrillProfile | null = null;
  let connectionId: string | null = null;
  let claimPhase: DeployedClaimRow["phase"] = "paused";
  const sorted = (rows: Map<string, DrillRequestRow>) =>
    [...rows.values()].sort((a, b) => `${a.origin}|${a.source}`.localeCompare(`${b.origin}|${b.source}`));
  const count = (rows: Map<string, DrillRequestRow>, origin: string, source: "worker" | "page") => {
    const key = `${origin}|${source}`;
    rows.set(key, { origin, source, count: (rows.get(key)?.count ?? 0) + 1 });
  };
  const redact = (path: string) => (connectionId ? path.replaceAll(connectionId, "<connectionId>") : path);
  const evidence = (): PairingDrillEvidence => ({
    forwardCount: 0,
    forwards: [],
    requests: sorted(requests),
    lifecycle,
    deployed: {
      steps: [...steps],
      pages: [...pages],
      claims: [...claims],
      display: [...display],
      aborted: sorted(aborted),
      profile,
    },
  });
  const fail: (code: PairingDrillRefusalCode) => never = (code) => {
    throw new PairingDrillRefusal(code, evidence());
  };

  const refused = deployedInputRefusal(input);
  if (refused) fail(refused);
  if (Object.keys(process.env).some((key) => providerEnvironmentPattern.test(key)))
    fail("connector-drill-provider-environment-refused");
  const dist = input.smoke ? undefined : input.dist!;
  if (dist) {
    if (!distGrantsOrigin(dist, platformOrigin)) fail("connector-drill-dist-origin-refused");
    if (!distCarriesClient(dist, input.clientId!)) fail("connector-drill-dist-client-refused");
    if (digestConnectorDist(dist) !== input.artifactDigest) fail("connector-drill-artifact-digest-refused");
  }

  const checkIsolation = () => {
    if (isolation.tcgplayer) fail("connector-drill-tcgplayer-refused");
    if (isolation.workerEscapes) fail("connector-drill-worker-origin-refused");
  };
  const inspectCookies = async (context: BrowserContext) => {
    const cookies = await context.cookies();
    if (cookies.some((cookie) => tcgplayerHost.test(cookie.domain.replace(/^\./, ""))))
      fail("connector-drill-tcgplayer-refused");
    return cookies;
  };
  const observe = async (response: BrowserResponse) => {
    const request = response.request();
    const url = new URL(request.url());
    if (url.origin !== platformOrigin) return;
    const headers = response.headers();
    // Chromium does not consistently mark the initial document response for a
    // tab opened by `chrome.tabs.create` as a navigation request. Resource
    // type is the stable document boundary for both the original page and
    // extension-opened tabs.
    if (!request.serviceWorker() && request.resourceType() === "document") {
      pages.push({
        method: request.method(),
        host: url.host,
        path: redact(url.pathname),
        status: response.status(),
        contentType: mediaType(headers["content-type"]),
        locationHost: headers.location ? new URL(headers.location, url).host : null,
        at: Date.now(),
      });
      return;
    }
    if (!request.serviceWorker() || !claimPath.test(url.pathname)) return;
    const phase = claimPhase;
    const body: unknown = await response.json().catch(() => undefined);
    claims.push({
      phase,
      path: redact(url.pathname),
      status: response.status(),
      reservation:
        isRecord(body) && "reservation" in body ? (body.reservation === null ? null : "present") : "unreadable",
      bodyCode: bodyCode(body),
    });
  };
  const install = async (context: BrowserContext) => {
    const callback = new URL(TCGPLAYER_CONNECTOR_REDIRECT_URI);
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const source = request.serviceWorker() ? "worker" : "page";
      count(requests, url.origin, source);
      if (url.origin === callback.origin && url.pathname === callback.pathname) {
        await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>callback</title>" });
        return;
      }
      if (url.origin === platformOrigin) {
        if (request.method() === "POST" && url.pathname.startsWith("/api/channels/connections"))
          isolation.connectionWrites++;
        // The browser's own network stack and cookie jar carry every platform request.
        await route.continue();
        return;
      }
      count(aborted, url.origin, source);
      if (tcgplayerHost.test(url.hostname)) isolation.tcgplayer++;
      else if (source === "worker" && url.origin !== canaryOrigin) isolation.workerEscapes++;
      await route.abort();
    });
    const observePage = (page: Page) => {
      page.on("response", (response) => {
        // Extension-created tabs are not always surfaced through the context
        // response stream. Attach at the page boundary so their document
        // status is retained before the page-status check runs.
        observe(response).catch(() => undefined);
      });
    };
    for (const page of context.pages()) observePage(page);
    context.on("page", observePage);
    if (input.traceActive) await context.tracing.start(traceOptions);
    try {
      await context.tracing.start(traceOptions);
    } catch {
      fail("connector-drill-trace-active");
    }
    await context.tracing.stop();
  };
  /** Same-origin `fetch` inside the platform page: the browser network stack and its cookies, never Node. */
  const call = (page: Page, method: string, path: string, body?: unknown) =>
    page
      .evaluate(
        async ({ method, path, body }) => {
          const response = await fetch(path, {
            method,
            credentials: "same-origin",
            redirect: "manual",
            headers: body === undefined ? {} : { "Content-Type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
          });
          const text = await response.text();
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = null;
          }
          return { status: response.status, contentType: response.headers.get("content-type"), body: parsed };
        },
        { method, path, body },
      )
      .catch(() => ({ status: 0, contentType: null, body: null as unknown }));
  const step = async (page: Page, name: string, method: string, path: string, body?: unknown) => {
    const result = await call(page, method, path, body);
    steps.push({
      step: name,
      method,
      host: platformHost,
      path: redact(path),
      status: result.status,
      contentType: mediaType(result.contentType),
      bodyCode: bodyCode(result.body),
    });
    return result;
  };
  const open = async (page: Page, path: string) => {
    const response = await page.goto(`${platformOrigin}${path}`, { timeout: legMs }).catch(() => null);
    const landed = new URL(page.url());
    return response?.status() === 200 && landed.origin === platformOrigin && landed.pathname === path;
  };
  const cookieRows = (cookies: readonly { domain: string }[]) => {
    const counts = new Map<string, number>();
    for (const cookie of cookies) {
      const domain = cookie.domain.replace(/^\./, "");
      counts.set(domain, (counts.get(domain) ?? 0) + 1);
    }
    return [...counts].map(([domain, count]) => ({ domain, count })).sort((a, b) => a.domain.localeCompare(b.domain));
  };

  const smokeLeg = async (context: BrowserContext): Promise<LegOutcome> => {
    await install(context);
    await inspectCookies(context);
    const page = context.pages()[0] ?? (await context.newPage());
    const response = await page.goto(`${platformOrigin}/account/channels`, { timeout: legMs }).catch(() => null);
    const landed = new URL(page.url());
    checkIsolation();
    if (
      response?.status() !== 200 ||
      landed.origin !== platformOrigin ||
      pages[0]?.path !== "/account/channels" ||
      pages.some(
        (row) => row.host !== platformHost || (row.locationHost !== null && row.locationHost !== platformHost),
      ) ||
      isolation.connectionWrites
    )
      fail("connector-drill-smoke-refused");
    const cookies = await inspectCookies(context);
    return {
      connectionIdSuffix: null,
      pairingIdSuffix: null,
      generateToClickMs: null,
      cookies: cookieRows(cookies),
      heldValues: cookies.map((cookie) => cookie.value),
    };
  };

  const pairingLeg = async (context: BrowserContext): Promise<LegOutcome> => {
    await install(context);
    const worker = await connectorWorker(context);
    if (!worker || !(await waitFor(async () => (await actionTitle(worker)) === "unpaired")))
      fail("connector-drill-bootstrap-refused");
    const connector = worker!;
    await connector.evaluate(async (url) => {
      try {
        await fetch(url);
      } catch {
        // The route abort is the evidence; the worker fetch rejection is expected.
      }
    }, `${canaryOrigin}/canary`);
    if (aborted.get(`${canaryOrigin}|worker`)?.count !== 1) fail("connector-drill-canary-unaccounted");
    await connector.evaluate((key) => {
      const scope = globalThis as typeof globalThis & {
        connectorDrillLifecycle?: string[];
        connectorDrillDisplay?: { state: string; title: string; badge: string }[];
      };
      const entries: string[] = [];
      const shown: { state: string; title: string; badge: string }[] = [];
      scope.connectorDrillLifecycle = entries;
      scope.connectorDrillDisplay = shown;
      chrome.storage.onChanged.addListener((changes, area) => {
        const stored = changes[key]?.newValue as { state?: string; pauseReason?: string | null } | undefined;
        if (area !== "local" || !stored?.state) return;
        const entry = stored.pauseReason ? `${stored.state}:${stored.pauseReason}` : stored.state;
        if (entries.at(-1) === entry) return;
        entries.push(entry);
        // What the action shows when the state lands; the extension repaints only after a transition settles.
        void Promise.all([chrome.action.getTitle({}), chrome.action.getBadgeText({})]).then(([title, badge]) =>
          shown.push({ state: entry, title, badge }),
        );
      });
    }, profileKey);
    const settledDisplay = async (state: string) => ({
      state,
      title: await actionTitle(connector),
      badge: await connector.evaluate(() => chrome.action.getBadgeText({})),
    });

    await input.signIn!(context);
    await inspectCookies(context);
    const page = context.pages()[0] ?? (await context.newPage());
    if (!(await open(page, "/account/channels"))) fail("connector-drill-page-status");
    checkIsolation();

    const listed = await step(page, "list-connections", "GET", "/api/channels/connections");
    const items = isRecord(listed.body) && Array.isArray(listed.body.items) ? listed.body.items : null;
    // A further page could hold a live connection, so a paged listing is refused rather than assumed clear.
    if (
      listed.status !== 200 ||
      !items ||
      (isRecord(listed.body) && listed.body.nextCursor) ||
      items.some((item) => !isRecord(item) || (item.providerKey === "tcgplayer" && item.status !== "disconnected"))
    )
      fail("connector-drill-persona-refused");
    const locations = await step(page, "storage-locations", "GET", "/api/inventory/storage-locations");
    const location =
      isRecord(locations.body) && Array.isArray(locations.body.items)
        ? locations.body.items.find(
            (item): item is Record<string, unknown> =>
              isRecord(item) && item.is_archived === false && typeof item.storage_location_id === "string",
          )
        : undefined;
    if (locations.status !== 200 || !location) fail("connector-drill-persona-refused");

    const connected = await step(page, "connect", "POST", "/api/channels/connections", { providerKey: "tcgplayer" });
    if (
      !succeeded(connected.status) ||
      !isRecord(connected.body) ||
      typeof connected.body.connectionId !== "string" ||
      bodyCode(connected.body) !== "pending-setup"
    )
      fail("connector-drill-connection-refused");
    const id = (connected.body as { connectionId: string }).connectionId;
    connectionId = id;
    const connectionApi = `/api/channels/connections/${id}`;
    const pairingApi = `${connectionApi}/connector-pairing`;
    const connectionPage = `/account/channels/${id}`;
    const transition = async (name: string, path: string, expected: string, body?: unknown) => {
      const result = await step(page, name, "POST", path, body);
      if (!succeeded(result.status) || bodyCode(result.body) !== expected) fail("connector-drill-connection-refused");
    };

    let failure: unknown;
    let paired: Omit<LegOutcome, "cookies" | "heldValues"> | undefined;
    try {
      await transition("activate", `${connectionApi}/activate`, "active", {
        storageLocationIds: [location!.storage_location_id],
      });
      await transition("pause", `${connectionApi}/pause`, "paused");
      const beforeCode = await step(page, "pairing-before-code", "GET", pairingApi);
      if (beforeCode.status !== 200 || bodyCode(beforeCode.body) !== "unpaired")
        fail("connector-drill-connection-refused");

      if (!(await open(page, connectionPage))) fail("connector-drill-page-status");
      checkIsolation();
      const generatedAt = Date.now();
      await page
        .locator(generateButton)
        .click({ timeout: legMs })
        .catch(() => fail("connector-drill-pairing-refused"));
      let pairingId = "";
      await waitFor(async () => {
        const read = await call(page, "GET", pairingApi);
        if (isRecord(read.body) && read.body.state === "code" && typeof read.body.pairingId === "string")
          pairingId = read.body.pairingId;
        return !!pairingId;
      });
      const coded = await step(page, "pairing-code", "GET", pairingApi);
      if (!pairingId || bodyCode(coded.body) !== "code") fail("connector-drill-pairing-refused");

      await page.bringToFront();
      const clickedAt = Date.now();
      if (
        clickedAt - generatedAt > pairingWindowMs ||
        !(await triggerAction(context, page)) ||
        !(await waitFor(async () => (await actionTitle(connector)) === "paired-idle"))
      )
        fail("connector-drill-pairing-refused");
      checkIsolation();
      const pairedDisplay = await settledDisplay("paired-idle");
      display.push(pairedDisplay);
      if (pairedDisplay.title !== "paired-idle" || pairedDisplay.badge !== "ON")
        fail("connector-drill-display-refused");

      // The next click opens the stored connection's page in a new tab, served through the browser.
      const reopenedAt = Date.now();
      let popupPage: Page | undefined;
      let popupResponse: BrowserResponse | undefined;
      let popupDocument: DeployedPageRow | undefined;
      const observePopupPage = (candidate: Page) => {
        if (candidate !== page && popupPage === undefined) popupPage = candidate;
      };
      const observePopupResponse = (response: BrowserResponse) => {
        if (popupDocument !== undefined) return;
        const request = response.request();
        if (request.resourceType() !== "document") return;
        const url = new URL(request.url());
        if (url.origin !== platformOrigin || url.pathname !== connectionPage) return;
        // The response can precede the target/page event. Retain the exact
        // response and bind it to the surfaced tab once its frame is attached.
        popupResponse = response;
      };
      const bindPopupDocument = () => {
        if (popupDocument !== undefined || popupPage === undefined || popupResponse === undefined) return false;
        let responsePage: Page;
        try {
          responsePage = popupResponse.frame().page();
        } catch {
          return false;
        }
        if (responsePage !== popupPage || !context.pages().includes(popupPage)) return false;
        const response = popupResponse;
        const request = response.request();
        const url = new URL(request.url());
        if (new URL(popupPage.url()).origin !== platformOrigin || new URL(popupPage.url()).pathname !== connectionPage)
          return false;
        popupDocument = {
          method: request.method(),
          host: url.host,
          path: redact(url.pathname),
          status: response.status(),
          contentType: mediaType(response.headers()["content-type"]),
          locationHost: response.headers().location ? new URL(response.headers().location!, url).host : null,
          at: Date.now(),
        };
        pages.push(popupDocument);
        return true;
      };
      // Arm both signals before the extension creates its tab. Chromium can emit the
      // initial document response before Playwright surfaces the new page event.
      context.on("page", observePopupPage);
      context.on("response", observePopupResponse);
      await page.bringToFront();
      let reopened = false;
      try {
        if (!(await triggerAction(context, page))) fail("connector-drill-page-status");
        reopened = await waitFor(
          () => bindPopupDocument() && popupDocument?.status === 200 && popupDocument.at >= reopenedAt,
        );
      } finally {
        context.off("page", observePopupPage);
        context.off("response", observePopupResponse);
      }
      if (!reopened) fail("connector-drill-page-status");
      const pairedRead = await step(page, "pairing-paired", "GET", pairingApi);
      if (bodyCode(pairedRead.body) !== "paired") fail("connector-drill-pairing-refused");

      // While paused the platform serves no work: at least two claims, each with a null reservation.
      const fire = () => connector.evaluate(() => chrome.alarms.create("connector-work", { when: Date.now() }));
      for (let fires = 0; fires < 4 && claims.filter((claim) => claim.phase === "paused").length < 2; fires++) {
        const seen = claims.length;
        await fire();
        await waitFor(() => claims.length > seen);
      }
      const pausedClaims = claims.filter((claim) => claim.phase === "paused");
      const storedClaimPath = redact(`/channel-connector/oauth/connections/${id}/claim`);
      if (
        pausedClaims.length < 2 ||
        pausedClaims.some(
          (claim) => claim.status !== 200 || claim.reservation !== null || claim.path !== storedClaimPath,
        )
      )
        fail("connector-drill-paused-claim-refused");
      checkIsolation();

      // Unpair on the pairing panel before the next claim fires; that claim is refused and cleanup follows.
      if (!(await open(page, connectionPage))) fail("connector-drill-page-status");
      await page
        .locator(unpairButton)
        .click({ timeout: legMs })
        .catch(() => fail("connector-drill-unpair-refused"));
      await waitFor(async () => bodyCode((await call(page, "GET", pairingApi)).body) === "unpaired");
      const unpaired = await step(page, "pairing-unpaired", "GET", pairingApi);
      if (bodyCode(unpaired.body) !== "unpaired") fail("connector-drill-unpair-refused");
      claimPhase = "unpaired";
      const claimsAtUnpair = claims.length;
      await fire();
      const revoked = await waitFor(async () => (await profileEntry(connector)) === "revoked");
      lifecycle = await readLifecycle(connector);
      const cleanupAt = lifecycle.indexOf("cleanup-pending");
      if (
        !revoked ||
        cleanupAt < 0 ||
        cleanupAt > lifecycle.lastIndexOf("revoked") ||
        !claims.slice(claimsAtUnpair).some((claim) => claim.phase === "unpaired" && claim.status === 401)
      )
        fail("connector-drill-lifecycle-refused");
      const titled = await waitFor(async () => (await actionTitle(connector)) === "revoked");
      const transitional = (
        await connector.evaluate(
          () =>
            (globalThis as typeof globalThis & { connectorDrillDisplay?: DeployedDisplayRow[] })
              .connectorDrillDisplay ?? [],
        )
      ).find((row) => row.state === "cleanup-pending");
      const revokedDisplay = await settledDisplay("revoked");
      display.push(...(transitional ? [transitional] : []), revokedDisplay);
      if (!titled || !transitional || revokedDisplay.title !== "revoked" || revokedDisplay.badge !== "!")
        fail("connector-drill-display-refused");
      paired = {
        connectionIdSuffix: id.slice(-4),
        pairingIdSuffix: pairingId.slice(-4),
        generateToClickMs: clickedAt - generatedAt,
      };
    } catch (error) {
      failure = error;
    }
    // The run owns this connection from connect on, so it is disconnected however the run ends.
    await page.goto(`${platformOrigin}/account/channels`, { timeout: legMs }).catch(() => null);
    const disconnected = await step(page, "disconnect", "POST", `${connectionApi}/disconnect`);
    if (failure !== undefined) throw failure;
    if (!succeeded(disconnected.status) || bodyCode(disconnected.body) !== "disconnected")
      fail("connector-drill-connection-refused");
    checkIsolation();
    const cookies = await inspectCookies(context);
    return { ...paired!, cookies: cookieRows(cookies), heldValues: cookies.map((cookie) => cookie.value) };
  };

  const profilePath = mkdtempSync(join(tmpdir(), "connector-drill-"));
  let context: BrowserContext | undefined;
  let outcome: LegOutcome | undefined;
  let failure: unknown;
  try {
    const launch =
      input.launch ?? ((path: string, options: DrillLaunchOptions) => chromium.launchPersistentContext(path, options));
    context = await launch(profilePath, {
      channel: "chromium",
      headless: false,
      env: drillBrowserEnvironment(),
      args: deployedBrowserArgs(platformOrigin, input.resolver, dist),
    });
    outcome = await (input.smoke ? smokeLeg(context) : pairingLeg(context));
  } catch (error) {
    failure = error;
  }
  try {
    await context?.close();
  } catch {
    // A close failure is judged by the profile deletion below.
  }
  profile = { path: profilePath, deleted: cleanDrillProfile(profilePath) };
  if (!profile.deleted) fail("connector-drill-profile-cleanup-refused");
  if (failure instanceof PairingDrillRefusal) throw new PairingDrillRefusal(failure.code, evidence());
  if (failure !== undefined) throw failure;

  const { heldValues, ...observed } = outcome!;
  const receipt: DeployedPairingDrillReceipt = {
    mode: "deployed",
    kind: input.smoke ? "staging-smoke" : "pairing",
    origin: input.resolver ? "fake" : "staging",
    platformHost,
    deploy: input.preflight!.deploy,
    preflight: input.preflight!.rows,
    personaAlias: input.smoke ? null : input.personaAlias!,
    clientIdSuffix: input.smoke ? null : input.clientId!.slice(-4),
    artifactDigest: input.smoke ? null : input.artifactDigest!,
    extensionId: input.smoke ? null : TCGPLAYER_CONNECTOR_EXTENSION_ID,
    ...observed,
    steps,
    pages,
    claims,
    display,
    lifecycle,
    requests: sorted(requests),
    aborted: sorted(aborted),
    trace: "none",
    profile,
  };
  try {
    retainDeployedReceipt(input.outputDir, receipt, [
      ...retainedSecretMarkers,
      ...(input.secretMarkers ?? []),
      ...heldValues.filter((value) => value.length >= 8),
    ]);
  } catch {
    fail("connector-drill-retained-secret");
  }
  return { receipt };
}
