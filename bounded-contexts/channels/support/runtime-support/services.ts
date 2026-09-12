import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { ChannelConnectionServices } from "../../features/connections/domain/contracts";
import type { ChannelListingCompositionServices } from "../../features/listing-composition/api/runtime";
import type { OutboundSyncServices } from "../../features/outbound-sync/domain/contracts";
import type { TcgplayerCsvServices } from "../../features/tcgplayer-csv/api/runtime";

export type ChannelsServices = Readonly<{
  connections: ChannelConnectionServices;
  listingComposition: ChannelListingCompositionServices;
  outboundSync: OutboundSyncServices;
  tcgplayerCsv: TcgplayerCsvServices;
  projectors: readonly ProjectionHandlerSet[];
  db: PgTransactionalPool;
}>;

export const channelsServicesMembers = defineChannelsServicesMembers([
  "connections",
  "listingComposition",
  "outboundSync",
  "tcgplayerCsv",
  "projectors",
  "db",
] as const);

export function isChannelsServices(value: unknown): value is ChannelsServices {
  if (!isObject(value) || !channelsServicesMembers.every((member) => Object.hasOwn(value, member))) return false;

  const connections = Reflect.get(value, "connections");
  const listingComposition = Reflect.get(value, "listingComposition");
  const outboundSync = Reflect.get(value, "outboundSync");
  const tcgplayerCsv = Reflect.get(value, "tcgplayerCsv");
  const projectors = Reflect.get(value, "projectors");
  const db = Reflect.get(value, "db");

  return (
    isObject(connections) &&
    typeof Reflect.get(connections, "getConnection") === "function" &&
    isObject(listingComposition) &&
    isObject(outboundSync) &&
    typeof Reflect.get(outboundSync, "recoverExpiredClaimedOperations") === "function" &&
    typeof Reflect.get(outboundSync, "processNextInlineOperation") === "function" &&
    isObject(tcgplayerCsv) &&
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
