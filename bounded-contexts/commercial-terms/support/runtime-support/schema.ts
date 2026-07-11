import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { platformPolicySchemaSql } from "@chase-sets/platform-policy/schema";
import { resolutionAccountSchemaSql } from "../../features/resolutions/integrations/account-source/account-schema";

// Schedules and agreements no longer own bespoke boot-time tables: they read/write the
// shared platformPolicySchemaSql tables below (see terms-policy.ts). Their retired
// bespoke read-model tables are dropped by an appended migration -- see
// unlogged-projection-migrations.ts.
export const commercialTermsSchemaSql = [
  eventCorePostgresSchemaSql,
  resolutionAccountSchemaSql,
  // Adopts the shared platform-policy machinery (see infrastructure/platform-policy)
  // for the checkout processing-fee policy -- see ../../features/checkout-processing-fee.
  platformPolicySchemaSql,
].join("\n\n");
