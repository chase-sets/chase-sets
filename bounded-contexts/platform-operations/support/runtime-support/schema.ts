import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { notificationOutboxSchemaSql } from "@chase-sets/notification-outbox";
import { platformFeedbackSchemaSql } from "../../features/platform-feedback/read-model/schema";
import { reportedContentSchemaSql } from "../../features/reported-content/read-model/schema";
import { supportSourceProjectionSchemaSql } from "../../features/support-requests/integrations/source/source-schema";
import { supportRequestSchemaSql } from "../../features/support-requests/read-model/schema";

export const platformOperationsSchemaSql = [
  eventCorePostgresSchemaSql,
  notificationOutboxSchemaSql,
  platformFeedbackSchemaSql,
  reportedContentSchemaSql,
  supportSourceProjectionSchemaSql,
  supportRequestSchemaSql,
].join("\n\n");
