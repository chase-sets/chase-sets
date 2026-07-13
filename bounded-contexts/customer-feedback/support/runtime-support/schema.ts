import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";

/**
 * Customer Feedback owns the event store base schema so it is a first-class
 * event-sourced source context. Its own read-model tables arrive with the leaves
 * that build the invitation aggregate and the CSAT/response-rate
 * projection; this start gate stands up only the shared event-core base.
 */
export const customerFeedbackSchemaSql = eventCorePostgresSchemaSql;
