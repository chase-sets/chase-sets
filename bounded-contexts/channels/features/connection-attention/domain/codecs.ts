import { closed, identity, instant, integer } from "../../connection-health/domain/codecs";
import { channelHealthReasons } from "../../connection-health/domain/contracts";
import {
  ChannelAttentionError,
  channelAttentionResolutions,
  type ChannelAttentionFact,
  type ChannelAttentionResolve,
} from "./contracts";

function member<const T extends readonly string[]>(value: unknown, values: T): T[number] {
  if (typeof value !== "string" || !values.includes(value))
    throw new ChannelAttentionError("invalid-attention-contract");
  return value;
}
function connection(value: unknown) {
  const r = closed(value, ["connectionId", "accountId"]);
  return { connectionId: identity(r.connectionId), accountId: identity(r.accountId) };
}
export function decodeChannelAttentionResolve(value: unknown): ChannelAttentionResolve {
  const r = closed(value, ["connection", "reasonCode", "generation", "resolutionReason"]);
  return {
    connection: connection(r.connection),
    reasonCode: member(r.reasonCode, channelHealthReasons),
    generation: integer(r.generation),
    resolutionReason: member(r.resolutionReason, channelAttentionResolutions),
  };
}
export function decodeChannelAttentionFact(value: unknown): ChannelAttentionFact {
  const r = closed(value, [
    "schemaVersion",
    "connection",
    "reasonCode",
    "generation",
    "resolutionReason",
    "openedAt",
    "resolvedAt",
  ]);
  const schemaVersion = member(r.schemaVersion, ["ChannelAttentionOpened/v1", "ChannelAttentionResolved/v1"] as const);
  const openedAt = instant(r.openedAt);
  const resolvedAt = r.resolvedAt === null ? null : instant(r.resolvedAt);
  const resolutionReason = r.resolutionReason === null ? null : member(r.resolutionReason, channelAttentionResolutions);
  if (
    schemaVersion === "ChannelAttentionOpened/v1"
      ? resolvedAt !== null || resolutionReason !== null
      : resolvedAt === null || resolutionReason === null || Date.parse(resolvedAt) < Date.parse(openedAt)
  )
    throw new ChannelAttentionError("invalid-attention-contract");
  return {
    schemaVersion,
    connection: connection(r.connection),
    reasonCode: member(r.reasonCode, channelHealthReasons),
    generation: integer(r.generation),
    resolutionReason,
    openedAt,
    resolvedAt,
  };
}
