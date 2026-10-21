import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { build } from "vite";
import { expect, test } from "@playwright/test";
import { createSyntheticPairingCode, loopbackPlatform, synthetic } from "./loopback-platform";
import { scanRetainedArtifacts } from "./retained-artifacts";
import {
  digestConnectorDist,
  drillHeadersBody,
  PairingDrillRefusal,
  providerEnvironmentPattern,
  runPairingDrill,
  type PairingDrillInput,
  type PairingDrillReceipt,
  type PairingDrillRefusalCode,
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

/** A fresh fake server on the fixed port; the planted paths and their counters belong to this spec. */
async function casePlatform() {
  let redirectTargetCount = 0;
  let headersServed = 0;
  const platform = await loopbackPlatform({
    port,
    requirePairingCode: true,
    claims: ["reservation", "invalid-credential"],
    handle: async (request, reply) => {
      const path = new URL(request.url!, "http://127.0.0.1").pathname;
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
  const observe = () => ({ ...platform.drillObservation(), redirectTargetCount, headersServed });
  return { platform, observe };
}

function drillInput(platform: Awaited<ReturnType<typeof casePlatform>>, calls = { signIn: 0, revoke: 0 }) {
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
      // The served invalid-credential claim already revoked the connector; R-A only proves the call.
      calls.revoke++;
    },
    fixture: { observe: platform.observe, redirectPath, headersPath },
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

test("connector-pairing-drill-loopback-chromium", async () => {
  // The drill's bounded waits total at most 80 s; Chromium launch and the receipt fit in the rest.
  test.setTimeout(120_000);
  const platform = await casePlatform();
  const { input, calls } = drillInput(platform);
  let servedPairingId = "";
  try {
    const result = await runPairingDrill({
      ...input,
      preparePairing: async (context) => (servedPairingId = await input.preparePairing(context)),
    }).catch((error: unknown) => {
      if (error instanceof PairingDrillRefusal)
        console.log(
          `CONNECTOR_DRILL_REFUSAL ${JSON.stringify({
            code: error.code,
            evidence: error.evidence,
            server: platform.observe(),
            observation: platform.platform.observation(),
          })}`,
        );
      throw error;
    });
    const output = test.info().outputPath("receipt");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "receipt.json"), JSON.stringify(result.receipt, null, 2));
    const forbidden = [...platform.platform.forbidden(), ...receiptMarkers];
    expect(readdirSync(output)).toEqual(["receipt.json"]);
    expect(scanRetainedArtifacts(output, forbidden)).toBeGreaterThan(0);
    candidate = { receipt: result.receipt, forbidden };

    expect(result.receipt).toMatchObject({
      fixture: "present",
      clientIdSuffix: synthetic.clientId.slice(-4),
      pairingIdSuffix: servedPairingId.slice(-4),
      pageOpenedPath: "/account/channels/connection_synthetic",
      pageStatus: 200,
      pairedState: "paired-idle",
      trace: "none",
      reservation: "present",
      claimCount: 2,
      reservationClaimCount: 1,
      invalidCredentialClaimCount: 1,
    });
    const { lifecycle, requests } = result.receipt;
    expect(lifecycle.indexOf("cleanup-pending")).toBeGreaterThanOrEqual(0);
    expect(lifecycle.indexOf("cleanup-pending")).toBeLessThan(lifecycle.lastIndexOf("revoked"));
    expect(requests).toContainEqual(expect.objectContaining({ origin: platform.platform.origin, source: "page" }));
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
      claimCount: 2,
      reservationClaimCount: 1,
      invalidCredentialClaimCount: 1,
      claimCookieArrived: false,
      channelPageServed: 1,
      pageStatus: 200,
      redirectTargetCount: 0,
      headersServed: 1,
    });
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
    expect(
      result.forwards.filter((row) => row.path.endsWith("/connection_synthetic/claim")).map((row) => row.status),
    ).toEqual([200, 401]);
    expect(calls).toEqual({ signIn: 1, revoke: 1 });
  } finally {
    await platform.platform.close();
  }
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
