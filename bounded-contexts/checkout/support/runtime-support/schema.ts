import { checkoutCatalogProjectionSchemaSql } from "../../features/cart/integrations/catalog/catalog-schema";
import { checkoutCartSchemaSql } from "../../features/cart/read-model/schema";
import { checkoutSessionSchemaSql } from "../../features/sessions/read-model/schema";

export const checkoutSchemaSql = [
  checkoutCatalogProjectionSchemaSql,
  checkoutCartSchemaSql,
  checkoutSessionSchemaSql,
].join("\n");
