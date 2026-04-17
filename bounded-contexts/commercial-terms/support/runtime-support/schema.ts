import { agreementSchemaSql } from "../../features/agreements/read-model/schema";
import { resolutionAccountSchemaSql } from "../../features/resolutions/integrations/account-source/account-schema";
import { scheduleSchemaSql } from "../../features/schedules/read-model/schema";

export const commercialTermsSchemaSql = [
  resolutionAccountSchemaSql,
  scheduleSchemaSql,
  agreementSchemaSql,
].join("\n\n");
