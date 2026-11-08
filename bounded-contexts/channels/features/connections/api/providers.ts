import { loadDeploymentEnvironment, type DeploymentEnvironment } from "@chase-sets/platform-runtime/config-schema";
import { channelProviderRegistry } from "../../publication-port/api/registry";
import { mapDeploymentEnvironment } from "./runtime";
import type { ChannelProviderIdentity } from "../../publication-port/domain/contracts";

export async function listConnectableChannelProviders(
  deploymentEnvironment: DeploymentEnvironment = loadDeploymentEnvironment(),
): Promise<readonly ChannelProviderIdentity[]> {
  const environment = mapDeploymentEnvironment(deploymentEnvironment);
  const candidates = channelProviderRegistry.list().filter((identity) => identity.environment === environment);
  const resolved = await Promise.all(
    candidates.map(async (identity) =>
      (await channelProviderRegistry.setupResolver.resolve(identity)) ? identity : null,
    ),
  );
  return resolved.filter((identity): identity is ChannelProviderIdentity => identity !== null);
}
