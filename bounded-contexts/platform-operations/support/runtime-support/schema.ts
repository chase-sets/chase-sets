import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { notificationOutboxSchemaSql } from "@chase-sets/notification-outbox";
import { platformPolicySchemaSql } from "@chase-sets/platform-policy/schema";
import { platformFeedbackSchemaSql } from "../../features/platform-feedback/read-model/schema";
import { reportedContentSchemaSql } from "../../features/reported-content/read-model/schema";
import { riskAlertsSchemaSql } from "../../features/risk-alerts/read-model/schema";
import { supportSourceProjectionSchemaSql } from "../../features/support-requests/integrations/source/source-schema";
import { supportRequestSchemaSql } from "../../features/support-requests/read-model/schema";

export const platformOperationsSchemaSql = [
  eventCorePostgresSchemaSql,
  notificationOutboxSchemaSql,
  platformFeedbackSchemaSql,
  reportedContentSchemaSql,
  riskAlertsSchemaSql,
  supportSourceProjectionSchemaSql,
  supportRequestSchemaSql,
  // Adopts the shared platform-policy machinery (see infrastructure/platform-policy)
  // for the platform-wide rate-limit policy -- see
  // ../../features/rate-limit-policy/domain/rate-limit-policy.ts.
  platformPolicySchemaSql,
].join("\n\n");
