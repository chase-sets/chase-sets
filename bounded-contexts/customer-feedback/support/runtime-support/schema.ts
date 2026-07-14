import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import {
  csatAnalyticsProjectionSchemaSql,
  csatInvitationProjectionSchemaSql,
} from "../../features/csat/read-model/schema";
import { feedbackCaseProjectionSchemaSql } from "../../features/cases/read-model/schema";

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
  feedbackCaseProjectionSchemaSql,
].join("\n\n");
