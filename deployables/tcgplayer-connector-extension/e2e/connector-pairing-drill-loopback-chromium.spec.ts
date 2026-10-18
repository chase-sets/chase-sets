import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { build } from "vite";
import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { runPairingDrill, pairingDrillForbiddenMarkers } from "./pairing-drill";
import { createSyntheticPairingCode, loopbackPlatform } from "./loopback-platform";
import { executionIdentityPlugin } from "./extension-installation";
import { scanRetainedArtifacts } from "./retained-artifacts";
import { TCGPLAYER_CONNECTOR_EXTENSION_ID } from "@chase-sets/channels/client";
import { syntheticClaim } from "../__tests__/harness/claim";

test.setTimeout(90_000);
test.use({ trace: "off", screenshot: "off" });

const packageRoot = resolve(import.meta.dirname, "..");
const clientId = "cc_client_00000000-0000-4000-8000-000000000000";

test("connector-pairing-drill-loopback-chromium", async () => {
  const platform = await loopbackPlatform({
    requirePairingCode: true,
    clientId,
    handle: async (request, reply) => {
      if (request.url !== "/channel-connector/oauth/connections/connection_synthetic/claim") return false;
      reply.writeHead(200, { "Content-Type": "application/json" });
      reply.end(JSON.stringify({ reservation: syntheticClaim(), pollWindowSeconds: 60 }));
      return true;
    },
  });
  const dist = mkdtempSync(join(tmpdir(), "connector-drill-dist-"));
  const retained = mkdtempSync(join(tmpdir(), "connector-drill-trace-"));
  process.env.VITE_PLATFORM_API_URL = platform.origin;
  process.env.VITE_CONNECTOR_CLIENT_ID = clientId;
  process.env.VITE_CONNECTOR_DRILL = "true";
  try {
    await build({
      root: packageRoot,
      configFile: resolve(packageRoot, "vite.config.ts"),
      configLoader: "runner",
      mode: "connector-local",
      logLevel: "warn",
      build: { outDir: dist, emptyOutDir: true },
      plugins: [executionIdentityPlugin("connector-pairing-drill")],
    });
    const receipt = await runPairingDrill({
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
      revoke: async (worker) => {
        const response = await fetch(`${platform.origin}/channel-connector/oauth/revoke`, { method: "POST" });
        expect(response.ok).toBe(true);
        await worker.evaluate(() => chrome.runtime.sendMessage({ type: "unpair" }));
      },
      tracePath: join(retained, "pairing-drill-trace.zip"),
    });
    expect(scanRetainedArtifacts(retained, pairingDrillForbiddenMarkers)).toBeGreaterThan(0);
    expect(receipt.extensionId).toBe(TCGPLAYER_CONNECTOR_EXTENSION_ID);
    expect(receipt.clientIdSuffix).toBe(clientId.slice(-4));
    expect(receipt.platformRequests.some((request) => request.reservation === "present")).toBe(true);
    expect(receipt.abortedRequests).toContainEqual({
      origin: "https://connector-drill-canary.invalid",
      source: "worker",
      count: 1,
    });
    expect(receipt.platformRequests.every(({ path }) => !path.includes("?") && !path.includes(clientId))).toBe(true);
  } finally {
    await platform.close();
    rmSync(dist, { recursive: true, force: true });
    rmSync(retained, { recursive: true, force: true });
    delete process.env.VITE_PLATFORM_API_URL;
    delete process.env.VITE_CONNECTOR_CLIENT_ID;
    delete process.env.VITE_CONNECTOR_DRILL;
  }
});

test("extension-retained-artifact-scan refuses planted trace markers", async () => {
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
