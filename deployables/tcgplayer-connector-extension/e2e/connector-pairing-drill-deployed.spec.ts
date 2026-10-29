import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";
import { expect, test, type BrowserContext } from "@playwright/test";
import { linkIntentOrigins } from "@chase-sets/platform-runtime/link-intents";
import { TCGPLAYER_CONNECTOR_EXTENSION_ID, TCGPLAYER_CONNECTOR_REDIRECT_URI } from "@chase-sets/channels/client";
import {
  drillTestCertificate,
  stagingFakePlatform,
  stagingSynthetic,
  synthetic,
  type StagingFakeOptions,
} from "./loopback-platform";
import { scanRetainedArtifacts } from "./retained-artifacts";
import {
  deployedRequiredIssues,
  digestConnectorDist,
  PairingDrillRefusal,
  providerEnvironmentPattern,
  retainedSecretMarkers,
  type DeployedPairingDrillReceipt,
  type PairingDrillDeployBinding,
} from "./pairing-drill";
import { runStagingDrill, stagingReceiptComment } from "./pairing-drill-staging";

// The drill refuses an active trace; automatic tracing would also retain its secret setup.
test.use({ trace: "off", screenshot: "off", video: "off" });
test.describe.configure({ mode: "serial" });

const packageRoot = resolve(import.meta.dirname, "..");
const staging = linkIntentOrigins["marketplace-web"].staging;
const stagingHost = new URL(staging).host;
const canary = "https://connector-drill.invalid";
const plantedAsset = "https://assets.drill.invalid/app.css";
const run = "1";
const commit = `${"0".repeat(39)}1`;
const restored = new Map<string, string | undefined>();
let dist: string;
let digest: string;

test.beforeAll(async () => {
  for (const key of Object.keys(process.env))
    if (providerEnvironmentPattern.test(key)) {
      restored.set(key, process.env[key]);
      delete process.env[key];
    }
  for (const key of ["VITE_PLATFORM_API_URL", "PLATFORM_API_URL", "VITE_CONNECTOR_CLIENT_ID"])
    if (!restored.has(key)) restored.set(key, process.env[key]);
  delete process.env.VITE_PLATFORM_API_URL;
  delete process.env.PLATFORM_API_URL;
  // The staging artifact, built exactly as the handoff builds it, with an unmistakably synthetic client.
  process.env.VITE_CONNECTOR_CLIENT_ID = stagingSynthetic.clientId;
  dist = mkdtempSync(join(tmpdir(), "connector-drill-staging-dist-"));
  await build({
    root: packageRoot,
    configFile: resolve(packageRoot, "vite.config.ts"),
    configLoader: "runner",
    mode: "connector-staging",
    build: { outDir: dist, emptyOutDir: true },
    logLevel: "warn",
  });
  digest = digestConnectorDist(dist);
});

test.afterAll(() => {
  for (const [key, value] of restored) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (dist) rmSync(dist, { recursive: true, force: true });
});

/** A synthetic deploy binding: run 1 at commit 0…1, every required merge contained, floor at the run itself. */
const syntheticBinding = (): PairingDrillDeployBinding => ({
  runId: run,
  runAttempt: 1,
  jobId: "1",
  jobCompletedAt: "2026-01-01T00:00:00Z",
  deployedHead: commit,
  requiredMerges: deployedRequiredIssues.pairing.map((issue) => ({
    issue,
    pullRequest: issue,
    mergeCommit: "0".repeat(40),
    contained: true,
  })),
  receiptFloorRunId: run,
});
const pairingArgs = () => [
  "--deploy-run",
  run,
  "--deploy-commit",
  commit,
  "--platform-origin",
  staging,
  "--client-id",
  stagingSynthetic.clientId,
  "--artifact-digest",
  digest,
  "--persona-alias",
  stagingSynthetic.personaAlias,
];
const smokeArgs = (origin = staging) => [
  "--smoke",
  "--deploy-run",
  run,
  "--deploy-commit",
  commit,
  "--platform-origin",
  origin,
];
/** The served pairing panel: Generate always, Unpair while a code or pairing exists, posting `intent` like the product panel. */
const pairingPanel: NonNullable<StagingFakeOptions["pairingPanel"]> = ({ state, pairingId, revision }) =>
  [
    `<p>${state}</p>`,
    '<form method="post"><input type="hidden" name="intent" value="connector-code"><button type="submit">Generate</button></form>',
    state === "code" || state === "paired"
      ? `<form method="post"><input type="hidden" name="intent" value="connector-unpair"><input type="hidden" name="pairingId" value="${pairingId}"><input type="hidden" name="revision" value="${revision}"><button type="submit">Unpair</button></form>`
      : "",
  ].join("");
const sessionSignIn = (context: BrowserContext) =>
  context.addCookies([
    {
      name: synthetic.cookieName,
      value: synthetic.cookieValue,
      url: staging,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ]);

type CommandSetup = StagingFakeOptions & {
  argv?: readonly string[];
  signIn?: (context: BrowserContext) => Promise<void>;
  /** One-variable trust control: Chromium is handed another certificate's SPKI; Node keeps the fake's PEM. */
  untrusted?: boolean;
  traceActive?: boolean;
};

/** Runs the composed `pairing-drill:staging` command against a fresh fake staging host with a fake `signIn`. */
async function stagingCommand(name: string, setup: CommandSetup = {}) {
  const fake = await stagingFakePlatform({ pairingPanel, ...setup });
  const signIns: string[] = [];
  const outputDir = test.info().outputPath(`receipt-${name}`);
  try {
    const outcome = await runStagingDrill(setup.argv ?? pairingArgs(), {
      resolveDeployBinding: async () => ({ binding: syntheticBinding() }),
      async signIn(context, alias) {
        signIns.push(alias);
        await (setup.signIn ?? sessionSignIn)(context);
      },
      dist,
      outputDir,
      resolver: setup.untrusted
        ? { ...fake.resolver, certificateSpki: drillTestCertificate().certificateSpki }
        : fake.resolver,
      fakeDocuments: fake.documents,
      secretMarkers: [synthetic.cookieValue],
      traceActive: setup.traceActive,
    }).then(
      ({ receipt }) => ({ receipt, error: undefined }),
      (error: unknown) => ({ receipt: undefined, error }),
    );
    if (outcome.error instanceof PairingDrillRefusal)
      console.log(
        `CONNECTOR_DRILL_REFUSAL ${JSON.stringify({ case: name, code: outcome.error.code, evidence: outcome.error.evidence, server: fake.rows() })}`,
      );
    return {
      ...outcome,
      signIns,
      outputDir,
      rows: fake.rows(),
      documents: fake.documents.responses(),
      connections: fake.connections(),
      pairing: fake.pairing(),
      forbidden: fake.forbidden(),
    };
  } finally {
    await fake.close();
  }
}

function refusal(outcome: Awaited<ReturnType<typeof stagingCommand>>) {
  expect(outcome.error).toBeInstanceOf(PairingDrillRefusal);
  const refused = outcome.error as PairingDrillRefusal;
  // Every refusal still deletes the drill profile.
  expect(refused.evidence.deployed?.profile?.deleted ?? true).toBe(true);
  return refused;
}
const milestones = (rows: Awaited<ReturnType<typeof stagingCommand>>["rows"]) =>
  rows
    .filter(
      (row) =>
        row.browser &&
        ["connect", "activate", "pause", "code", "authorize", "token", "claim", "unpair", "disconnect"].includes(
          row.step,
        ),
    )
    .map((row) => `${row.step}:${row.status}`)
    .join(",");

test("connector-pairing-drill-deployed composed staging command against the fake seam (aborted stylesheet control)", async () => {
  // Bounded waits: pairing, two paused claims, unpair and cleanup each stop within their 10 s legs.
  // The planted stylesheet is aborted; only the completed response joined to the MAIN document can qualify.
  test.setTimeout(180_000);
  const outcome = await stagingCommand("pairing", { pageSubresource: plantedAsset });
  expect(outcome.error).toBeUndefined();
  const receipt = outcome.receipt as DeployedPairingDrillReceipt;
  const [connection] = outcome.connections;
  const documents = receipt.pages.filter((row) => row.fakeDocument);
  expect(documents).toHaveLength(1);
  const document = documents[0]!;
  const completed = outcome.documents.filter((row) => row.marker === document.fakeDocument!.marker);
  expect(completed).toHaveLength(1);
  expect(completed[0]).toMatchObject({
    sequence: document.fakeDocument!.sequence,
    method: "GET",
    status: 200,
    session: true,
    completed: "finish",
    host: stagingHost,
    path: `/account/channels/${connection.connectionId}`,
  });
  expect(document.fakeDocument).toMatchObject({ mainDocument: true, session: true, completed: "finish" });
  expect(new Set(outcome.documents.map((row) => row.marker)).size).toBe(outcome.documents.length);

  // AC1: the deploy binding and the three edge rows, recorded before launch.
  expect(receipt.deploy).toEqual(syntheticBinding());
  expect(
    receipt.preflight.map(({ row, status, bodyCode, locationHost, errorDescription }) => ({
      row,
      status,
      bodyCode,
      locationHost,
      errorDescription,
    })),
  ).toEqual([
    { row: "mount", status: 400, bodyCode: "invalid-request", locationHost: null, errorDescription: null },
    {
      row: "client",
      status: 302,
      bodyCode: null,
      locationHost: new URL(TCGPLAYER_CONNECTOR_REDIRECT_URI).host,
      errorDescription: "authorization_refused",
    },
    { row: "unregistered-client", status: 400, bodyCode: "invalid-client", locationHost: null, errorDescription: null },
  ]);

  // AC5: the composed command ran through the fake seam with the fake sign-in, and can never post as staging.
  expect(receipt).toMatchObject({
    mode: "deployed",
    kind: "pairing",
    origin: "fake",
    platformHost: stagingHost,
    personaAlias: stagingSynthetic.personaAlias,
    clientIdSuffix: stagingSynthetic.clientId.slice(-4),
    artifactDigest: digest,
    extensionId: TCGPLAYER_CONNECTOR_EXTENSION_ID,
    connectionIdSuffix: connection.connectionId.slice(-4),
    pairingIdSuffix: outcome.pairing.pairingId!.slice(-4),
    trace: "none",
  });
  expect(outcome.signIns).toEqual([stagingSynthetic.personaAlias]);
  expect(() => stagingReceiptComment(receipt)).toThrow("connector-drill-fake-receipt-refused");

  // AC3: the owned lifecycle in Q2 order, from connect through disconnect, on the stored connection.
  expect(receipt.steps.map(({ step, status, bodyCode }) => [step, status, bodyCode])).toEqual([
    ["list-connections", 200, null],
    ["storage-locations", 200, null],
    ["connect", 200, "pending-setup"],
    ["activate", 200, "active"],
    ["pause", 200, "paused"],
    ["pairing-before-code", 200, "unpaired"],
    ["pairing-code", 200, "code"],
    ["pairing-paired", 200, "paired"],
    ["pairing-unpaired", 200, "unpaired"],
    ["disconnect", 200, "disconnected"],
  ]);
  expect(receipt.steps.find((row) => row.step === "activate")?.path).toBe(
    "/api/channels/connections/<connectionId>/activate",
  );
  expect(milestones(outcome.rows)).toMatch(
    /^connect:200,activate:200,pause:200,code:303,authorize:302,token:200,(claim:200,){2,}unpair:303,(claim:401,)+disconnect:200$/,
  );
  expect(connection).toMatchObject({
    status: "disconnected",
    storageLocationIds: [stagingSynthetic.storageLocationId],
  });
  const paused = receipt.claims.filter((claim) => claim.phase === "paused");
  expect(paused.length).toBeGreaterThanOrEqual(2);
  for (const claim of paused)
    expect(claim).toEqual({
      phase: "paused",
      path: "/channel-connector/oauth/connections/<connectionId>/claim",
      status: 200,
      reservation: null,
      bodyCode: null,
    });
  expect(receipt.claims.filter(({ phase }) => phase === "unpaired")).toEqual([
    { phase: "unpaired", path: "/channel-connector/oauth/connections/<connectionId>/claim", status: 401 },
  ]);
  // The post-Unpair body is diagnostic-only and never enters the success receipt.
  expect(receipt).not.toHaveProperty("claimResponses");
  expect(receipt.lifecycle).toContain("paired-idle");
  expect(receipt.lifecycle.indexOf("cleanup-pending")).toBeGreaterThanOrEqual(0);
  expect(receipt.lifecycle.indexOf("cleanup-pending")).toBeLessThan(receipt.lifecycle.lastIndexOf("revoked"));
  expect(receipt.display.map(({ state }) => state)).toEqual(["paired-idle", "cleanup-pending", "revoked"]);
  expect(receipt.display[0]).toEqual({ state: "paired-idle", title: "paired-idle", badge: "ON" });
  expect(receipt.display[2]).toEqual({ state: "revoked", title: "revoked", badge: "!" });
  expect(receipt.pages).toContainEqual(
    expect.objectContaining({ path: "/account/channels/<connectionId>", status: 200, host: stagingHost }),
  );
  // The stored page's documents in flow order: opened before Generate, Generate's
  // POST/303 and the GET it redirects to, the extension-created popup (the only
  // marker-bearing document), opened again for Unpair, then Unpair's POST/303 and
  // the GET it redirects to. A missing popup or redirect, a second marker or any
  // extra document breaks the exact sequence of five GET/200 documents.
  const storedDocuments = receipt.pages
    .filter(({ path }) => path === "/account/channels/<connectionId>")
    .map(({ method, status, locationHost, fakeDocument }) => ({
      method,
      status,
      locationHost,
      marker: fakeDocument !== undefined,
    }));
  const storedGet = { method: "GET", status: 200, locationHost: null, marker: false };
  const storedRedirect = { method: "POST", status: 303, locationHost: stagingHost, marker: false };
  expect(storedDocuments).toEqual([
    storedGet,
    storedRedirect,
    storedGet,
    { ...storedGet, marker: true },
    storedGet,
    storedRedirect,
    storedGet,
  ]);
  expect(
    receipt.pages.filter(({ path, status }) => path === "/account/channels/<connectionId>" && status === 200),
  ).toHaveLength(5);
  expect(receipt.generateToClickMs).toBeLessThanOrEqual(600_000);

  // AC2: only the staging host was served, by Chromium, with the browser's cookie; everything else was aborted.
  expect(outcome.rows.filter((row) => !row.browser).map((row) => row.step)).toEqual([
    "authorize-mount",
    "authorize-refused",
    "authorize-unregistered",
  ]);
  expect(outcome.rows).toContainEqual(
    expect.objectContaining({ step: "authorize", browser: true, session: true, status: 302 }),
  );
  const pageSteps = [
    "page",
    "list",
    "storage-locations",
    "connect",
    "activate",
    "pause",
    "pairing-read",
    "code",
    "unpair",
  ];
  for (const row of outcome.rows.filter((candidate) => pageSteps.includes(candidate.step)))
    expect({ step: row.step, browser: row.browser, session: row.session }).toEqual({
      step: row.step,
      browser: true,
      session: true,
    });
  expect(receipt.requests).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ origin: staging, source: "page" }),
      expect.objectContaining({ origin: staging, source: "worker" }),
    ]),
  );
  expect(receipt.aborted).toContainEqual({ origin: canary, source: "worker", count: 1 });
  expect(receipt.aborted).toContainEqual(
    expect.objectContaining({ origin: new URL(plantedAsset).origin, source: "page" }),
  );
  expect(receipt.aborted.filter((row) => row.origin === staging)).toEqual([]);

  // AC4: deleted profile, no TCGplayer cookie, and a clean retained receipt.
  expect(receipt.profile.deleted).toBe(true);
  expect(existsSync(receipt.profile.path)).toBe(false);
  expect(receipt.cookies).toEqual([{ domain: new URL(staging).hostname, count: 1 }]);
  expect(readdirSync(outcome.outputDir)).toEqual(["receipt.json"]);
  expect(scanRetainedArtifacts(outcome.outputDir, [...outcome.forbidden, ...retainedSecretMarkers])).toBe(1);
  console.log(`CONNECTOR_DRILL_BROWSER_PAUSED_CLAIMS ${JSON.stringify(paused)}`);
  console.log(
    `CONNECTOR_DRILL_BROWSER_POST_UNPAIR ${JSON.stringify(receipt.claims.filter((claim) => claim.phase === "unpaired"))}`,
  );
  console.log(
    `CONNECTOR_DRILL_BROWSER_LIFECYCLE ${JSON.stringify({ lifecycle: receipt.lifecycle, display: receipt.display })}`,
  );
  console.log(`CONNECTOR_DRILL_STORED_DOCUMENTS ${JSON.stringify(storedDocuments)}`);
  console.log(`CONNECTOR_DRILL_FINAL_RECEIPT ${JSON.stringify(receipt)}`);
});

test("connector-pairing-drill-deployed composed staging smoke against the fake seam", async () => {
  const outcome = await stagingCommand("smoke", { argv: smokeArgs(), pageSubresource: plantedAsset });
  expect(outcome.error).toBeUndefined();
  const receipt = outcome.receipt as DeployedPairingDrillReceipt;
  expect(receipt).toMatchObject({
    kind: "staging-smoke",
    origin: "fake",
    preflight: [],
    personaAlias: null,
    connectionIdSuffix: null,
    steps: [],
    claims: [],
    lifecycle: [],
    trace: "none",
  });
  expect(
    receipt.pages.map(({ method, host, path, status, contentType, locationHost }) => ({
      method,
      host,
      path,
      status,
      contentType,
      locationHost,
    })),
  ).toEqual([
    {
      method: "GET",
      host: stagingHost,
      path: "/account/channels",
      status: 302,
      contentType: null,
      locationHost: stagingHost,
    },
    { method: "GET", host: stagingHost, path: "/sign-in", status: 200, contentType: "text/html", locationHost: null },
  ]);
  expect(receipt.aborted).toContainEqual({ origin: new URL(plantedAsset).origin, source: "page", count: 1 });
  expect(receipt.aborted.filter((row) => row.origin === staging)).toEqual([]);
  // No sign-in and no connection: every request was the browser's, unauthenticated, and no connection exists.
  expect(outcome.signIns).toEqual([]);
  expect(outcome.connections).toEqual([]);
  const served = outcome.rows.filter((row) => row.step !== "favicon");
  expect(served.map(({ step, browser, session }) => ({ step, browser, session }))).toEqual([
    { step: "page-unauthenticated", browser: true, session: false },
    { step: "sign-in", browser: true, session: false },
  ]);
  expect(receipt.profile.deleted).toBe(true);
  expect(existsSync(receipt.profile.path)).toBe(false);
  expect(() => stagingReceiptComment(receipt)).toThrow("connector-drill-fake-receipt-refused");

  const production = await stagingCommand("smoke-production", {
    argv: smokeArgs(linkIntentOrigins["marketplace-web"].production),
  });
  expect(refusal(production).code).toBe("connector-drill-production-origin-refused");
  expect(production.rows).toEqual([]);
});

test("connector-pairing-drill-deployed control: Chromium without the test certificate's SPKI is refused", async () => {
  const outcome = await stagingCommand("untrusted", { untrusted: true });
  expect(refusal(outcome).code).toBe("connector-drill-page-status");
  // Node's preflight trusted the PEM; Chromium never completed a request without the SPKI.
  expect(outcome.rows.filter((row) => row.browser)).toEqual([]);
  expect(outcome.connections).toEqual([]);
});

test("connector-pairing-drill-deployed control: a sign-in without the session cookie is refused", async () => {
  const outcome = await stagingCommand("no-session", { signIn: async () => undefined });
  expect(refusal(outcome).code).toBe("connector-drill-page-status");
  expect(outcome.rows).toContainEqual(
    expect.objectContaining({ step: "page-unauthenticated", browser: true, session: false }),
  );
  expect(outcome.connections).toEqual([]);
});

test("connector-pairing-drill-deployed control: a TCGplayer request or cookie is refused", async () => {
  const request = await stagingCommand("tcgplayer-request", {
    pageSubresource: "https://store.tcgplayer.com/drill.png",
  });
  const requested = refusal(request);
  expect(requested.code).toBe("connector-drill-tcgplayer-refused");
  expect(requested.evidence.deployed?.aborted).toContainEqual(
    expect.objectContaining({ origin: "https://store.tcgplayer.com", source: "page" }),
  );
  expect(request.connections).toEqual([]);
  const cookie = await stagingCommand("tcgplayer-cookie", {
    async signIn(context) {
      await sessionSignIn(context);
      await context.addCookies([
        { name: "drill_tcgplayer", value: "synthetic-provider-cookie", url: "https://store.tcgplayer.com" },
      ]);
    },
  });
  expect(refusal(cookie).code).toBe("connector-drill-tcgplayer-refused");
  expect(cookie.rows.map((row) => row.step)).not.toContain("page");
  expect(cookie.connections).toEqual([]);
});

test("connector-pairing-drill-deployed control: an active trace is refused before sign-in", async () => {
  const outcome = await stagingCommand("trace", { traceActive: true });
  expect(refusal(outcome).code).toBe("connector-drill-trace-active");
  expect(outcome.signIns).toEqual([]);
});

test("connector-pairing-drill-deployed control: a pause that does not land stops before any code", async () => {
  const outcome = await stagingCommand("pause-ignored", { pauseIgnored: true });
  const refused = refusal(outcome);
  expect(refused.code).toBe("connector-drill-connection-refused");
  expect(refused.evidence.deployed?.steps.map(({ step, bodyCode }) => [step, bodyCode]).slice(-2)).toEqual([
    ["pause", "active"],
    ["disconnect", "disconnected"],
  ]);
  expect(outcome.rows.map((row) => row.step)).not.toContain("code");
  expect(outcome.connections).toEqual([expect.objectContaining({ status: "disconnected" })]);
});

test("connector-pairing-drill-deployed control: a page other than the stored connection's is refused", async () => {
  test.setTimeout(120_000);
  const outcome = await stagingCommand("other-connection", { tokenConnectionId: "connection_fake_other" });
  expect(refusal(outcome).code).toBe("connector-drill-page-status");
  expect(outcome.pairing.state).toBe("unpaired");
  expect(outcome.rows).toContainEqual(expect.objectContaining({ step: "token", status: 200 }));
  expect(outcome.connections).toEqual([expect.objectContaining({ status: "disconnected" })]);
});

test("connector-pairing-drill-deployed control: a paused claim serving a reservation is refused", async () => {
  test.setTimeout(120_000);
  const outcome = await stagingCommand("paused-reservation", { pausedReservation: true });
  const refused = refusal(outcome);
  expect(refused.code).toBe("connector-drill-paused-claim-refused");
  expect(refused.evidence.deployed?.claims).toContainEqual(
    expect.objectContaining({ phase: "paused", status: 200, reservation: "present" }),
  );
  expect(outcome.connections).toEqual([expect.objectContaining({ status: "disconnected" })]);
});

test("connector-pairing-drill-deployed control: an Unpair that does not land fires no claim", async () => {
  test.setTimeout(120_000);
  const outcome = await stagingCommand("unpair-ignored", { unpairIgnored: true });
  const refused = refusal(outcome);
  expect(refused.code).toBe("connector-drill-unpair-refused");
  expect(refused.evidence.deployed?.claims.filter((claim) => claim.phase === "unpaired")).toEqual([]);
  expect(outcome.rows).toContainEqual(expect.objectContaining({ step: "unpair", status: 409 }));
  expect(outcome.rows.filter((row) => row.step === "claim" && row.status === 401)).toEqual([]);
  expect(outcome.connections).toEqual([expect.objectContaining({ status: "disconnected" })]);
});
