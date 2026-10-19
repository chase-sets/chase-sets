import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { build } from "vite";
import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { runPairingDrill, pairingDrillForbiddenMarkers, type PairingDrillInput } from "./pairing-drill";
import { createSyntheticPairingCode, loopbackPlatform } from "./loopback-platform";
import { executionIdentityPlugin } from "./extension-installation";
import { scanRetainedArtifacts } from "./retained-artifacts";
import { TCGPLAYER_CONNECTOR_EXTENSION_ID } from "@chase-sets/channels/client";

test.use({ trace: "off", screenshot: "off" });

const packageRoot = resolve(import.meta.dirname, "..");
const clientId = "cc_client_00000000-0000-4000-8000-000000000000";
let platform: Awaited<ReturnType<typeof loopbackPlatform>>;
let dist: string;
let retained: string;
let revoked = false;
const servedClaims: { status: number; reservation: "none" }[] = [];

test.beforeAll(async () => {
  platform = await loopbackPlatform({
    requirePairingCode: true,
    clientId,
    handle: async (request, reply) => {
      if (request.url === "/synthetic/platform-revoke" && request.method === "POST") {
        revoked = true;
        reply.writeHead(204).end();
        return true;
      }
      if (request.url !== "/channel-connector/oauth/connections/connection_synthetic/claim") return false;
      const status = revoked ? 401 : 200;
      servedClaims.push({ status, reservation: "none" });
      reply.writeHead(status, { "Content-Type": "application/json" });
      reply.end(
        JSON.stringify(revoked ? { error: "invalid-credential" } : { reservation: null, pollWindowSeconds: 60 }),
      );
      return true;
    },
  });
  dist = mkdtempSync(join(tmpdir(), "connector-drill-dist-"));
  retained = mkdtempSync(join(tmpdir(), "connector-drill-trace-"));
  process.env.VITE_PLATFORM_API_URL = platform.origin;
  process.env.VITE_CONNECTOR_CLIENT_ID = clientId;
  await build({
    root: packageRoot,
    configFile: resolve(packageRoot, "vite.config.ts"),
    configLoader: "runner",
    mode: "connector-local",
    logLevel: "warn",
    build: { outDir: dist, emptyOutDir: true },
    plugins: [executionIdentityPlugin("connector-pairing-drill")],
  });
});

test.beforeEach(() => {
  revoked = false;
  servedClaims.length = 0;
  platform.select("success");
});

test.afterAll(async () => {
  await platform?.close();
  if (dist) rmSync(dist, { recursive: true, force: true });
  if (retained) rmSync(retained, { recursive: true, force: true });
  delete process.env.VITE_PLATFORM_API_URL;
  delete process.env.VITE_CONNECTOR_CLIENT_ID;
});

function drillInput(name: string): PairingDrillInput {
  return {
    dist,
    platformOrigin: platform.origin,
    clientId,
    artifactDigest: createHash("sha256").update("synthetic-drill").digest("hex"),
    signIn: async (page, origin) => {
      await page
        .context()
        .addCookies([{ name: "synthetic_connector_session", value: "synthetic-session-cookie-marker", url: origin }]);
      await page.goto("data:text/html,<title>Connector drill target</title>");
    },
    preparePairing: (origin) => createSyntheticPairingCode(origin),
    revoke: async () => {
      const response = await fetch(`${platform.origin}/synthetic/platform-revoke`, { method: "POST" });
      expect(response.status).toBe(204);
    },
    tracePath: join(retained, `${name}-trace.zip`),
  };
}

test("connector-pairing-drill-loopback-chromium", async () => {
  test.setTimeout(90_000);
  const receipt = await runPairingDrill(drillInput("happy"));
  expect(scanRetainedArtifacts(retained, pairingDrillForbiddenMarkers)).toBeGreaterThan(0);
  expect(receipt.extensionId).toBe(TCGPLAYER_CONNECTOR_EXTENSION_ID);
  expect(receipt.clientIdSuffix).toBe(clientId.slice(-4));
  expect(receipt.states.some(({ state }) => state === "paired-idle")).toBe(true);
  expect(receipt.states.at(-1)?.state).toBe("revoked");
  const claimRequests = receipt.platformRequests.filter(({ path }) => path.endsWith("/claim"));
  expect(claimRequests.map(({ status, reservation }) => ({ status, reservation }))).toEqual(servedClaims);
  expect(claimRequests.some(({ status, reservation }) => status === 200 && reservation === "none")).toBe(true);
  expect(claimRequests.some(({ status }) => status === 401)).toBe(true);
  expect(receipt.abortedRequests).toContainEqual({
    origin: "https://connector-drill-canary.invalid",
    source: "worker",
    count: 1,
  });
  expect(receipt.abortedRequests).toContainEqual({
    origin: "https://connector-drill-planted.invalid",
    source: "page",
    count: 1,
  });
  expect(receipt.platformRequests.every(({ path }) => !path.includes("?") && !path.includes(clientId))).toBe(true);
});

test("connector-pairing-drill refuses a let-through local request", async () => {
  test.setTimeout(90_000);
  let received = 0;
  const target = await loopbackPlatform({
    handle: async (_request, reply) => {
      received++;
      reply.writeHead(204).end();
      return true;
    },
  });
  try {
    await expect(
      runPairingDrill({ ...drillInput("let-through"), routing: { continueLoopbackOrigin: target.origin } }),
    ).rejects.toThrow("connector-drill-non-platform-request-continued");
    expect(received).toBe(1);
  } finally {
    await target.close();
  }
});

test("connector-pairing-drill refuses a blind worker canary", async () => {
  test.setTimeout(90_000);
  await expect(
    runPairingDrill({ ...drillInput("blind-canary"), routing: { classifyWorkerRequests: false } }),
  ).rejects.toThrow("connector-drill-canary-unobserved");
});

test("connector-pairing-drill refuses skipped preparePairing", async () => {
  test.setTimeout(90_000);
  await expect(runPairingDrill({ ...drillInput("skipped-prepare"), preparePairing: async () => {} })).rejects.toThrow(
    "connector-drill-pairing-timeout",
  );
});

test("extension-retained-artifact-scan refuses planted trace markers", async () => {
  test.setTimeout(90_000);
  const root = mkdtempSync(join(tmpdir(), "connector-drill-retained-"));
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "receipt.json"), JSON.stringify({ clean: true }));
    expect(scanRetainedArtifacts(root, pairingDrillForbiddenMarkers)).toBe(1);
    writeFileSync(join(root, "secret.txt"), "synthetic access_token=marker");
    expect(() => scanRetainedArtifacts(root, pairingDrillForbiddenMarkers)).toThrow(
      "connector-retained-artifact-secret",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
