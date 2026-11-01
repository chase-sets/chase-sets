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
  deployed?: DeployedDrillRows &
    Readonly<{ profile: DeployedDrillProfile | null; claimResponses: readonly DeployedClaimResponseRow[] }>;
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
export const fakeDocumentMarkerName = "connector-drill-response";
export type FakeDocumentResponse = Readonly<{
  sequence: number;
  marker: string;
  host: string;
  path: string;
  method: string;
  status: number;
  session: boolean;
  completed: "finish";
}>;
export type FakeDocumentSource = Readonly<{
  sequence(): number;
  responses(): readonly FakeDocumentResponse[];
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
  /** Completed response authority from the test-owned resolver server, never a live fallback. */
  fakeDocuments?: FakeDocumentSource;
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
  fakeDocument?: Readonly<{
    marker: string;
    sequence: number;
    targetId: string;
    browserContextId: string;
    openerId: string | null;
    mainDocument: true;
    session: true;
    completed: "finish";
  }>;
}>;
export type DeployedClaimRow =
  | Readonly<{
      phase: "paused";
      path: string;
      status: number;
      reservation: null | "present" | "unreadable";
      bodyCode: string | null;
    }>
  /** A post-Unpair 401 is event authority; no body-derived fields enter the success receipt. */
  | Readonly<{ phase: "unpaired"; path: string; status: number }>;
/** Refusal evidence only: a stored-path worker claim response the installed listener saw, and its body's fate. */
export type DeployedClaimResponseRow = Readonly<{
  phase: DeployedClaimRow["phase"];
  status: number;
  body: "pending" | "settled" | "unreadable";
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
  if (input.fakeDocuments && !input.resolver) return "connector-drill-page-status";
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

type RawCdpEvent = Readonly<{
  method: string;
  params: unknown;
  sessionId?: string;
}>;

export type FakePopupBoundary = Readonly<{
  origin: string;
  path: string;
  sourceTargetId: string;
  browserContextId: string;
  targetIds: readonly string[];
  sequence: number;
}>;
export type FakePopupMainDocument = Readonly<{
  targetId: string;
  type: string;
  browserContextId: string;
  openerId: string | null;
  newPage: boolean;
  mainDocument: boolean;
  url: string;
  targetUrl: string;
  documentUrl: string;
  markers: readonly string[];
}>;

/** Two authorities, joined by a server-issued marker. Neither URL nor a completed response alone qualifies. */
export function correlateFakePopupDocument(
  boundary: FakePopupBoundary,
  document: FakePopupMainDocument,
  responses: readonly FakeDocumentResponse[],
): FakeDocumentResponse | undefined {
  const expectedUrl = `${boundary.origin}${boundary.path}`;
  if (!document.newPage) return;
  if (!document.mainDocument) return;
  if (document.type !== "page") return;
  if (!document.targetId || document.targetId === boundary.sourceTargetId) return;
  if (boundary.targetIds.includes(document.targetId)) return;
  if (!boundary.browserContextId || document.browserContextId !== boundary.browserContextId) return;
  if (document.openerId !== null && document.openerId !== boundary.sourceTargetId) return;
  if (document.url !== expectedUrl) return;
  if (document.targetUrl !== document.url) return;
  if (document.documentUrl !== document.url) return;
  if (document.markers.length !== 1) return;
  const marker = document.markers[0];
  if (!marker || !/^[a-f0-9-]{36}$/.test(marker)) return;
  const matches = responses.filter((response) => response.marker === marker);
  if (matches.length !== 1) return;
  const response = matches[0]!;
  if (response.sequence <= boundary.sequence) return;
  if (response.completed !== "finish") return;
  if (response.host !== new URL(boundary.origin).host) return;
  if (response.path !== boundary.path) return;
  if (response.method !== "GET") return;
  if (response.status !== 200) return;
  if (!response.session) return;
  return response;
}

async function fakePairedPage(
  context: BrowserContext,
  source: Page,
  origin: string,
  path: string,
  documents: FakeDocumentSource,
) {
  await source.bringToFront();
  const identity = await context.newCDPSession(source);
  let boundary: FakePopupBoundary;
  let beforePages: Set<Page>;
  try {
    const { targetInfo } = await identity.send("Target.getTargetInfo");
    const { targetInfos } = await identity.send("Target.getTargets");
    beforePages = new Set(context.pages());
    boundary = {
      origin,
      path,
      sourceTargetId: targetInfo.targetId,
      browserContextId: targetInfo.browserContextId ?? "",
      targetIds: targetInfos.map((target) => target.targetId),
      sequence: documents.sequence(),
    };
  } finally {
    await identity.detach();
  }
  // Discovery is armed before the unchanged action, independent of initial response event delivery.
  const surfaced = context.waitForEvent("page", { timeout: legMs }).catch(() => undefined);
  if (!(await triggerAction(context, source))) return;
  const page = await surfaced;
  if (!page || page === source || beforePages.has(page) || page.context() !== context) return;
  await page.waitForLoadState("domcontentloaded", { timeout: legMs });
  const pageIdentity = await context.newCDPSession(page);
  try {
    const { targetInfo } = await pageIdentity.send("Target.getTargetInfo");
    const frame = page.mainFrame();
    // Read the existing MAIN document only. No fetch, injection, navigation or reload is performed.
    const observed = await frame.evaluate(
      (name) => ({
        url: document.location.href,
        top: window === window.top,
        markers: [...document.querySelectorAll(`meta[name="${name}"]`)].map(
          (element) => element.getAttribute("content") ?? "",
        ),
      }),
      fakeDocumentMarkerName,
    );
    const response = correlateFakePopupDocument(
      boundary,
      {
        targetId: targetInfo.targetId,
        type: targetInfo.type,
        browserContextId: targetInfo.browserContextId ?? "",
        openerId: targetInfo.openerId ?? null,
        newPage: !beforePages.has(page) && page.context() === context,
        mainDocument:
          observed.top && frame === page.mainFrame() && frame.parentFrame() === null && frame.page() === page,
        url: page.url(),
        targetUrl: targetInfo.url,
        documentUrl: observed.url,
        markers: observed.markers,
      },
      documents.responses(),
    );
    if (!response) return;
    return {
      response,
      targetId: targetInfo.targetId,
      browserContextId: targetInfo.browserContextId!,
      openerId: targetInfo.openerId ?? null,
    };
  } finally {
    await pageIdentity.detach();
  }
}

/** Hold the tab while instrumenting its child page on the same flattened transport. */
export function createDeployedPopupObserver(
  expected: { sourceTargetId: string; browserContextId?: string; origin: string; path: string },
  transport: RawCdpTransport,
) {
  type Navigation = { frameId: string; loaderId: string; url: string };
  type Request = Navigation & { method: string };
  type Document = Request & { requestId: string; status: number; contentType: string | null; at: number };
  type Target = {
    targetId: string;
    type: string;
    openerId?: string;
    browserContextId?: string;
    sessionId: string;
    parentSessionId?: string;
    waitingForDebugger: boolean;
    newAfterAction: boolean;
    url: string;
    commands: Map<string, "sent" | "ack" | "error">;
    requests: Map<string, Request>;
    documents: Map<string, Document>;
    mainFrame?: Navigation;
    rawDocumentRequests: number;
    rawDocumentResponses: number;
    rejections: Map<string, number>;
  };
  const targets = new Map<string, Target>();
  const sessions = new Map<string, Target>();
  const chronology: Record<string, unknown>[] = [];
  let sequence = 0;
  let failure: string | null = null;
  let rootReady = false;
  let closing = false;
  let page: { targetId: string; url: string } | undefined;
  let preActionTargetIds: ReadonlySet<string> | undefined;
  const record = (entry: Record<string, unknown>) => {
    chronology.push({ order: ++sequence, ...entry });
  };
  const matchesUrl = (value: string) => {
    try {
      const url = new URL(value);
      return url.origin === expected.origin && url.pathname === expected.path;
    } catch {
      return false;
    }
  };
  const location = (value: string) => {
    try {
      const url = new URL(value);
      return {
        host: url.origin === expected.origin ? url.host : "<other-host>",
        path: matchesUrl(value) ? "/account/channels/<connectionId>" : "<other-path>",
      };
    } catch {
      return { host: null, path: null };
    }
  };
  const reject = (reason: string, target?: Target) => {
    const previous = target?.rejections.get(reason) ?? 0;
    if (target) target.rejections.set(reason, previous + 1);
    if (previous === 0) record({ event: "rejected", sessionId: target?.sessionId ?? null, reason });
  };
  const send = (method: string, params: Record<string, unknown> = {}, target?: Target) => {
    const commandOrder = sequence + 1;
    target?.commands.set(method, "sent");
    record({ event: "send", method, sessionId: target?.sessionId ?? null });
    return transport.send(method, params, target?.sessionId).then(
      () => {
        target?.commands.set(method, "ack");
        record({ event: "ack", commandOrder, method, sessionId: target?.sessionId ?? null, ok: true });
        return true;
      },
      () => {
        target?.commands.set(method, "error");
        failure ??= `${method}:command-error`;
        record({ event: "ack", commandOrder, method, sessionId: target?.sessionId ?? null, ok: false });
        return false;
      },
    );
  };
  const autoAttach = (type: "tab" | "page") => ({
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
    filter: [{ type }],
  });
  const observe = (event: RawCdpEvent) => {
    const value = rawCdpRecord(event.params) ? event.params : undefined;
    if (!value) return;
    if (event.method === "Target.attachedToTarget") {
      const info = rawCdpRecord(value.targetInfo) ? value.targetInfo : undefined;
      const parent = event.sessionId === undefined ? undefined : sessions.get(event.sessionId);
      if (event.sessionId !== undefined && parent?.type !== "tab") return reject("unowned-parent");
      if (
        !info ||
        typeof info.targetId !== "string" ||
        typeof info.type !== "string" ||
        typeof value.sessionId !== "string"
      )
        return reject("malformed-attachment");
      const target: Target = {
        targetId: info.targetId,
        type: info.type,
        openerId: typeof info.openerId === "string" ? info.openerId : undefined,
        browserContextId: typeof info.browserContextId === "string" ? info.browserContextId : undefined,
        sessionId: value.sessionId,
        parentSessionId: event.sessionId,
        waitingForDebugger: value.waitingForDebugger === true,
        newAfterAction: preActionTargetIds !== undefined && !preActionTargetIds.has(info.targetId),
        url: typeof info.url === "string" ? info.url : "",
        commands: new Map(),
        requests: new Map(),
        documents: new Map(),
        rawDocumentRequests: 0,
        rawDocumentResponses: 0,
        rejections: new Map(),
      };
      // Register ownership before any asynchronous setup, including rejected targets.
      targets.set(target.targetId, target);
      sessions.set(target.sessionId, target);
      record({
        event: "attached",
        targetId: target.targetId,
        sessionId: target.sessionId,
        parentSessionId: target.parentSessionId ?? null,
        type: target.type,
        browserContextId: target.browserContextId ?? null,
        waitingForDebugger: target.waitingForDebugger,
        newAfterAction: target.newAfterAction,
        ...location(target.url),
      });
      if (target.browserContextId !== expected.browserContextId) reject("wrong-context", target);
      if (!target.newAfterAction) reject("pre-action-target", target);
      if (target.targetId === expected.sourceTargetId) reject("source-target", target);
      if (target.openerId !== undefined && target.openerId !== expected.sourceTargetId) reject("wrong-opener", target);
      if (closing || target.type !== (parent ? "page" : "tab")) {
        reject("wrong-target-type", target);
        void send("Runtime.runIfWaitingForDebugger", {}, target);
      } else if (!parent) {
        void send("Target.setAutoAttach", autoAttach("page"), target);
      } else {
        // Renderer replies may wait for the held tab. Dispatch instrumentation
        // first, then both resumes, and require all replies at acceptance.
        void send("Network.enable", {}, target);
        void send("Page.enable", {}, target);
        void send("Runtime.runIfWaitingForDebugger", {}, target);
        void send("Runtime.runIfWaitingForDebugger", {}, parent);
      }
      return;
    }
    if (event.method === "Target.targetInfoChanged") {
      const info = rawCdpRecord(value.targetInfo) ? value.targetInfo : undefined;
      const target = typeof info?.targetId === "string" ? targets.get(info.targetId) : undefined;
      if (target && typeof info?.url === "string") target.url = info.url;
      return;
    }
    const target = event.sessionId === undefined ? undefined : sessions.get(event.sessionId);
    if (!target || target.type !== "page" || target.parentSessionId === undefined) {
      if (event.method.startsWith("Network.")) reject("unowned-page-session");
      return;
    }
    if (event.method === "Page.frameNavigated") {
      const frame = rawCdpRecord(value.frame) ? value.frame : undefined;
      if (
        frame &&
        frame.parentId === undefined &&
        typeof frame.id === "string" &&
        typeof frame.loaderId === "string" &&
        typeof frame.url === "string"
      ) {
        target.mainFrame = { frameId: frame.id, loaderId: frame.loaderId, url: frame.url };
        record({
          event: "main-frame",
          sessionId: target.sessionId,
          frameId: frame.id,
          loaderId: frame.loaderId,
          ...location(frame.url),
        });
      }
      return;
    }
    if (event.method !== "Network.requestWillBeSent" && event.method !== "Network.responseReceived") return;
    if (value.type !== "Document") return reject("non-document", target);
    if (event.method === "Network.requestWillBeSent") target.rawDocumentRequests++;
    else target.rawDocumentResponses++;
    record({
      event: event.method,
      sessionId: target.sessionId,
      requestId: typeof value.requestId === "string" ? value.requestId : null,
      frameId: typeof value.frameId === "string" ? value.frameId : null,
      loaderId: typeof value.loaderId === "string" ? value.loaderId : null,
    });
    if (typeof value.requestId !== "string" || typeof value.frameId !== "string" || typeof value.loaderId !== "string")
      return reject("missing-navigation-identity", target);
    if (event.method === "Network.requestWillBeSent") {
      const request = rawCdpRecord(value.request) ? value.request : undefined;
      if (typeof request?.method !== "string" || typeof request.url !== "string")
        return reject("malformed-request", target);
      target.requests.set(value.requestId, {
        method: request.method,
        url: request.url,
        frameId: value.frameId,
        loaderId: value.loaderId,
      });
      record({
        event: "request",
        sessionId: target.sessionId,
        requestId: value.requestId,
        method: request.method,
        ...location(request.url),
      });
    } else {
      const response = rawCdpRecord(value.response) ? value.response : undefined;
      const request = target.requests.get(value.requestId);
      if (!request) return reject("missing-request", target);
      if (
        !response ||
        typeof response.url !== "string" ||
        typeof response.status !== "number" ||
        typeof response.mimeType !== "string"
      )
        return reject("malformed-response", target);
      if (request.frameId !== value.frameId || request.loaderId !== value.loaderId || request.url !== response.url)
        return reject("request-response-identity", target);
      target.documents.set(value.requestId, {
        ...request,
        requestId: value.requestId,
        status: response.status,
        contentType: mediaType(response.mimeType),
        at: Date.now(),
      });
      record({
        event: "matched-response",
        sessionId: target.sessionId,
        requestId: value.requestId,
        frameId: value.frameId,
        loaderId: value.loaderId,
        status: response.status,
        ...location(response.url),
        fromDiskCache: response.fromDiskCache === true,
        fromServiceWorker: response.fromServiceWorker === true,
        fromPrefetchCache: response.fromPrefetchCache === true,
      });
    }
  };
  return {
    targets,
    get failure() {
      return failure;
    },
    async start() {
      transport.on(observe);
      rootReady = await send("Target.setAutoAttach", autoAttach("tab"));
      return rootReady;
    },
    startAction(targetIds: readonly string[]) {
      preActionTargetIds = new Set(targetIds);
      record({ event: "action-armed", existingTargetCount: targetIds.length });
    },
    bindPage(targetId: string, url: string) {
      page = { targetId, url };
    },
    document() {
      const target = page ? targets.get(page.targetId) : undefined;
      const tab = target?.parentSessionId ? sessions.get(target.parentSessionId) : undefined;
      const acknowledged = (owner: Target | undefined, methods: string[]) =>
        !!owner && methods.every((method) => owner.commands.get(method) === "ack");
      if (
        !rootReady ||
        failure ||
        !page ||
        !target ||
        !tab ||
        tab.type !== "tab" ||
        !tab.newAfterAction ||
        !tab.waitingForDebugger ||
        tab.browserContextId !== expected.browserContextId ||
        !acknowledged(tab, ["Target.setAutoAttach", "Runtime.runIfWaitingForDebugger"]) ||
        !acknowledged(target, ["Network.enable", "Page.enable", "Runtime.runIfWaitingForDebugger"]) ||
        target.targetId !== page.targetId ||
        target.targetId === expected.sourceTargetId ||
        target.type !== "page" ||
        !target.newAfterAction ||
        (target.openerId !== undefined && target.openerId !== expected.sourceTargetId) ||
        target.browserContextId !== expected.browserContextId
      )
        return;
      const document = [...target.documents.values()].find(
        (candidate) =>
          candidate.method === "GET" &&
          candidate.status === 200 &&
          matchesUrl(candidate.url) &&
          target.url === candidate.url &&
          page?.url === candidate.url &&
          target.mainFrame?.frameId === candidate.frameId &&
          target.mainFrame.loaderId === candidate.loaderId &&
          target.mainFrame.url === candidate.url,
      );
      if (!document) {
        if (!target.rejections.has("document-page-frame-loader-binding"))
          reject("document-page-frame-loader-binding", target);
        return;
      }
      return {
        ...document,
        targetId: target.targetId,
        sessionId: target.sessionId,
        openerId: target.openerId,
        tabTargetId: tab.targetId,
        tabSessionId: tab.sessionId,
      };
    },
    diagnostic() {
      return {
        failure,
        chronology: [...chronology],
        targets: [...sessions.values()].map((target) => ({
          targetId: target.targetId,
          type: target.type,
          sessionId: target.sessionId,
          parentSessionId: target.parentSessionId ?? null,
          browserContextId: target.browserContextId ?? null,
          openerId: target.openerId ?? null,
          waitingForDebugger: target.waitingForDebugger,
          newAfterAction: target.newAfterAction,
          ...location(target.url),
          rawDocumentRequests: target.rawDocumentRequests,
          rawDocumentResponses: target.rawDocumentResponses,
          commands: Object.fromEntries(target.commands),
          mainFrame: target.mainFrame
            ? {
                frameId: target.mainFrame.frameId,
                loaderId: target.mainFrame.loaderId,
                ...location(target.mainFrame.url),
              }
            : null,
          rejections: Object.fromEntries(target.rejections),
        })),
      };
    },
    async close() {
      closing = true;
      try {
        // Release every owned wait before disabling auto-attach (which can detach).
        const owned = [...sessions.values()];
        await Promise.all(owned.map((target) => send("Runtime.runIfWaitingForDebugger", {}, target)));
        for (const target of owned.filter((candidate) => candidate.type === "tab")) {
          for (const child of owned.filter((candidate) => candidate.parentSessionId === target.sessionId))
            await send("Target.detachFromTarget", { sessionId: child.sessionId }, target);
          await send(
            "Target.setAutoAttach",
            { autoAttach: false, waitForDebuggerOnStart: false, flatten: true },
            target,
          );
        }
        for (const target of owned.filter((candidate) => candidate.parentSessionId === undefined))
          await send("Target.detachFromTarget", { sessionId: target.sessionId });
        await send("Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false, flatten: true });
      } finally {
        transport.off(observe);
        await transport.close();
      }
    },
  };
}

type RawCdpTransport = Readonly<{
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
  on(listener: (event: RawCdpEvent) => void): void;
  off(listener: (event: RawCdpEvent) => void): void;
  close(): Promise<void>;
}>;

const rawCdpRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Playwright's CDP wrapper drops flattened child session IDs before they can be
 * addressed. This deliberately small adapter keeps the browser WebSocket's
 * sessionId on both commands and events instead of casting around that API.
 */
export async function openRawCdpTransport(profilePath: string): Promise<RawCdpTransport> {
  const activePort = readFileSync(join(profilePath, "DevToolsActivePort"), "utf8").split(/\r?\n/, 1)[0]?.trim();
  if (!activePort || !/^\d+$/.test(activePort)) throw new Error("browser-cdp-port-missing");
  const versionResponse = await fetch(`http://127.0.0.1:${activePort}/json/version`);
  if (!versionResponse.ok) throw new Error("browser-cdp-version-refused");
  const version: unknown = await versionResponse.json();
  if (!rawCdpRecord(version) || typeof version.webSocketDebuggerUrl !== "string")
    throw new Error("browser-cdp-websocket-missing");
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const listeners = new Set<(event: RawCdpEvent) => void>();
  let sequence = 0;
  let closed = false;
  const rejectPending = (message: string) => {
    for (const call of pending.values()) call.reject(new Error(message));
    pending.clear();
  };
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    let message: unknown;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!rawCdpRecord(message)) return;
    if (typeof message.id === "number") {
      const call = pending.get(message.id);
      if (!call) return;
      pending.delete(message.id);
      if (rawCdpRecord(message.error) && typeof message.error.message === "string")
        call.reject(new Error(message.error.message));
      else call.resolve(message.result);
      return;
    }
    if (typeof message.method !== "string") return;
    const params = "params" in message ? message.params : undefined;
    const sessionId = typeof message.sessionId === "string" ? message.sessionId : undefined;
    for (const listener of listeners) listener({ method: message.method, params, sessionId });
  });
  socket.addEventListener("close", () => {
    closed = true;
    rejectPending("browser-cdp-closed");
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("browser-cdp-websocket-refused")), { once: true });
  });
  const sendRaw = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
    if (closed || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("browser-cdp-closed"));
    const id = ++sequence;
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
    });
  };
  return {
    send(method, params = {}, sessionId) {
      return sendRaw(method, params, sessionId);
    },
    on(listener) {
      listeners.add(listener);
    },
    off(listener) {
      listeners.delete(listener);
    },
    async close() {
      if (closed) return;
      closed = true;
      listeners.clear();
      rejectPending("browser-cdp-closed");
      socket.close();
    },
  };
}

/** Owns the deployed browser response subscription for the whole drill, not just the popup action. */
export function installDeployedResponses(
  context: BrowserContext,
  input: Readonly<{
    platformOrigin: string;
    connectionId(): string | null;
    phase(): DeployedClaimRow["phase"];
    pages: DeployedPageRow[];
    claims: DeployedClaimRow[];
    responses: DeployedClaimResponseRow[];
  }>,
) {
  let closed = false;
  const pageListeners = new Map<Page, (response: BrowserResponse) => void>();
  const redact = (path: string) => {
    const id = input.connectionId();
    return id ? path.replaceAll(id, "<connectionId>") : path;
  };
  const observe = async (response: BrowserResponse) => {
    const request = response.request();
    const url = new URL(request.url());
    if (url.origin !== input.platformOrigin) return;
    if (!request.serviceWorker() && request.resourceType() === "document") {
      const headers = response.headers();
      input.pages.push({
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
    const id = input.connectionId();
    if (
      !request.serviceWorker() ||
      !id ||
      request.method() !== "POST" ||
      url.pathname !== `/channel-connector/oauth/connections/${id}/claim`
    )
      return;
    const phase = input.phase();
    const path = redact(url.pathname);
    const status = response.status();
    // Seen before its body settles, so a refusal tells a late body from an absent response.
    const observed = input.responses.push({ phase, status, body: "pending" }) - 1;
    // The product coordinator intentionally returns on a non-OK claim without
    // reading its body. The browser event is therefore the post-Unpair
    // authority; retain only the redacted phase/path/status row in a receipt.
    if (phase === "unpaired" && status === 401) input.claims.push({ phase, path, status });
    const body: unknown = await response.json().catch(() => undefined);
    if (closed) return;
    input.responses[observed] = { phase, status, body: body === undefined ? "unreadable" : "settled" };
    if (phase === "unpaired" && status === 401) return;
    input.claims.push({
      phase,
      path,
      status,
      reservation:
        isRecord(body) && "reservation" in body ? (body.reservation === null ? null : "present") : "unreadable",
      bodyCode: bodyCode(body),
    });
  };
  const observeWorker = (response: BrowserResponse) => {
    if (response.request().serviceWorker()) void observe(response).catch(() => undefined);
  };
  const observePage = (page: Page) => {
    if (pageListeners.has(page)) return;
    const listener = (response: BrowserResponse) => {
      // Context owns worker responses; Page alone owns ordinary documents.
      if (!response.request().serviceWorker()) void observe(response).catch(() => undefined);
    };
    pageListeners.set(page, listener);
    page.on("response", listener);
  };
  context.on("response", observeWorker);
  for (const page of context.pages()) observePage(page);
  context.on("page", observePage);
  return () => {
    closed = true;
    context.off("response", observeWorker);
    context.off("page", observePage);
    for (const [page, listener] of pageListeners) page.off("response", listener);
    pageListeners.clear();
  };
}

export function deployedPausedClaimsValid(claims: readonly DeployedClaimRow[], storedClaimPath: string) {
  const pausedClaims = claims.filter((claim) => claim.phase === "paused");
  return (
    pausedClaims.length >= 2 &&
    pausedClaims.every((claim) => claim.status === 200 && claim.reservation === null && claim.path === storedClaimPath)
  );
}

export function deployedUnpairedClaimObserved(
  responses: readonly DeployedClaimResponseRow[],
  responsesAtUnpair: number,
) {
  return responses
    .slice(responsesAtUnpair)
    .some((response) => response.phase === "unpaired" && response.status === 401);
}

async function deployedDrill(input: DeployedPairingDrillInput): Promise<{ receipt: DeployedPairingDrillReceipt }> {
  const { platformOrigin } = input;
  const platformHost = new URL(platformOrigin).host;
  const requests = new Map<string, DrillRequestRow>();
  const aborted = new Map<string, DrillRequestRow>();
  const steps: DeployedStepRow[] = [];
  const pages: DeployedPageRow[] = [];
  const claims: DeployedClaimRow[] = [];
  const claimResponses: DeployedClaimResponseRow[] = [];
  const display: DeployedDisplayRow[] = [];
  const isolation = { tcgplayer: 0, workerEscapes: 0, connectionWrites: 0 };
  let lifecycle: readonly string[] = [];
  let profile: DeployedDrillProfile | null = null;
  let connectionId: string | null = null;
  let claimPhase: DeployedClaimRow["phase"] = "paused";
  let removeResponses: (() => void) | undefined;
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
      claimResponses: [...claimResponses],
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
  const install = async (context: BrowserContext) => {
    removeResponses = installDeployedResponses(context, {
      platformOrigin,
      connectionId: () => connectionId,
      phase: () => claimPhase,
      pages,
      claims,
      responses: claimResponses,
    });
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
      if (input.resolver) {
        if (!input.fakeDocuments) fail("connector-drill-page-status");
        const joined = await fakePairedPage(context, page, platformOrigin, connectionPage, input.fakeDocuments).catch(
          () => undefined,
        );
        if (!joined) fail("connector-drill-page-status");
        const { response, targetId, browserContextId, openerId } = joined;
        const fakeDocument = {
          marker: response.marker,
          sequence: response.sequence,
          targetId,
          browserContextId,
          openerId,
          mainDocument: true,
          session: true,
          completed: "finish",
        } as const;
        pages.push({
          method: response.method,
          host: response.host,
          path: redact(response.path),
          status: response.status,
          contentType: "text/html",
          locationHost: null,
          at: Date.now(),
          fakeDocument,
        });
        console.log(
          `CONNECTOR_DRILL_FAKE_DOCUMENT ${JSON.stringify({
            origin: "fake",
            method: response.method,
            host: response.host,
            path: redact(response.path),
            status: response.status,
            ...fakeDocument,
          })}`,
        );
      } else {
        let popupPage: Page | undefined;
        let popupResponse: BrowserResponse | undefined;
        let popupDocument: DeployedPageRow | undefined;
        let popupTargetId: string | undefined;
        let popupTargetError: string | null = null;
        const rawBrowserCdp = await openRawCdpTransport(profilePath);
        try {
          const sourceIdentity = await context.newCDPSession(page);
          let sourceTargetInfo;
          try {
            sourceTargetInfo = (await sourceIdentity.send("Target.getTargetInfo")).targetInfo;
          } finally {
            await sourceIdentity.detach();
          }
          if (!rawCdpRecord(sourceTargetInfo) || typeof sourceTargetInfo.targetId !== "string") {
            fail("connector-drill-page-status");
          }
          const sourceTargetId = sourceTargetInfo.targetId;
          const sourceBrowserContextId =
            typeof sourceTargetInfo.browserContextId === "string" ? sourceTargetInfo.browserContextId : undefined;
          const popupObserver = createDeployedPopupObserver(
            {
              sourceTargetId,
              browserContextId: sourceBrowserContextId,
              origin: platformOrigin,
              path: connectionPage,
            },
            rawBrowserCdp,
          );
          const popupTargets = popupObserver.targets;
          let preActionPages = new Set(context.pages());
          const bindPopupPage = async () => {
            if (popupPage !== undefined) return true;
            const candidate = context
              .pages()
              .find(
                (value) =>
                  value !== page &&
                  !preActionPages.has(value) &&
                  new URL(value.url()).origin === platformOrigin &&
                  new URL(value.url()).pathname === connectionPage,
              );
            if (!candidate) return false;
            // This later session identifies the surfaced page only. Network evidence
            // still comes exclusively from the originally auto-attached raw session.
            const identity = await context.newCDPSession(candidate);
            let targetId: string;
            try {
              targetId = (await identity.send("Target.getTargetInfo")).targetInfo.targetId;
            } finally {
              await identity.detach();
            }
            if (!popupTargets.get(targetId)?.newAfterAction) {
              popupTargetError = "popup-target-binding-refused";
              return false;
            }
            popupTargetId = targetId;
            popupPage = candidate;
            popupObserver.bindPage(targetId, candidate.url());
            return true;
          };
          const observePopupResponse = (response: BrowserResponse) => {
            if (popupDocument !== undefined) return;
            const request = response.request();
            if (request.resourceType() !== "document") return;
            const url = new URL(request.url());
            if (url.origin !== platformOrigin || url.pathname !== connectionPage) return;
            // Corroboration only: this response cannot satisfy the raw target proof.
            popupResponse = response;
          };
          const bindPopupDocument = () => {
            if (popupDocument !== undefined || popupPage === undefined || popupTargetId === undefined) return false;
            popupObserver.bindPage(popupTargetId, popupPage.url());
            const document = popupObserver.document();
            if (!document) return false;
            popupDocument = pages.find(
              (row) =>
                row.host === new URL(document.url).host && row.path === redact(connectionPage) && row.at >= reopenedAt,
            );
            if (!popupDocument) {
              popupDocument = {
                method: document.method,
                host: new URL(document.url).host,
                path: redact(new URL(document.url).pathname),
                status: document.status,
                contentType: document.contentType,
                locationHost: null,
                at: document.at,
              };
              pages.push(popupDocument);
            }
            console.log(
              `CONNECTOR_DRILL_POPUP_DOCUMENT ${JSON.stringify({
                targetId: document.targetId,
                sessionId: document.sessionId,
                tabTargetId: document.tabTargetId,
                tabSessionId: document.tabSessionId,
                requestId: document.requestId,
                frameId: document.frameId,
                loaderId: document.loaderId,
                openerId: document.openerId ?? null,
                browserContextId: popupTargets.get(document.targetId)?.browserContextId ?? null,
                newAfterAction: popupTargets.get(document.targetId)?.newAfterAction,
                method: document.method,
                resourceType: "Document",
                origin: new URL(document.url).origin,
                path: redact(new URL(document.url).pathname),
                storedPathMatched: new URL(document.url).pathname === connectionPage,
                status: document.status,
                pageTargetId: popupTargetId,
                pageUrl: `${new URL(popupPage.url()).origin}${redact(new URL(popupPage.url()).pathname)}`,
                pageUrlMatched: popupPage.url() === document.url,
              })}`,
            );
            return true;
          };
          // Arm corroboration before the action; the raw attached session is authoritative.
          context.on("response", observePopupResponse);
          let reopened = false;
          try {
            if (!(await popupObserver.start())) fail("connector-drill-page-status");
            await page.bringToFront();
            const preActionTargets = await rawBrowserCdp.send("Target.getTargets", {
              filter: [{ type: "tab" }, { type: "page" }],
            });
            if (!rawCdpRecord(preActionTargets) || !Array.isArray(preActionTargets.targetInfos))
              fail("connector-drill-page-status");
            const preActionTargetIds: string[] = [];
            for (const info of preActionTargets.targetInfos) {
              if (
                !rawCdpRecord(info) ||
                (info.type !== "page" && info.type !== "tab") ||
                typeof info.targetId !== "string"
              )
                fail("connector-drill-page-status");
              preActionTargetIds.push(info.targetId);
            }
            preActionPages = new Set(context.pages());
            popupObserver.startAction(preActionTargetIds);
            // Chromium's WebSocket client refuses unsafe extension operations. Use
            // Playwright's launch-pipe action while raw child-session routing stays armed.
            if (!(await triggerAction(context, page))) fail("connector-drill-pairing-refused");
            reopened = await waitFor(
              async () =>
                !popupObserver.failure &&
                (await bindPopupPage()) &&
                bindPopupDocument() &&
                popupDocument?.status === 200 &&
                popupDocument.at >= reopenedAt,
            );
          } finally {
            context.off("response", observePopupResponse);
            try {
              await popupObserver.close();
            } finally {
              console.log(
                `CONNECTOR_DRILL_POPUP_CHRONOLOGY ${JSON.stringify({
                  ...popupObserver.diagnostic(),
                  accepted: reopened && !popupObserver.failure,
                  responseSeen: popupResponse !== undefined,
                  responseStatus: popupResponse?.status() ?? null,
                  pageEventSeen: popupPage !== undefined,
                  cdpTargetId: popupTargetId ?? null,
                  cdpSessionId: popupTargets.get(popupTargetId ?? "")?.sessionId ?? null,
                  cdpTargetError: popupTargetError,
                })}`,
              );
            }
          }
          if (!reopened || popupObserver.failure) fail("connector-drill-page-status");
        } finally {
          await rawBrowserCdp.close();
        }
      }
      const pairedRead = await step(page, "pairing-paired", "GET", pairingApi);
      if (bodyCode(pairedRead.body) !== "paired") fail("connector-drill-pairing-refused");

      // While paused the platform serves no work: at least two claims, each with a null reservation.
      const fire = () => connector.evaluate(() => chrome.alarms.create("connector-work", { when: Date.now() }));
      for (let fires = 0; fires < 4 && claims.filter((claim) => claim.phase === "paused").length < 2; fires++) {
        const seen = claims.length;
        await fire();
        await waitFor(() => claims.length > seen);
      }
      const storedClaimPath = redact(`/channel-connector/oauth/connections/${id}/claim`);
      if (!deployedPausedClaimsValid(claims, storedClaimPath)) fail("connector-drill-paused-claim-refused");
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
      const responsesAtUnpair = claimResponses.length;
      await fire();
      // Revocation and the browser's own collected 401 land in either order; the leg consumes both.
      const settled = await waitFor(
        async () =>
          (await profileEntry(connector)) === "revoked" &&
          deployedUnpairedClaimObserved(claimResponses, responsesAtUnpair),
      );
      lifecycle = await readLifecycle(connector);
      const cleanupAt = lifecycle.indexOf("cleanup-pending");
      if (!settled || cleanupAt < 0 || cleanupAt > lifecycle.lastIndexOf("revoked"))
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
      args: [...deployedBrowserArgs(platformOrigin, input.resolver, dist), "--remote-debugging-port=0"],
    });
    outcome = await (input.smoke ? smokeLeg(context) : pairingLeg(context));
  } catch (error) {
    failure = error;
  }
  removeResponses?.();
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
