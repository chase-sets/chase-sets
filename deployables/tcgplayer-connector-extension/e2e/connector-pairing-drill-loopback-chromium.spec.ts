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
  platform = await loopbackPlatform({});
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
});

function digestDist() {
  const files = readdirSync(dist)
    .sort()
    .map((file) => readFileSync(join(dist, file)));
  return createHash("sha256").update(Buffer.concat(files)).digest("hex");
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
    reservation: "none",
  });
  expect(receipt.requests).toContainEqual({ origin: "https://connector-drill.invalid", source: "worker", count: 1 });
  expect(
    receipt.requests.find((row) => row.origin === platform.origin && row.source === "worker")?.count,
  ).toBeGreaterThan(0);
  expect(platform.observation()).toMatchObject({
    claimCount: 1,
    claimCookieArrived: false,
    tokenCookieArrived: false,
    redirectTargetCount: 0,
  });
  expect(receipt.requests.every((row) => row.origin !== "https://store.tcgplayer.com")).toBe(true);
  expect(scanRetainedArtifacts(output, platform.forbidden())).toBeGreaterThan(0);
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

test("connector-pairing-drill-receipt-forbids-secret-markers", () => {
  const receipt = JSON.stringify({ reservation: "none", pageOpenedPath: "/account/channels/connection_synthetic" });
  expect(receipt).not.toContain("cc_at_");
  expect(receipt).not.toContain("Bearer ");
});
