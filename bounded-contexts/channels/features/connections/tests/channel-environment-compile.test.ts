import { expectTypeOf, it } from "vitest";
import type { DeploymentEnvironment } from "@chase-sets/platform-runtime/config-schema";
import type {
  ChannelConnectionServices,
  ChannelConnectionSetupResolver,
  ChannelEnvironment,
} from "../domain/contracts";

it("keeps the real consumer on the canonical two-value Channel environment and service signatures", () => {
  expectTypeOf<ChannelEnvironment>().toEqualTypeOf<"sandbox" | "production">();
  expectTypeOf<
    Parameters<ChannelConnectionSetupResolver["resolve"]>[0]["environment"]
  >().toEqualTypeOf<ChannelEnvironment>();
  expectTypeOf<
    Parameters<ChannelConnectionServices["connectChannel"]>[1]["deploymentEnvironment"]
  >().toEqualTypeOf<DeploymentEnvironment>();

  type SevenValueResolver = { resolve(input: { environment: DeploymentEnvironment }): Promise<null> };
  expectTypeOf<SevenValueResolver>().not.toMatchTypeOf<ChannelConnectionSetupResolver>();
});
