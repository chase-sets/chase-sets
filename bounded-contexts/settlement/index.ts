export { default as contextManifest } from "./context.json";

import { buildEventSubscriptionsFromManifest, defineBoundedContextModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import {
  settlementRetentionExemptions,
  settlementRetentionSchemaMigrations,
  settlementRetentionSweeps,
} from "./support/runtime-support/retention-policy";
import type { SettlementHostPorts, SettlementServices } from "./support/runtime-support/services";
import { buildSettlementApi, buildSettlementMoneyMovementWebhookApi } from "./api";
import { createSettlementServices } from "./support/runtime-support/services";
import { settlementSchemaMigrations, settlementSchemaSql } from "./support/runtime-support/schema";
import { seedSettlementDatabase } from "./support/runtime-support/seed";
import { buildSettlementPaymentInputProjectionHandlers } from "./features/wallets/integrations/payment-source/payment-source-projection";
import { buildSettlementSupportHoldProjectionHandlers } from "./features/wallets/integrations/support-source/support-source-projection";
import { buildSettlementFulfillmentSourceProjectionHandlers } from "./features/wallets/integrations/fulfillment-source/fulfillment-source-projection";
import {
  buildSettlementIdentityAccountRiskSourceProjectionHandlers,
  buildSettlementPaymentsAccountRiskSourceProjectionHandlers,
  buildSettlementReputationAccountRiskSourceProjectionHandlers,
} from "./features/wallets/integrations/account-risk-source/account-risk-source-projection";
import { createSettlementPayoutReadinessMcpHandlers } from "./features/payout-readiness/api/mcp";
import { createSettlementPayoutMcpHandlers } from "./features/payouts/api/mcp";
import { createSettlementWalletMcpHandlers } from "./features/wallets/api/mcp";

export const module = defineBoundedContextModule<SettlementServices, PgTransactionalPool, SettlementHostPorts>({
  manifest: contextManifest,
  schemaSql: settlementSchemaSql,
  retentionSweeps: settlementRetentionSweeps,
  retentionExemptions: settlementRetentionExemptions,
  schemaMigrations: [...settlementSchemaMigrations, ...settlementRetentionSchemaMigrations],
  createServices: (pool, ports) => createSettlementServices(pool, ports),
  buildApis: (services) => [buildSettlementApi(services), buildSettlementMoneyMovementWebhookApi(services)],
  buildMcpHandlers: (services) => {
    const wallets = createSettlementWalletMcpHandlers(services.wallets);
    const payouts = createSettlementPayoutMcpHandlers(services.payouts);
    const payoutReadiness = createSettlementPayoutReadinessMcpHandlers(services.payoutReadiness);

    return {
      toolHandlers: {
        ...wallets.toolHandlers,
        ...payouts.toolHandlers,
        ...payoutReadiness.toolHandlers,
      },
      resourceHandlers: {
        ...wallets.resourceHandlers,
        ...payouts.resourceHandlers,
      },
    };
  },
  projectionHandlerSets: (services) => services.projectors,
  buildSubscriptions: (services) =>
    buildEventSubscriptionsFromManifest({
      contextName: "settlement",
      manifest: contextManifest,
      handlers: {
        "payments.settlement-payment-input-projection": () =>
          buildSettlementPaymentInputProjectionHandlers(services.db, services.wallets),
        "platform-operations.settlement-support-hold-projection": {
          buildHandlers: () => buildSettlementSupportHoldProjectionHandlers(services.db),
          filterToEventTypes: true,
        },
        "payments.settlement-support-hold-projection": {
          buildHandlers: () => buildSettlementSupportHoldProjectionHandlers(services.db),
          filterToEventTypes: true,
        },
        "fulfillment.settlement-fulfillment-source-projection": () =>
          buildSettlementFulfillmentSourceProjectionHandlers(services.db),
        "identity.settlement-account-risk-source-projection": {
          subscriptionName: "settlement.identity-account-risk-source-projection",
          buildHandlers: () => buildSettlementIdentityAccountRiskSourceProjectionHandlers(services.db),
        },
        "marketplace.settlement-account-risk-source-projection": {
          subscriptionName: "settlement.marketplace-review-account-risk-source-projection",
          buildHandlers: () => buildSettlementReputationAccountRiskSourceProjectionHandlers(services.db),
        },
        "payments.settlement-account-risk-source-projection": {
          subscriptionName: "settlement.payments-fraud-account-risk-source-projection",
          buildHandlers: () => buildSettlementPaymentsAccountRiskSourceProjectionHandlers(services.db),
          filterToEventTypes: true,
        },
      },
    }),
  seed: seedSettlementDatabase,
});
