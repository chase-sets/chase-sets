import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { ChannelConnectionServices } from "../../features/connections/domain/contracts";
import type { ConnectionHealthServices } from "../../features/connection-health/domain/contracts";
import type { ChannelListingCompositionServices } from "../../features/listing-composition/api/runtime";
import type { OutboundSyncServices } from "../../features/outbound-sync/domain/contracts";
import type { ChannelReconciliationServices } from "../../features/reconciliation/domain/contracts";
import type { TcgplayerCsvServices } from "../../features/tcgplayer-csv/api/runtime";
import type { ManualSyncServices } from "../../features/manual-sync/api/runtime";
import type { ConnectionAttentionServices } from "../../features/connection-attention/domain/contracts";

export type ChannelsServices = Readonly<{
  connections: ChannelConnectionServices;
  connectionHealth: ConnectionHealthServices;
  connectionAttention: ConnectionAttentionServices;
  listingComposition: ChannelListingCompositionServices;
  outboundSync: OutboundSyncServices;
  reconciliation: ChannelReconciliationServices;
  tcgplayerCsv: TcgplayerCsvServices;
  manualSync: ManualSyncServices;
  projectors: readonly ProjectionHandlerSet[];
  db: PgTransactionalPool;
}>;

export const channelsServicesMembers = defineChannelsServicesMembers([
  "connections",
  "connectionHealth",
  "connectionAttention",
  "listingComposition",
  "outboundSync",
  "reconciliation",
  "tcgplayerCsv",
  "manualSync",
  "projectors",
  "db",
] as const);

export function isChannelsServices(value: unknown): value is ChannelsServices {
  if (!isObject(value) || !channelsServicesMembers.every((member) => Object.hasOwn(value, member))) return false;

  const connections = Reflect.get(value, "connections");
  const connectionHealth = Reflect.get(value, "connectionHealth");
  const connectionAttention = Reflect.get(value, "connectionAttention");
  const listingComposition = Reflect.get(value, "listingComposition");
  const outboundSync = Reflect.get(value, "outboundSync");
  const reconciliation = Reflect.get(value, "reconciliation");
  const tcgplayerCsv = Reflect.get(value, "tcgplayerCsv");
  const manualSync = Reflect.get(value, "manualSync");
  const projectors = Reflect.get(value, "projectors");
  const db = Reflect.get(value, "db");

  return (
    isObject(connections) &&
    typeof Reflect.get(connections, "getConnection") === "function" &&
    isObject(connectionHealth) &&
    typeof Reflect.get(connectionHealth, "submitObservation") === "function" &&
    typeof Reflect.get(connectionHealth, "readConnectionHealth") === "function" &&
    typeof Reflect.get(connectionHealth, "listOpenReasonGenerations") === "function" &&
    isObject(connectionAttention) &&
    typeof Reflect.get(connectionAttention, "listOpenAttention") === "function" &&
    typeof Reflect.get(connectionAttention, "resolveAttention") === "function" &&
    isObject(listingComposition) &&
    isObject(outboundSync) &&
    typeof Reflect.get(outboundSync, "recoverExpiredClaimedOperations") === "function" &&
    typeof Reflect.get(outboundSync, "processNextInlineOperation") === "function" &&
    isObject(reconciliation) &&
    typeof Reflect.get(reconciliation, "reconcileDueConnections") === "function" &&
    typeof Reflect.get(reconciliation, "deliverHealthObservations") === "function" &&
    isObject(tcgplayerCsv) &&
    isObject(manualSync) &&
    Array.isArray(projectors) &&
    isObject(db)
  );
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function defineChannelsServicesMembers<const Members extends readonly (keyof ChannelsServices)[]>(
  members: Members & (Exclude<keyof ChannelsServices, Members[number]> extends never ? unknown : never),
): Members {
  return members;
}
