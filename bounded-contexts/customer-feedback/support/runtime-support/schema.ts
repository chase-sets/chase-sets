import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import {
  csatAdminExportSchemaSql,
  csatAnalyticsProjectionSchemaSql,
  csatInvitationProjectionSchemaSql,
} from "../../features/csat/read-model/schema";
import { feedbackCaseProjectionSchemaSql } from "../../features/cases/read-model/schema";
import { feedbackAttentionProjectionSchemaSql } from "../../features/attention/read-model/schema";
import { platformPolicySchemaSql } from "@chase-sets/platform-policy/schema";

/**
 * Customer Feedback owns the event store base schema so it is a first-class
 * event-sourced source context. Invitation redemption, invitation-unique
 * analytics, and feedback case projections compose with the shared event-core
 * schema here.
 */
export const customerFeedbackSchemaSql = [
  eventCorePostgresSchemaSql,
  csatInvitationProjectionSchemaSql,
  csatAnalyticsProjectionSchemaSql,
  csatAdminExportSchemaSql,
  feedbackCaseProjectionSchemaSql,
  feedbackAttentionProjectionSchemaSql,
  platformPolicySchemaSql,
].join("\n\n");
