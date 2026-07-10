import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { authenticityCaseSchemaSql } from "../../features/cases/read-model/schema";

export const authenticitySchemaSql = [eventCorePostgresSchemaSql, authenticityCaseSchemaSql].join("\n\n");
