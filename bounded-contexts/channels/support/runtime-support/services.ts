import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type {
  ChannelConnectionServices,
  ChannelStorageLocationAuthorityResolver,
} from "../../features/connections/domain/contracts";
import type { ConnectionHealthServices } from "../../features/connection-health/domain/contracts";
import type { ChannelListingCompositionServices } from "../../features/listing-composition/api/runtime";
import type { OutboundSyncServices } from "../../features/outbound-sync/domain/contracts";
import type { ChannelReconciliationServices } from "../../features/reconciliation/domain/contracts";
import type { TcgplayerCsvServices } from "../../features/tcgplayer-csv/api/runtime";
import type { ManualSyncServices } from "../../features/manual-sync/api/runtime";
import type { ConnectionAttentionServices } from "../../features/connection-attention/domain/contracts";
import type { ChannelCredentialServices } from "../../features/credentials/api/runtime";

export type ChannelsServices = Readonly<{
  credentials: ChannelCredentialServices;
  connections: ChannelConnectionServices;
  storageLocationAuthority: ChannelStorageLocationAuthorityResolver;
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
  "credentials",
  "connections",
  "storageLocationAuthority",
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
  const storageLocationAuthority = Reflect.get(value, "storageLocationAuthority");
  const credentials = Reflect.get(value, "credentials");
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
    isObject(credentials) &&
    typeof Reflect.get(credentials, "resolve") === "function" &&
    typeof Reflect.get(credentials, "create") === "function" &&
    typeof Reflect.get(credentials, "replace") === "function" &&
    typeof Reflect.get(credentials, "rewrap") === "function" &&
    isObject(connections) &&
    typeof Reflect.get(connections, "getConnection") === "function" &&
    isObject(storageLocationAuthority) &&
    typeof Reflect.get(storageLocationAuthority, "resolve") === "function" &&
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
    typeof Reflect.get(reconciliation, "readChannelDriftDetail") === "function" &&
    typeof Reflect.get(reconciliation, "readChannelDriftDecision") === "function" &&
    typeof Reflect.get(reconciliation, "acceptChannelDrift") === "function" &&
    typeof Reflect.get(reconciliation, "repushChannelListing") === "function" &&
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
