import { catalogAuthoringDatabaseSchemaSql } from "../../../bounded-contexts/catalog/authoring/database-schema";
import { discoveryProjectionSchemaSql } from "../../../bounded-contexts/discovery/api/schema";

export const catalogApiInitSql = [
  catalogAuthoringDatabaseSchemaSql,
  discoveryProjectionSchemaSql,
].join("\n\n");
