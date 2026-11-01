import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("connector staging persona verifier threading", () => {
  it("keeps the dedicated verifier in staging inventory and runtime wiring only", () => {
    const workflow = read(".github/workflows/platform-production.yml");
    const helm = read("infrastructure/helm/platform/values.staging.yaml");
    const values = JSON.parse(read("infrastructure/helm/platform/runtime-values.json"));
    const inventory = JSON.parse(read(".github/credential-inventory.json"));
    const verifier = "CONNECTOR_STAGING_PERSONA_MAGIC_LINK_VERIFIER_SHA256";

    expect(workflow).toContain(verifier);
    expect(helm).toContain(verifier);
    expect(values.stagingApiEnv).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: verifier, secret: true })]),
    );
    expect(inventory.secrets).not.toContainEqual(
      expect.objectContaining({ name: verifier, scope: expect.arrayContaining(["production"]) }),
    );
    expect(workflow.match(new RegExp(verifier, "g"))).toHaveLength(4);
    expect(read("deployables/platform-api/src/config.ts")).toContain("CHANNELS_CREDENTIAL_KEYRING_JSON");
  });
});
