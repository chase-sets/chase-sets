/// <reference types="chrome" />
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";
import { expect, test } from "@playwright/test";
import { createSyntheticPairingCode, loopbackPlatform, synthetic } from "./loopback-platform";
import { scanRetainedArtifacts } from "./retained-artifacts";
import { runPairingDrill } from "./pairing-drill";

test.use({ trace: "off", screenshot: "off", video: "off" });

const packageRoot = resolve(import.meta.dirname, "..");
let dist: string;
let platform: Awaited<ReturnType<typeof loopbackPlatform>>;
const providerEnvironment = /^(?:TCGPLAYER_|PROVIDER.*(?:SESSION|CREDENTIAL)|CONNECTOR.*CONFIG_ROOT)/i;
const savedEnvironment = new Map<string, string | undefined>();

test.beforeAll(async () => {
  platform = await loopbackPlatform({ serveReservation: true });
  for (const key of Object.keys(process.env))
    if (providerEnvironment.test(key)) {
      savedEnvironment.set(key, process.env[key]);
      delete process.env[key];
    }
  dist = mkdtempSync(join(tmpdir(), "connector-drill-dist-"));
  process.env.VITE_PLATFORM_API_URL = platform.origin;
  process.env.VITE_CONNECTOR_CLIENT_ID = synthetic.clientId;
  await build({
    root: packageRoot,
    configFile: resolve(packageRoot, "vite.config.ts"),
    configLoader: "runner",
    mode: "connector-local",
    build: { outDir: dist, emptyOutDir: true },
    logLevel: "warn",
  });
});

test.afterAll(async () => {
  await platform?.close();
  for (const [key, value] of savedEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete process.env.VITE_PLATFORM_API_URL;
  delete process.env.VITE_CONNECTOR_CLIENT_ID;
});

function digestDist() {
  const hash = createHash("sha256");
  for (const file of readdirSync(dist).sort()) {
    const bytes = readFileSync(join(dist, file));
    hash.update(file).update("\0").update(String(bytes.byteLength)).update("\0").update(bytes);
  }
  return hash.digest("hex");
}

test("connector-pairing-drill-loopback-chromium", async ({}, testInfo) => {
  let receipt;
  try {
    receipt = await runPairingDrill({
      dist,
      platformOrigin: platform.origin,
      clientId: synthetic.clientId,
      artifactDigest: digestDist(),
      async signIn(context) {
        await context.addCookies([
          {
            name: synthetic.cookieName,
            value: synthetic.cookieValue,
            url: platform.origin,
            httpOnly: true,
            sameSite: "Lax",
          },
        ]);
      },
      async preparePairing() {
        return createSyntheticPairingCode(platform.origin);
      },
      async revoke() {
        // The drill fires the work alarm after pairing to drive the real claim path.
      },
      reservationObserved: () => platform.drillObservation().reservationServed,
      claimCountObserved: () => platform.drillObservation().claimCount,
    });
  } catch (error) {
    console.log(`CONNECTOR_DRILL_PLATFORM ${JSON.stringify(platform.observation())}`);
    throw error;
  }
  const output = testInfo.outputPath("receipt");
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
  expect(receipt).toMatchObject({
    pageOpenedPath: "/account/channels/connection_synthetic",
    pageStatus: 200,
    pairedState: "paired-idle",
    trace: "none",
    reservation: "present",
  });
  expect(receipt.requests).toContainEqual({ origin: "https://connector-drill.invalid", source: "worker", count: 1 });
  expect(
    receipt.requests.find((row) => row.origin === platform.origin && row.source === "worker")?.count,
  ).toBeGreaterThan(0);
  expect(platform.drillObservation()).toMatchObject({
    claimCount: 2,
    claimCookieArrived: false,
    tokenCookieArrived: false,
    redirectTargetCount: 0,
    channelPageCount: 1,
    reservationServed: true,
  });
  expect(receipt.requests.every((row) => row.origin !== "https://store.tcgplayer.com")).toBe(true);
  expect(scanRetainedArtifacts(output, platform.forbidden())).toBeGreaterThan(0);
  expect(readdirSync(output)).toEqual(["receipt.json"]);
  expect(
    scanRetainedArtifacts(output, [
      ...platform.forbidden(),
      "access_token",
      "refresh_token",
      "code_verifier",
      "Bearer ",
      "cc_at_",
      "cc_rt_",
    ]),
  ).toBeGreaterThan(0);
});

test("connector-pairing-drill-origin-mutants-refuse-before-fetch", async () => {
  await expect(
    runPairingDrill({
      dist,
      platformOrigin: `${platform.origin}/wrong`,
      clientId: synthetic.clientId,
      artifactDigest: digestDist(),
      signIn: async () => {},
      preparePairing: async () => {},
      revoke: async () => {},
    }),
  ).rejects.toThrow("connector-drill-platform-origin-refused");
  await expect(
    runPairingDrill({
      dist,
      platformOrigin: "https://store.tcgplayer.com",
      clientId: synthetic.clientId,
      artifactDigest: digestDist(),
      signIn: async () => {},
      preparePairing: async () => {},
      revoke: async () => {},
    }),
  ).rejects.toThrow("connector-drill-platform-origin-refused");
});

test("connector-pairing-drill-active-trace-refuses-before-sign-in", async () => {
  await expect(
    runPairingDrill({
      dist,
      platformOrigin: platform.origin,
      clientId: synthetic.clientId,
      artifactDigest: digestDist(),
      traceActive: true,
      signIn: async () => {},
      preparePairing: async () => {},
      revoke: async () => {},
    }),
  ).rejects.toThrow("connector-drill-trace-active");
});

test("connector-pairing-drill-fail-closed-mutants", async () => {
  const base = {
    dist,
    platformOrigin: platform.origin,
    clientId: synthetic.clientId,
    artifactDigest: digestDist(),
    signIn: async (context) => {
      await context.addCookies([
        {
          name: synthetic.cookieName,
          value: synthetic.cookieValue,
          url: platform.origin,
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
    },
    preparePairing: async () => createSyntheticPairingCode(platform.origin),
    revoke: async () => {},
    cookieForwarded: () =>
      platform.drillObservation().claimCookieArrived || platform.drillObservation().tokenCookieArrived,
  };
  await expect(runPairingDrill({ ...base, skipSecondAction: true })).rejects.toThrow("connector-drill-page-status");
  await expect(runPairingDrill({ ...base, skipPreparePairing: true })).rejects.toThrow(
    "connector-drill-pairing-preparation-refused",
  );
  await expect(runPairingDrill({ ...base, bypassForwarder: true })).rejects.toThrow();
  await expect(runPairingDrill({ ...base, preserveResponseHeaders: true })).rejects.toThrow(
    "connector-drill-forward-headers",
  );
  await expect(runPairingDrill({ ...base, forwardCookieHeaders: true })).rejects.toThrow(
    "connector-drill-cookie-forwarded",
  );
  await expect(runPairingDrill({ ...base, plantReceiptToken: true })).rejects.toThrow(
    "connector-retained-artifact-secret",
  );
  await expect(runPairingDrill({ ...base, skipWorkAlarm: true })).rejects.toThrow("connector-drill-lifecycle-refused");
  platform.setClaimMutant("401");
  try {
    await expect(runPairingDrill({ ...base })).rejects.toThrow();
  } finally {
    platform.setClaimMutant("normal");
  }
  platform.setClaimMutant("replay");
  try {
    await expect(runPairingDrill({ ...base })).rejects.toThrow();
  } finally {
    platform.setClaimMutant("normal");
  }
  process.env.TCGPLAYER_DRILL_MUTANT = "1";
  try {
    await expect(runPairingDrill(base)).rejects.toThrow("connector-drill-provider-environment-refused");
  } finally {
    delete process.env.TCGPLAYER_DRILL_MUTANT;
  }
});
