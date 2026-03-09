import { eventCorePostgresSchemaSql } from "../../../contracts/event-core/postgres/schema";
import { catalogAuthoringProjectionSchemaSql } from "./api/schema";

export const catalogAuthoringDatabaseSchemaSql = [
  eventCorePostgresSchemaSql,
  catalogAuthoringProjectionSchemaSql,
].join("\n\n");
