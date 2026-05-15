import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { transactionalEmailOutboxSchemaSql } from "@chase-sets/transactional-email-outbox";
import { waitlistSchemaSql } from "../../features/waitlist/read-model/schema";

export const publicPresenceSchemaSql = [
  eventCorePostgresSchemaSql,
  transactionalEmailOutboxSchemaSql,
  waitlistSchemaSql,
].join("\n\n");
