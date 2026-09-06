import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { notificationOutboxSchemaSql } from "@chase-sets/notification-outbox";
import { platformPolicySchemaSql } from "@chase-sets/platform-policy/schema";
import { platformFeedbackSchemaSql } from "../../features/platform-feedback/read-model/schema";
import { publicDocReviewSchemaSql } from "../../features/public-doc-reviews/read-model/schema";
import { commercialTermsEffectiveDateAttentionSchemaSql } from "../../features/commercial-terms-attention/read-model/schema";
import { platformOperationsOpsDashboardSchemaSql } from "../../features/insights-dashboards/read-model/ops-schema";
import { reportedContentSchemaSql } from "../../features/reported-content/read-model/schema";
import { riskAlertsSchemaSql } from "../../features/risk-alerts/read-model/schema";
import { sellerComplianceSalesSchemaSql } from "../../features/seller-compliance-sales/read-model/schema";
import { supportSourceProjectionSchemaSql } from "../../features/support-requests/integrations/source/source-schema";
import { supportRequestSchemaSql } from "../../features/support-requests/read-model/schema";

export const platformOperationsSchemaSql = [
  eventCorePostgresSchemaSql,
  notificationOutboxSchemaSql,
  platformFeedbackSchemaSql,
  commercialTermsEffectiveDateAttentionSchemaSql,
  publicDocReviewSchemaSql,
  platformOperationsOpsDashboardSchemaSql,
  reportedContentSchemaSql,
  riskAlertsSchemaSql,
  sellerComplianceSalesSchemaSql,
  supportSourceProjectionSchemaSql,
  supportRequestSchemaSql,
  // Adopts the shared platform-policy machinery (see infrastructure/platform-policy)
  // for the platform-wide rate-limit policy (../../features/rate-limit-policy/domain/rate-limit-policy.ts)
  // and the support-flow deadline policy (../../features/support-requests/domain/support-deadline-policy.ts).
  platformPolicySchemaSql,
].join("\n\n");
