import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { notificationOutboxSchemaSql } from "@chase-sets/notification-outbox";
import { promoBarSchemaSql } from "../../features/promo-bar/read-model/schema";
import { waitlistSchemaSql } from "../../features/waitlist/read-model/schema";
import { platformPolicySchemaSql } from "@chase-sets/platform-policy/schema";

export const publicPresenceSchemaSql = [
  eventCorePostgresSchemaSql,
  notificationOutboxSchemaSql,
  promoBarSchemaSql,
  waitlistSchemaSql,
  platformPolicySchemaSql,
].join("\n\n");
