import { describe, expect, it } from "vitest";
import { mapDeploymentEnvironment } from "../api/runtime";
import type { ChannelEnvironment } from "../domain/contracts";
import { createConnectionHarness, testContext } from "./test-support";

describe("channel-setup-resolver-defaults", () => {
  it("maps all seven deployment environments exactly before resolver lookup and leaves production absent", async () => {
    const observed: ChannelEnvironment[] = [];
    const { services, sandboxSetup } = createConnectionHarness({
      setupResolver: {
        resolve: async ({ providerKey, environment }) => {
          observed.push(environment);
          return providerKey === "fixture-provider" && environment === "sandbox" ? sandboxSetup : null;
        },
      },
    });
    const rows = ["staging", "preview", "test", "dev", "local", "remote-dev"] as const;
    for (const [index, deploymentEnvironment] of rows.entries()) {
      await services.connectChannel(
        { connectionId: `connection_${index}`, accountId: "acc_owner", providerKey: "fixture-provider" },
        { deploymentEnvironment },
        testContext,
      );
    }
    await expect(
      services.connectChannel(
        { connectionId: "connection_production", accountId: "acc_owner", providerKey: "fixture-provider" },
        { deploymentEnvironment: "production" },
        testContext,
      ),
    ).rejects.toMatchObject({ code: "provider-setup-not-registered" });
    expect(observed).toEqual(["sandbox", "sandbox", "sandbox", "sandbox", "sandbox", "sandbox", "production"]);
    expect(mapDeploymentEnvironment("production")).toBe("production");
  });
});
