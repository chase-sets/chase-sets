import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { transactionalEmailOutboxSchemaSql } from "@chase-sets/transactional-email-outbox";
import { promoBarSchemaSql } from "../../features/promo-bar/read-model/schema";
import { waitlistSchemaSql } from "../../features/waitlist/read-model/schema";

export const publicPresenceSchemaSql = [
  eventCorePostgresSchemaSql,
  transactionalEmailOutboxSchemaSql,
  promoBarSchemaSql,
  waitlistSchemaSql,
].join("\n\n");
