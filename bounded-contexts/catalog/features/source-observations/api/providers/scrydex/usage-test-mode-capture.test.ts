import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SCRYDEX_USAGE_FRESH_WITHIN_SECONDS } from "./adapter";
import { evaluateScrydexUsageLaunchGate, parseScrydexUsageTestModeFixture } from "./usage-test-mode-fixture";

// AC5 evidence: the credential-safe Scrydex usage read a host took in-cluster with the
// staging runtime's own credentials at 2026-10-09T23:32:04.579Z, replayed through the
// production adapter with `usage-test-mode-probe.ts --replay`. This is a real provider
// observation, so its values are never edited to satisfy assertions. The 15-minute
// freshness rule is evaluated at the captured instant, not at test time.
const fixturePath = fileURLToPath(new URL("./usage.test-mode.fixture.json", import.meta.url));

describe("Scrydex test-mode usage capture", () => {
  it("is a checked, closed-schema capture whose launch gate needs operator confirmation and expires", () => {
    expect(
      existsSync(fixturePath),
      "PENDING_HOST_USAGE_READ: capture usage.test-mode.fixture.json with usage-test-mode-probe.ts",
    ).toBe(true);

    const fixture = parseScrydexUsageTestModeFixture(JSON.parse(readFileSync(fixturePath, "utf8")));
    expect(fixture.attemptState).toBe("checked");
    expect(fixture.observedAt).not.toBeNull();
    expect(fixture.lagCategory).not.toBe("unobserved");
    expect(fixture).toMatchObject({ operatorConfirmation: "required", importAuthorization: "none" });

    const observedAt = Date.parse(fixture.observedAt!);
    const atCapture = evaluateScrydexUsageLaunchGate(fixture, new Date(observedAt));
    expect(atCapture.importAuthorization).toBe("none");
    expect(atCapture.decision).toBe(
      fixture.totalCredits !== null && fixture.remainingCredits !== null && fixture.creditState !== "exhausted"
        ? "operator-confirmation-required"
        : "refused",
    );

    const afterWindow = new Date(observedAt + (SCRYDEX_USAGE_FRESH_WITHIN_SECONDS + 1) * 1000);
    expect(evaluateScrydexUsageLaunchGate(fixture, afterWindow)).toMatchObject({
      decision: "refused",
      reasons: expect.arrayContaining(["usage-stale"]),
      importAuthorization: "none",
    });
  });
});
