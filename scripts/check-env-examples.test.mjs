import { describe, expect, it } from "vitest";
import { collectEnvExampleVerification, renderEnvExampleVerificationFailures } from "./check-env-examples.mjs";

describe("check-env-examples", () => {
  it("keeps current deployable examples aligned with config readers", () => {
    const results = collectEnvExampleVerification();

    expect(renderEnvExampleVerificationFailures(results)).toBe("");
  });

  it("fails when a config reader env var is missing from the deployable example", () => {
    const results = collectEnvExampleVerification([
      {
        name: "example-service",
        configSources: ["scripts/fixtures/env-example-check/example-config.ts"],
        examplePath: "scripts/fixtures/env-example-check/.env.example",
        helperEnvNames: {},
        additionalEnvNames: [],
      },
    ]);

    expect(results).toEqual([
      expect.objectContaining({
        deployable: "example-service",
        missing: ["MISSING_FROM_EXAMPLE"],
      }),
    ]);
    expect(renderEnvExampleVerificationFailures(results)).toContain("MISSING_FROM_EXAMPLE");
  });
});
