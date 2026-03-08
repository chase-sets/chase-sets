import { eventCorePostgresSchemaSql } from "../../../contracts/event-core/postgres/schema";
import { catalogAuthoringProjectionSchemaSql } from "../../../bounded-contexts/catalog/authoring/api/schema";
import { discoveryProjectionSchemaSql } from "../../../bounded-contexts/discovery/api/schema";

export const catalogApiInitSql = [
  eventCorePostgresSchemaSql,
  catalogAuthoringProjectionSchemaSql,
  discoveryProjectionSchemaSql,
].join("\n\n");
