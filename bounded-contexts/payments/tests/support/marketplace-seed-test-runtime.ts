import {
  createMountedContextTestRuntime,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as catalogModule } from "@chase-sets/catalog";
import { module as commercialTermsModule } from "@chase-sets/commercial-terms";
import { createCommercialTermsResolver } from "@chase-sets/commercial-terms/server";
import { module as discoveryModule } from "@chase-sets/discovery";
import { module as fulfillmentModule } from "@chase-sets/fulfillment";
import { module as identityModule } from "@chase-sets/identity";
import { module as inventoryModule } from "@chase-sets/inventory";
import { module as marketplaceModule } from "@chase-sets/marketplace";
import { module as orderingModule } from "@chase-sets/ordering";
import { module as pricingModule } from "@chase-sets/pricing";
import { module as reputationModule } from "@chase-sets/reputation";
import { module as settlementModule } from "@chase-sets/settlement";
import { createFakePaymentProcessorGateway } from "../../support/runtime-support/fake-gateway";
import { module as paymentsModule } from "../..";

export const marketplaceSeedContextNames = [
  "catalog",
  "commercial-terms",
  "discovery",
  "fulfillment",
  "identity",
  "inventory",
  "marketplace",
  "ordering",
  "payments",
  "pricing",
  "reputation",
  "settlement",
] as const;

export const marketplaceSeedLifecycleContextOrder = [
  "catalog",
  "commercial-terms",
  "discovery",
  "identity",
  "inventory",
  "marketplace",
  "ordering",
  "payments",
  "fulfillment",
  "pricing",
  "reputation",
  "settlement",
] as const;

export type MarketplaceSeedRuntimePools = Readonly<
  Record<(typeof marketplaceSeedContextNames)[number], PgTransactionalPool>
>;

export function createMarketplaceSeedRuntime(pools: MarketplaceSeedRuntimePools) {
  const commercialTermsResolver = createCommercialTermsResolver({
    db: pools["commercial-terms"],
  });

  return createMountedContextTestRuntime([
    { contextName: "catalog", module: catalogModule, pool: pools.catalog, ports: undefined },
    {
      contextName: "commercial-terms",
      module: commercialTermsModule,
      pool: pools["commercial-terms"],
      ports: undefined,
    },
    { contextName: "discovery", module: discoveryModule, pool: pools.discovery, ports: undefined },
    {
      contextName: "fulfillment",
      module: fulfillmentModule,
      pool: pools.fulfillment,
      ports: undefined,
    },
    { contextName: "identity", module: identityModule, pool: pools.identity, ports: undefined },
    { contextName: "inventory", module: inventoryModule, pool: pools.inventory, ports: undefined },
    {
      contextName: "marketplace",
      module: marketplaceModule,
      pool: pools.marketplace,
      ports: { commercialTermsResolver },
    },
    {
      contextName: "ordering",
      module: orderingModule,
      pool: pools.ordering,
      ports: { commercialTermsResolver },
    },
    {
      contextName: "payments",
      module: paymentsModule,
      pool: pools.payments,
      ports: {
        processorGateway: createFakePaymentProcessorGateway(),
      },
    },
    { contextName: "pricing", module: pricingModule, pool: pools.pricing, ports: undefined },
    {
      contextName: "reputation",
      module: reputationModule,
      pool: pools.reputation,
      ports: undefined,
    },
    {
      contextName: "settlement",
      module: settlementModule,
      pool: pools.settlement,
      ports: undefined,
    },
  ] as const);
}
