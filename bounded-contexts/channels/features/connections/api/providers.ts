import { loadDeploymentEnvironment, type DeploymentEnvironment } from "@chase-sets/platform-runtime/config-schema";
import { channelProviderRegistry } from "../../publication-port/api/registry";
import { mapDeploymentEnvironment } from "./runtime";

export async function listConnectableChannelProviders(
  deploymentEnvironment: DeploymentEnvironment = loadDeploymentEnvironment(),
) {
  const environment = mapDeploymentEnvironment(deploymentEnvironment);
  const candidates = channelProviderRegistry.list().filter((identity) => identity.environment === environment);
  const resolved = await Promise.all(
    candidates.map(async (identity) =>
      (await channelProviderRegistry.setupResolver.resolve(identity)) ? identity.providerKey : null,
    ),
  );
  return resolved.filter((providerKey): providerKey is string => providerKey !== null);
}
