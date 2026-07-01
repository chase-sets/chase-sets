import { describe, expect, it } from "vitest";
import {
  requireValidRuntimeProfileSelection,
  runtimeProfileContract,
  validateRuntimeProfileSelection,
} from "./runtime-profiles";

describe("runtime profile contract", () => {
  it.each(["landing", "proof", "public"] as const)("accepts matched %s runtime profiles", (profile) => {
    expect(
      validateRuntimeProfileSelection({
        productionMode: profile,
        apiProfile: profile,
        workerProfile: profile,
      }),
    ).toEqual({ valid: true, errors: [] });
  });

  it("describes landing API and worker profiles as landing-only composition roots", () => {
    expect(runtimeProfileContract("platform-api", "landing")).toMatchObject({
      mountedContextSet: "landing",
      publicMarketplaceRoutes: false,
      privateProofRoutes: false,
      providerCallbacks: "landing-safe",
      requiredSecretPosture: "landing",
      smokeExpectation: "landing-admin",
    });
    expect(runtimeProfileContract("platform-worker", "landing")).toMatchObject({
      mountedContextSet: "landing",
      workerGroups: ["admin-support"],
    });
  });

  it("describes proof profiles as private full-platform proof without public marketplace exposure", () => {
    expect(runtimeProfileContract("platform-api", "proof")).toMatchObject({
      mountedContextSet: "full-platform",
      publicMarketplaceRoutes: false,
      privateProofRoutes: true,
      providerCallbacks: "private-proof",
      requiredSecretPosture: "proof",
      smokeExpectation: "private-marketplace-proof",
    });
    expect(runtimeProfileContract("platform-worker", "proof").workerGroups).toEqual([
      "projection-fallback",
      "projection-wake",
      "provider-jobs",
      "admin-support",
    ]);
  });

  it("describes public profiles as full marketplace runtime composition", () => {
    expect(runtimeProfileContract("platform-api", "public")).toMatchObject({
      mountedContextSet: "full-platform",
      publicMarketplaceRoutes: true,
      privateProofRoutes: true,
      providerCallbacks: "public-marketplace",
      requiredSecretPosture: "public",
      smokeExpectation: "public-marketplace",
    });
  });

  it("fails closed when mode and profile selections are mixed", () => {
    expect(
      validateRuntimeProfileSelection({
        productionMode: "landing",
        apiProfile: "proof",
        workerProfile: "landing",
      }),
    ).toEqual({
      valid: false,
      errors: ["platform-api profile 'proof' is not valid for production mode 'landing'."],
    });
  });

  it("fails closed for unknown modes and profiles with actionable names", () => {
    expect(() =>
      requireValidRuntimeProfileSelection({
        productionMode: "marketplace",
        apiProfile: "admin-support-api",
        workerProfile: "admin-support-worker",
      }),
    ).toThrow(
      "Invalid runtime profile selection: Unknown production runtime mode 'marketplace'. Expected one of: landing, proof, public.",
    );
  });
});
