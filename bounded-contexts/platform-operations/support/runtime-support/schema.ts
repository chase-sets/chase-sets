import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { transactionalEmailOutboxSchemaSql } from "@chase-sets/transactional-email-outbox";
import { platformFeedbackSchemaSql } from "../../features/platform-feedback/read-model/schema";
import { supportSourceProjectionSchemaSql } from "../../features/support-requests/integrations/source/source-schema";
import { supportRequestSchemaSql } from "../../features/support-requests/read-model/schema";

export const platformOperationsSchemaSql = [
  eventCorePostgresSchemaSql,
  transactionalEmailOutboxSchemaSql,
  platformFeedbackSchemaSql,
  supportSourceProjectionSchemaSql,
  supportRequestSchemaSql,
].join("\n\n");
