import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { platformFeedbackSchemaSql } from "../../features/platform-feedback/read-model/schema";

export const platformOperationsSchemaSql = [eventCorePostgresSchemaSql, platformFeedbackSchemaSql].join("\n\n");
