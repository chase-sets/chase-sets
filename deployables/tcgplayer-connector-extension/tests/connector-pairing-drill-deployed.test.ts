import { describe, expect, it, vi } from "vitest";
import { linkIntentOrigins } from "@chase-sets/platform-runtime/link-intents";
import { TCGPLAYER_CONNECTOR_REDIRECT_URI } from "@chase-sets/channels/client";
import {
  acceptedPlatformOrigin,
  PairingDrillRefusal,
  runPairingDrill,
  type PairingDrillInput,
} from "../e2e/pairing-drill";
import { parsePairingDrillStagingArgs } from "../e2e/pairing-drill-staging";
import { deployedOriginFakeSeam } from "../e2e/loopback-platform";

const staging = linkIntentOrigins["marketplace-web"].staging;
const production = linkIntentOrigins["marketplace-web"].production;
const basePreflight = {
  deployRun: "123",
  deployCommit: "a".repeat(40),
  binding: {
    state: "completed" as const,
    skipped: false,
    superseded: false,
    requiredMerges: [10110, 9985, 10639, 10640],
  },
  rows: [
    {
      name: "mount" as const,
      host: new URL(staging).host,
      path: "/channel-connector/oauth/authorize",
      status: 400,
      contentType: "application/json",
      bodyCode: "invalid-request",
    },
    {
      name: "client" as const,
      host: new URL(staging).host,
      path: "/channel-connector/oauth/authorize",
      status: 302,
      locationHost: new URL(TCGPLAYER_CONNECTOR_REDIRECT_URI).host,
      errorDescription: "authorization_refused",
      unregisteredStatus: 400,
    },
  ],
};

async function refusal(input: PairingDrillInput): Promise<PairingDrillRefusal> {
  try {
    await runPairingDrill(input);
  } catch (error: unknown) {
    if (!(error instanceof PairingDrillRefusal)) throw error;
    return error;
  }
  throw new Error("expected refusal");
}

describe("deployed connector pairing drill", () => {
  it("accepts staging only and refuses production", () => {
    expect(acceptedPlatformOrigin(staging, "deployed")).toBe(true);
    expect(acceptedPlatformOrigin(production, "deployed")).toBe(false);
  });

  it.each([
    ["missing deploy binding", { preflight: undefined }, "connector-drill-deploy-binding-refused"],
    [
      "bad mount row",
      { preflight: { ...basePreflight, rows: [basePreflight.rows[1]] } },
      "connector-drill-preflight-mount-refused",
    ],
    [
      "bad client row",
      { preflight: { ...basePreflight, rows: [basePreflight.rows[0]] } },
      "connector-drill-preflight-client-refused",
    ],
  ])("refuses %s before Chromium", async (_name, change, code) => {
    const result = await refusal({
      dist: ".",
      platformOrigin: staging,
      clientId: "cc_client_test",
      artifactDigest: "digest",
      signIn: vi.fn(),
      preparePairing: vi.fn(),
      revoke: vi.fn(),
      mode: "deployed",
      deployRun: "123",
      deployCommit: "a".repeat(40),
      personaAlias: "card-vault",
      ...change,
    });
    expect(result.code).toBe(code);
    expect(result.evidence.forwardCount).toBe(0);
  });

  it("parses smoke without persona or client inputs", () => {
    expect(
      parsePairingDrillStagingArgs([
        "--smoke",
        "--deploy-run",
        "1",
        "--deploy-commit",
        "a".repeat(40),
        "--platform-origin",
        staging,
      ]),
    ).toMatchObject({ smoke: true, deployRun: "1" });
    expect(() =>
      parsePairingDrillStagingArgs([
        "--smoke",
        "--deploy-run",
        "1",
        "--deploy-commit",
        "a".repeat(40),
        "--platform-origin",
        production,
      ]),
    ).toThrow("connector-drill-production-origin-refused");
  });

  it("maps only the exact staging origin through the fake seam", () => {
    const seam = deployedOriginFakeSeam(staging, "http://127.0.0.1:46174");
    expect(seam.resolveOrigin!(new URL(`${staging}/account/channels`))).toBe("http://127.0.0.1:46174/account/channels");
    expect(() => seam.resolveOrigin!(new URL("https://evil.example/account/channels"))).toThrow(
      "connector-drill-fake-origin-refused",
    );
  });
});
