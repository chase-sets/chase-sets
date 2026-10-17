import { channelExecutionModes, type ChannelProviderRegistry } from "../../publication-port/domain/contracts";
import { OutboundSyncError, type ConnectionExecutionAdmission, type OutboundConnection } from "./contracts";

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

export function assertAdditionalOutboundHold(value: unknown): asserts value is Readonly<{
  held: boolean;
  sources: readonly ("health" | "operator-kill")[];
}> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OutboundSyncError("invalid-input");
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => key !== "held" && key !== "sources") ||
    typeof record.held !== "boolean" ||
    !Array.isArray(record.sources) ||
    record.sources.some((source) => source !== "health" && source !== "operator-kill") ||
    new Set(record.sources).size !== record.sources.length ||
    record.held !== record.sources.length > 0
  ) {
    throw new OutboundSyncError("invalid-input", "Additional outbound hold result is invalid.");
  }
}
