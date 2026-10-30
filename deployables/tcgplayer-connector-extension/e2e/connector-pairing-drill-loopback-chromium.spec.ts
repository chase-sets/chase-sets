import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { build } from "vite";
import { expect, test, type BrowserContext } from "@playwright/test";
import {
  createSyntheticPairingCode,
  loopbackPlatform,
  synthetic,
  type SyntheticClaimResponse,
} from "./loopback-platform";
import { scanRetainedArtifacts } from "./retained-artifacts";
import {
  digestConnectorDist,
  drillHeadersBody,
  PairingDrillRefusal,
  providerEnvironmentPattern,
  runPairingDrill,
  type PairingDrillInput,
  type PairingDrillLifecycleEnd,
  type PairingDrillReceipt,
  type PairingDrillRefusalCode,
  type ForwardHandles,
  type ForwardRequest,
} from "./pairing-drill";

// The drill refuses an active trace; automatic tracing would also retain its secret setup.
test.use({ trace: "off", screenshot: "off", video: "off" });
test.describe.configure({ mode: "serial" });

const packageRoot = resolve(import.meta.dirname, "..");
const redirectPath = "/drill/redirect";
const redirectTarget = "/drill/redirect-target";
const headersPath = "/drill/headers";
const receiptMarkers = ["access_token", "refresh_token", "code_verifier", "Bearer ", "cc_at_", "cc_rt_"];
const harnessPorts = [46174, 46175];
const restored = new Map<string, string | undefined>();
let dist: string;
let port: number;
let candidate: { receipt: PairingDrillReceipt; forbidden: string[] } | undefined;

test.beforeAll(async () => {
  for (const key of Object.keys(process.env))
    if (providerEnvironmentPattern.test(key)) {
      restored.set(key, process.env[key]);
      delete process.env[key];
    }
  // Every case serves this one fixed port; the product build refuses the harness ports.
  do {
    const scout = await loopbackPlatform();
    await scout.close();
    port = Number(new URL(scout.origin).port);
  } while (harnessPorts.includes(port));
  for (const key of ["VITE_PLATFORM_API_URL", "VITE_CONNECTOR_CLIENT_ID"])
    if (!restored.has(key)) restored.set(key, process.env[key]);
  process.env.VITE_PLATFORM_API_URL = `http://127.0.0.1:${port}`;
  process.env.VITE_CONNECTOR_CLIENT_ID = synthetic.clientId;
  dist = mkdtempSync(join(tmpdir(), "connector-drill-dist-"));
  await build({
    root: packageRoot,
    configFile: resolve(packageRoot, "vite.config.ts"),
    configLoader: "runner",
    mode: "connector-local",
    build: { outDir: dist, emptyOutDir: true },
    logLevel: "warn",
  });
});

test.afterAll(() => {
  for (const [key, value] of restored) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (dist) rmSync(dist, { recursive: true, force: true });
});

/** The cleanup candidate's claims; every mutant varies one input against it. */
const cleanupClaims: readonly SyntheticClaimResponse[] = ["invalid-credential"];

/** A fresh fake server on the fixed port; the planted paths and their counters belong to this spec. */
async function casePlatform(claims = cleanupClaims, pageMode: "drop" | "delay" | undefined = undefined) {
  let redirectTargetCount = 0;
  let headersServed = 0;
  let droppedPageCount = 0;
  const platform = await loopbackPlatform({
    port,
    requirePairingCode: true,
    claims,
    handle: async (request, reply) => {
      const path = new URL(request.url!, "http://127.0.0.1").pathname;
      if (path === "/account/channels/connection_synthetic" && pageMode === "drop") {
        droppedPageCount++;
        request.socket.destroy();
        return true;
      }
      if (path === "/account/channels/connection_synthetic" && pageMode === "delay") {
        await new Promise((resolve) => setTimeout(resolve, 11_000));
      }
      if (path === redirectPath) {
        reply.writeHead(302, { Location: redirectTarget }).end();
        return true;
      }
      if (path === redirectTarget) {
        redirectTargetCount++;
        reply.writeHead(200).end("redirect-target");
        return true;
      }
      if (path !== headersPath) return false;
      headersServed++;
      const body = gzipSync(drillHeadersBody);
      reply
        .writeHead(200, {
          "Content-Type": "text/plain",
          "Content-Encoding": "gzip",
          "Content-Length": body.byteLength,
          "Set-Cookie": "drill_probe=1",
        })
        .end(body);
      return true;
    },
  });
  const observe = () => ({ ...platform.drillObservation(), redirectTargetCount, headersServed, droppedPageCount });
  return { platform, observe };
}

async function secondServer() {
  let plantedPageServed = 0;
  let letThroughServed = 0;
  const platform = await loopbackPlatform({
    handle: async (request, reply) => {
      const path = new URL(request.url!, "http://127.0.0.1").pathname;
      if (path === "/drill/planted-page") {
        plantedPageServed++;
        reply.writeHead(200).end("planted");
        return true;
      }
      if (path === "/drill/let-through") {
        letThroughServed++;
        reply.writeHead(200).end("let-through");
        return true;
      }
      return false;
    },
  });
  return {
    platform,
    observe: () => ({ plantedPageServed, letThroughServed }),
  };
}

function drillInput(
  platform: Awaited<ReturnType<typeof casePlatform>>,
  lifecycleEnd: PairingDrillLifecycleEnd = "revoked",
  second?: Awaited<ReturnType<typeof secondServer>>,
) {
  const calls = { signIn: 0, revoke: 0 };
  const input: PairingDrillInput = {
    dist,
    platformOrigin: platform.platform.origin,
    clientId: synthetic.clientId,
    artifactDigest: digestConnectorDist(dist),
    async signIn(context) {
      calls.signIn++;
      await context.addCookies([
        {
          name: synthetic.cookieName,
          value: synthetic.cookieValue,
          url: platform.platform.origin,
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
    },
    preparePairing: () => createSyntheticPairingCode(platform.platform.origin),
    async revoke() {
      // The served claims already paused or revoked the connector; R-A only proves the call.
      calls.revoke++;
    },
    fixture: {
      observe: () => ({ ...platform.observe(), ...(second?.observe() ?? {}) }),
      redirectPath,
      headersPath,
      lifecycleEnd,
      secondOrigin: second?.platform.origin,
    },
  };
  return { input, calls };
}

async function refusal(run: Promise<unknown>) {
  const error = await run.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(PairingDrillRefusal);
  return error as PairingDrillRefusal;
}

test("connector-pairing-drill-pre-launch-mutants", async () => {
  const mutants: ReadonlyArray<
    readonly [string, PairingDrillRefusalCode, (input: PairingDrillInput, otherOrigin: string) => PairingDrillInput]
  > = [
    [
      "userinfo",
      "connector-drill-platform-origin-refused",
      (input) => ({ ...input, platformOrigin: input.platformOrigin.replace("http://", "http://drill@") }),
    ],
    [
      "query",
      "connector-drill-platform-origin-refused",
      (input) => ({ ...input, platformOrigin: `${input.platformOrigin}?drill=1` }),
    ],
    [
      "path",
      "connector-drill-platform-origin-refused",
      (input) => ({ ...input, platformOrigin: `${input.platformOrigin}/drill` }),
    ],
    [
      "non-generated https",
      "connector-drill-platform-origin-refused",
      (input) => ({ ...input, platformOrigin: "https://connector-drill.invalid" }),
    ],
    [
      "localhost",
      "connector-drill-platform-origin-refused",
      (input) => ({ ...input, platformOrigin: input.platformOrigin.replace("127.0.0.1", "localhost") }),
    ],
    [
      "another server's origin",
      "connector-drill-dist-origin-refused",
      (input, otherOrigin) => ({ ...input, platformOrigin: otherOrigin }),
    ],
    ["other client", "connector-drill-dist-client-refused", (input) => ({ ...input, clientId: "cc_client_other" })],
    [
      "wrong digest",
      "connector-drill-artifact-digest-refused",
      (input) => ({ ...input, artifactDigest: createHash("sha256").update("connector-drill-other").digest("hex") }),
    ],
  ];
  const outcome = async (
    name: string,
    change: (input: PairingDrillInput, otherOrigin: string) => PairingDrillInput,
  ) => {
    const platform = await casePlatform();
    const other = await loopbackPlatform();
    const { input, calls } = drillInput(platform);
    try {
      const refused = await refusal(runPairingDrill(change(input, other.origin)));
      return {
        name,
        code: refused.code,
        forwardCount: refused.evidence.forwardCount,
        requestCount: platform.platform.drillObservation().requestCount + other.drillObservation().requestCount,
        signIn: calls.signIn,
      };
    } finally {
      await other.close();
      await platform.platform.close();
    }
  };
  for (const [name, code, change] of mutants)
    expect(await outcome(name, change)).toEqual({ name, code, forwardCount: 0, requestCount: 0, signIn: 0 });
  process.env.TCGPLAYER_DRILL_MUTANT = "1";
  try {
    expect(await outcome("provider environment", (input) => input)).toEqual({
      name: "provider environment",
      code: "connector-drill-provider-environment-refused",
      forwardCount: 0,
      requestCount: 0,
      signIn: 0,
    });
  } finally {
    delete process.env.TCGPLAYER_DRILL_MUTANT;
  }
});

test("connector-pairing-drill-active-trace-refuses-before-sign-in", async () => {
  const platform = await casePlatform();
  const { input, calls } = drillInput(platform);
  try {
    const refused = await refusal(runPairingDrill({ ...input, traceActive: true }));
    expect({
      code: refused.code,
      requestCount: platform.platform.drillObservation().requestCount,
      signIn: calls.signIn,
    }).toEqual({ code: "connector-drill-trace-active", requestCount: 0, signIn: 0 });
  } finally {
    await platform.platform.close();
  }
});

async function forwardKeepingHeaders(request: ForwardRequest, handles: ForwardHandles) {
  let response: Response;
  try {
    response = await fetch(request.url, {
      method: request.method,
      headers: Object.fromEntries(
        Object.entries(request.headers).filter(
          ([name]) => !["cookie", "host", "content-length"].includes(name.toLowerCase()),
        ),
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
  await handles.fulfill({
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: Buffer.from(await response.arrayBuffer()),
  });
}

async function forwardWithCookie(request: ForwardRequest, handles: ForwardHandles, context: BrowserContext) {
  let response: Response;
  try {
    const headers = Object.fromEntries(
      Object.entries(request.headers).filter(
        ([name]) => !["cookie", "host", "content-length"].includes(name.toLowerCase()),
      ),
    );
    const cookies = await context.cookies(new URL(request.url).origin);
    if (cookies.length) headers.cookie = cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
    response = await fetch(request.url, {
      method: request.method,
      headers,
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
  await handles.fulfill({
    status: response.status,
    headers: Object.fromEntries(
      [...response.headers].filter(([name]) => !["set-cookie", "content-encoding", "content-length"].includes(name)),
    ),
    body: Buffer.from(await response.arrayBuffer()),
  });
}

type ControlSetup = {
  claims?: readonly SyntheticClaimResponse[];
  pageMode?: "drop" | "delay";
  mutate?: (input: PairingDrillInput, secondOrigin: string) => PairingDrillInput;
};

async function runControl(setup: ControlSetup) {
  const platform = await casePlatform(setup.claims, setup.pageMode);
  const second = await secondServer();
  const { input } = drillInput(platform, "revoked", second);
  try {
    const refused = await refusal(runPairingDrill(setup.mutate?.(input, second.platform.origin) ?? input));
    return { refused, platform, second };
  } catch (error) {
    await second.platform.close();
    await platform.platform.close();
    throw error;
  }
}

test("connector-pairing-drill-control C1", async () => {
  const { refused, platform, second } = await runControl({
    mutate: (input, origin) => ({
      ...input,
      seams: {
        pageRoute: async (route, request) =>
          request.isNavigationRequest() && request.url().startsWith(origin) ? route.abort() : route.continue(),
      },
    }),
  });
  try {
    expect(refused.code).toBe("connector-drill-seam-ignored");
    expect(second.observe()).toMatchObject({ plantedPageServed: 1, letThroughServed: 0 });
  } finally {
    await second.platform.close();
    await platform.platform.close();
  }
});

test("connector-pairing-drill-control C2", async () => {
  const { refused, platform, second } = await runControl({
    mutate: (input, origin) => ({
      ...input,
      seams: {
        classify: (request) =>
          request.url().startsWith(origin) && !request.isNavigationRequest()
            ? "worker"
            : request.serviceWorker()
              ? "worker"
              : "page",
      },
    }),
  });
  try {
    expect(refused.code).toBe("connector-drill-page-source-mismatch");
    expect(second.observe()).toMatchObject({ plantedPageServed: 0, letThroughServed: 1 });
  } finally {
    await second.platform.close();
    await platform.platform.close();
  }
});

test("connector-pairing-drill-control C3", async () => {
  const { refused, platform, second } = await runControl({
    mutate: (input) => ({
      ...input,
      seams: { routeFilter: (url) => url.origin !== "https://connector-drill.invalid" },
    }),
  });
  try {
    expect(refused.code).toBe("connector-drill-canary-unaccounted");
    expect(refused.evidence.requests).not.toContainEqual(
      expect.objectContaining({ origin: "https://connector-drill.invalid", source: "worker" }),
    );
  } finally {
    await second.platform.close();
    await platform.platform.close();
  }
});

test("connector-pairing-drill-control C4", async () => {
  const { refused, platform, second } = await runControl({
    mutate: (input) => ({ ...input, seams: { forward: async (_request, handles) => handles.continue() } }),
  });
  try {
    expect(refused.code).toBe("connector-drill-redirect");
    expect(platform.observe()).toMatchObject({ redirectTargetCount: 1 });
  } finally {
    await second.platform.close();
    await platform.platform.close();
  }
});

test("connector-pairing-drill-control C5", async () => {
  const { refused, platform, second } = await runControl({
    mutate: (input) => ({
      ...input,
      seams: { forward: (request, handles) => forwardKeepingHeaders(request, handles) },
    }),
  });
  try {
    expect(refused.code).toBe("connector-drill-forward-headers");
    expect(refused.evidence.forwards).toContainEqual(
      expect.objectContaining({
        path: headersPath,
        fulfilledHeaderNames: expect.arrayContaining(["set-cookie", "content-encoding", "content-length"]),
      }),
    );
  } finally {
    await second.platform.close();
    await platform.platform.close();
  }
});

test("connector-pairing-drill-control C6", async () => {
  const { refused, platform, second } = await runControl({
    mutate: (input) => ({
      ...input,
      seams: { forward: (request, handles, _defaultForward, context) => forwardWithCookie(request, handles, context) },
    }),
  });
  try {
    expect(refused.code).toBe("connector-drill-forward-cookie");
    expect(platform.observe()).toMatchObject({ tokenCookieArrived: true });
  } finally {
    await second.platform.close();
    await platform.platform.close();
  }
});

test("connector-pairing-drill-control C7", async () => {
  const { refused, platform, second } = await runControl({
    mutate: (input) => ({ ...input, preparePairing: async () => "synthetic-pairing" }),
  });
  try {
    expect(refused.code).toBe("connector-drill-pairing-refused");
    expect(platform.platform.observation()).toMatchObject({ tokenCount: 0 });
    expect(platform.observe()).toMatchObject({ pairingCodeCount: 0 });
  } finally {
    await second.platform.close();
    await platform.platform.close();
  }
});

test("connector-pairing-drill-control C8", async () => {
  const { refused, platform, second } = await runControl({
    mutate: (input) => ({
      ...input,
      seams: {
        trigger: (_context, _page, phase, defaultTrigger) =>
          phase === "pairing" ? defaultTrigger() : Promise.resolve(true),
      },
    }),
  });
  try {
    expect(refused.code).toBe("connector-drill-page-status");
    expect(platform.observe()).toMatchObject({ channelPageServed: 0 });
  } finally {
    await second.platform.close();
    await platform.platform.close();
  }
});

test("connector-pairing-drill-control C9", async () => {
  const { refused, platform, second } = await runControl({ pageMode: "drop" });
  try {
    expect(refused.code).toBe("connector-drill-page-status");
    expect(platform.observe().droppedPageCount).toBeGreaterThanOrEqual(1);
    expect(platform.observe().channelPageServed).toBe(0);
  } finally {
    await second.platform.close();
    await platform.platform.close();
  }
});

test("connector-pairing-drill-control C10", async () => {
  const { refused, platform, second } = await runControl({ pageMode: "delay" });
  try {
    expect(refused.code).toBe("connector-drill-page-status");
    expect(platform.observe()).toMatchObject({ channelPageServed: 0 });
  } finally {
    await second.platform.close();
    await platform.platform.close();
  }
});

test("connector-pairing-drill-control C11", async () => {
  const { refused, platform, second } = await runControl({ claims: ["empty"] });
  try {
    expect(refused.code).toBe("connector-drill-lifecycle-refused");
    expect(platform.observe()).toMatchObject({ invalidCredentialClaimCount: 0 });
    expect(refused.evidence.lifecycle).not.toContain("cleanup-pending");
  } finally {
    await second.platform.close();
    await platform.platform.close();
  }
});

test("connector-pairing-drill-control C12", async () => {
  const { refused, platform, second } = await runControl({ claims: ["reservation"] });
  try {
    expect(refused.code).toBe("connector-drill-lifecycle-refused");
    expect(platform.observe()).toMatchObject({ reservationClaimCount: 1 });
    expect(refused.evidence.lifecycle).toContain("paused:unsupported-operation");
  } finally {
    await second.platform.close();
    await platform.platform.close();
  }
});

test("connector-pairing-drill-control C13", async () => {
  const { refused, platform, second } = await runControl({
    mutate: (input) => ({
      ...input,
      async revoke(context) {
        const worker = context.serviceWorkers().find((candidate) => candidate.url().endsWith("/background.js"));
        if (!worker) throw new Error("connector worker unavailable");
        await worker.evaluate(
          async ({ url, bearer }) => {
            await fetch(url, { method: "POST", headers: { authorization: `Bearer ${bearer}` }, body: "{}" });
          },
          {
            url: `${input.platformOrigin}/channel-connector/oauth/connections/connection_synthetic/claim`,
            bearer: synthetic.access,
          },
        );
      },
    }),
  });
  try {
    expect(refused.code).toBe("connector-drill-post-revoke");
    expect(platform.observe().claimCount).toBe(2);
  } finally {
    await second.platform.close();
    await platform.platform.close();
  }
});

/**
 * Runs one drill on a fresh fake server serving `claims`, retains its receipt alone in the case's own output
 * directory, and asserts the forwarder, pairing and served-page records every case shares. The caller asserts
 * the claim leg.
 */
async function drillCase(
  name: string,
  claims: readonly SyntheticClaimResponse[],
  lifecycleEnd: PairingDrillLifecycleEnd,
) {
  const platform = await casePlatform(claims);
  const second = await secondServer();
  const { input, calls } = drillInput(platform, lifecycleEnd, second);
  let servedPairingId = "";
  try {
    const result = await runPairingDrill({
      ...input,
      preparePairing: async (context) => (servedPairingId = await input.preparePairing(context)),
    }).catch((error: unknown) => {
      if (error instanceof PairingDrillRefusal)
        console.log(
          `CONNECTOR_DRILL_REFUSAL ${JSON.stringify({
            case: name,
            code: error.code,
            evidence: error.evidence,
            server: platform.observe(),
            observation: platform.platform.observation(),
          })}`,
        );
      throw error;
    });
    const output = test.info().outputPath(`receipt-${name}`);
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "receipt.json"), JSON.stringify(result.receipt, null, 2));
    const forbidden = [...platform.platform.forbidden(), ...receiptMarkers];
    expect(readdirSync(output)).toEqual(["receipt.json"]);
    expect(scanRetainedArtifacts(output, forbidden)).toBeGreaterThan(0);

    expect(result.receipt).toMatchObject({
      fixture: "present",
      clientIdSuffix: synthetic.clientId.slice(-4),
      pairingIdSuffix: servedPairingId.slice(-4),
      pageOpenedPath: "/account/channels/connection_synthetic",
      pageStatus: 200,
      pairedState: "paired-idle",
      trace: "none",
    });
    expect(result.receipt.requests).toContainEqual(
      expect.objectContaining({ origin: platform.platform.origin, source: "page" }),
    );
    expect(result.receipt.requests).toContainEqual(
      expect.objectContaining({ origin: second.platform.origin, source: "page" }),
    );
    expect(platform.platform.observation()).toEqual({
      authorizeCount: 1,
      tokenCount: 1,
      cookieArrived: true,
      queryClosed: true,
      tokenClosed: true,
    });
    expect(platform.observe()).toMatchObject({
      pairingCodeCount: 1,
      tokenCookieArrived: false,
      claimCookieArrived: false,
      channelPageServed: 1,
      pageStatus: 200,
      redirectTargetCount: 0,
      headersServed: 1,
    });
    expect(second.observe()).toEqual({ plantedPageServed: 1, letThroughServed: 1 });
    expect(result.forwards).toContainEqual({
      path: redirectPath,
      action: "abort",
      status: 302,
      fulfilledHeaderNames: [],
    });
    const headers = result.forwards.find((row) => row.path === headersPath);
    expect(headers).toMatchObject({ action: "fulfill", status: 200 });
    for (const name of ["set-cookie", "content-encoding", "content-length"])
      expect(headers!.fulfilledHeaderNames).not.toContain(name);
    expect(calls).toEqual({ signIn: 1, revoke: 1 });
    return {
      receipt: result.receipt,
      forbidden,
      server: platform.observe(),
      claimStatuses: result.forwards.filter((row) => row.path.endsWith("/claim")).map((row) => row.status),
    };
  } finally {
    await second.platform.close();
    await platform.platform.close();
  }
}

test("connector-pairing-drill-loopback-chromium", async () => {
  // Two drills, each with bounded waits totalling at most 80 s; Chromium launches and receipts fit in the rest.
  test.setTimeout(240_000);
  await test.step("invalid-credential cleanup candidate", async () => {
    const cleanup = await drillCase("cleanup", cleanupClaims, "revoked");
    expect(cleanup.receipt).toMatchObject({
      reservation: "none",
      claimCount: 1,
      reservationClaimCount: 0,
      invalidCredentialClaimCount: 1,
    });
    const { lifecycle } = cleanup.receipt;
    expect(lifecycle.indexOf("cleanup-pending")).toBeGreaterThanOrEqual(0);
    expect(lifecycle.indexOf("cleanup-pending")).toBeLessThan(lifecycle.lastIndexOf("revoked"));
    expect(cleanup.server).toMatchObject({ invalidCredentialClaimCount: 1, reservationClaimCount: 0, reportCount: 0 });
    expect(cleanup.claimStatuses).toEqual([401]);
    candidate = { receipt: cleanup.receipt, forbidden: cleanup.forbidden };
  });
  await test.step("reservation pause", async () => {
    const paused = await drillCase(
      "reservation",
      ["reservation", "invalid-credential"],
      "paused:unsupported-operation",
    );
    expect(paused.receipt).toMatchObject({
      reservation: "present",
      claimCount: 1,
      reservationClaimCount: 1,
      invalidCredentialClaimCount: 0,
    });
    expect(paused.receipt.lifecycle.at(-1)).toBe("paused:unsupported-operation");
    expect(paused.server).toMatchObject({ reportCount: 1, abandonedReportCount: 1 });
    expect(paused.claimStatuses).toEqual([200]);
  });
});

test("connector-pairing-drill-planted-token-scan", () => {
  expect(candidate).toBeDefined();
  const directory = mkdtempSync(join(tmpdir(), "connector-drill-planted-"));
  try {
    writeFileSync(join(directory, "receipt.json"), JSON.stringify(candidate!.receipt, null, 2));
    expect(scanRetainedArtifacts(directory, candidate!.forbidden)).toBe(1);
    writeFileSync(join(directory, "planted-access.txt"), synthetic.access);
    expect(readdirSync(directory)).toHaveLength(2);
    expect(() => scanRetainedArtifacts(directory, candidate!.forbidden)).toThrow("connector-retained-artifact-secret");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
