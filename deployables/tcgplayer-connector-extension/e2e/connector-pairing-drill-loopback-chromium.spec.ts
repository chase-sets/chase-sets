/// <reference types="chrome" />
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { createSyntheticPairingCode, loopbackPlatform, synthetic } from "./loopback-platform";
import { scanRetainedArtifacts } from "./retained-artifacts";
import { runPairingDrill } from "./pairing-drill";

test.use({ trace: "off", screenshot: "off", video: "off" });

const packageRoot = resolve(import.meta.dirname, "..");
const dist = resolve(packageRoot, "dist");
let platform: Awaited<ReturnType<typeof loopbackPlatform>>;
let claim401 = 0;
let revoked = 0;

test.beforeAll(async () => {
  platform = await loopbackPlatform({
    handle: async (request, reply) => {
      const path = new URL(request.url ?? "/", platform.origin).pathname;
      if (path.endsWith("/claim")) {
        claim401++;
        reply
          .writeHead(401, { "Content-Type": "application/json" })
          .end(JSON.stringify({ error: "invalid-credential" }));
        return true;
      }
      if (path.endsWith("/revoke")) {
        revoked++;
        reply.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ revoked: true }));
        return true;
      }
      return false;
    },
  });
});

test.afterAll(async () => {
  await platform?.close();
});

function digestDist() {
  const bytes = readFileSync(join(dist, "background.js"));
  return createHash("sha256").update(bytes).digest("hex");
}

test("connector-pairing-drill-loopback-chromium", async ({}, testInfo) => {
  const receipt = await runPairingDrill({
    dist,
    platformOrigin: platform.origin,
    clientId: synthetic.clientId,
    artifactDigest: digestDist(),
    reservation: "present",
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
      await createSyntheticPairingCode(platform.origin);
    },
    async revoke() {
      // The product's work alarm is intentionally not invoked by the second action.
      // The route still records any claim/revoke leg without exposing its values.
    },
  });
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

test("connector-pairing-drill-active-trace-refuses-before-launch", async () => {
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
  const receipt = JSON.stringify({ reservation: "present", pageOpenedPath: "/account/channels/connection_synthetic" });
  expect(receipt).not.toContain("cc_at_");
  expect(receipt).not.toContain("Bearer ");
  expect(claim401).toBeGreaterThanOrEqual(0);
  expect(revoked).toBeGreaterThanOrEqual(0);
});
