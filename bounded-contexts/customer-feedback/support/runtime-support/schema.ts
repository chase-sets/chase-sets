import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { csatInvitationProjectionSchemaSql } from "../../features/csat/read-model/schema";

/**
 * Customer Feedback owns the event store base schema so it is a first-class
 * event-sourced source context. The invitation query projection is composed with
 * the shared event-core schema here.
 */
export const customerFeedbackSchemaSql = [eventCorePostgresSchemaSql, csatInvitationProjectionSchemaSql].join("\n\n");
