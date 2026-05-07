import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { waitlistSchemaSql } from "../../features/waitlist/read-model/schema";

export const publicPresenceSchemaSql = [
  eventCorePostgresSchemaSql,
  waitlistSchemaSql,
].join("\n\n");
