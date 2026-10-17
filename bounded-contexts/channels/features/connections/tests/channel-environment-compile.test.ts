import { expectTypeOf, it } from "vitest";
import type { ChannelEnvironment as PublicChannelEnvironment } from "@chase-sets/channels";
import type { DeploymentEnvironment } from "@chase-sets/platform-runtime/config-schema";
import type {
  ChannelConnectionServices,
  ChannelConnectionSetupResolver,
  ChannelEnvironment as CanonicalChannelEnvironment,
} from "../domain/contracts";

it("keeps the real consumer on the canonical two-value Channel environment and service signatures", () => {
  expectTypeOf<PublicChannelEnvironment>().toEqualTypeOf<CanonicalChannelEnvironment>();
  expectTypeOf<PublicChannelEnvironment>().toEqualTypeOf<"sandbox" | "production">();
  expectTypeOf<
    Parameters<ChannelConnectionSetupResolver["resolve"]>[0]["environment"]
  >().toEqualTypeOf<PublicChannelEnvironment>();
  expectTypeOf<
    Parameters<ChannelConnectionServices["connectChannel"]>[1]["deploymentEnvironment"]
  >().toEqualTypeOf<DeploymentEnvironment>();

  type SevenValueResolver = { resolve(input: { environment: DeploymentEnvironment }): Promise<null> };
  expectTypeOf<SevenValueResolver>().not.toMatchTypeOf<ChannelConnectionSetupResolver>();
});
