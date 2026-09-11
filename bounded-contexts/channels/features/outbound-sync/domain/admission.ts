import { channelExecutionModes, type ChannelProviderRegistry } from "../../publication-port/domain/contracts";
import type { ConnectionExecutionAdmission, OutboundConnection } from "./contracts";

export function resolveConnectionExecutionAdmission(
  registry: ChannelProviderRegistry,
  connection: OutboundConnection,
): ConnectionExecutionAdmission {
  const resolved = registry.get({ providerKey: connection.providerKey, environment: connection.environment });
  if (resolved === null) return { kind: "blocked", reason: "provider-descriptor-unregistered" };
  if (resolved.publication === null) return { kind: "blocked", reason: "provider-publication-unregistered" };

  const publication = resolved.publication;
  const execution: unknown = publication.execution;
  if (!channelExecutionModes.includes(execution as never)) return { kind: "indeterminate" };
  if (execution === "claimed") return { kind: "claimed", providerIdentity: resolved.identity };
  if (execution === "inline" && publication.execution === "inline") {
    return { kind: "inline", providerIdentity: resolved.identity, publication };
  }
  return { kind: "indeterminate" };
}
