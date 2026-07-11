import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { platformPolicySchemaSql } from "@chase-sets/platform-policy/schema";
import { agreementSchemaSql } from "../../features/agreements/read-model/schema";
import { resolutionAccountSchemaSql } from "../../features/resolutions/integrations/account-source/account-schema";
import { scheduleSchemaSql } from "../../features/schedules/read-model/schema";

export const commercialTermsSchemaSql = [
  eventCorePostgresSchemaSql,
  resolutionAccountSchemaSql,
  scheduleSchemaSql,
  agreementSchemaSql,
  // Adopts the shared platform-policy machinery (see infrastructure/platform-policy)
  // for the checkout processing-fee policy -- see ../../features/checkout-processing-fee.
  platformPolicySchemaSql,
].join("\n\n");
