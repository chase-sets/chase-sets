import { eventCorePostgresSchemaSql } from "../../../contracts/event-core/postgres/schema";
import { discoveryProjectionSchemaSql } from "../../../bounded-contexts/discovery";

export const marketplaceApiInitSql = [
  eventCorePostgresSchemaSql,
  discoveryProjectionSchemaSql,
].join("\n\n");