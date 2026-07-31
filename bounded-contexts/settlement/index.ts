export { default as contextManifest } from "./context.json";

import {
  buildEventSubscriptionsFromManifest,
  defineBoundedContextModule,
  type BcEventSubscriptionHandler,
} from "@chase-sets/bounded-context-module";
import type { InventoryRecoveredItemValueReportedPayload } from "@chase-sets/event-core/public-event-payloads";
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
import { settlementUnloggedProjectionSchemaMigrations } from "./support/runtime-support/unlogged-projection-migrations";
import {
  inspectSettlementSeedState,
  reconcileSettlementBootstrapState,
  seedSettlementDatabase,
} from "./support/runtime-support/seed";
import { buildSettlementPaymentInputProjectionHandlers } from "./features/wallets/integrations/payment-source/payment-source-projection";
import { buildSettlementSupportHoldProjectionHandlers } from "./features/wallets/integrations/support-source/support-source-projection";
import { buildSettlementCoverageReservationHandlers } from "./features/liability-allocation/integrations/coverage-request/coverage-reservation-projection";
import { buildSupportHoldLifecycleReactionHandlers } from "./features/wallets/integrations/support-hold-lifecycle/support-hold-lifecycle-reaction";
import { buildSettlementFulfillmentSourceProjectionHandlers } from "./features/wallets/integrations/fulfillment-source/fulfillment-source-projection";
import {
  buildSettlementIdentityAccountRiskSourceProjectionHandlers,
  buildSettlementPaymentsAccountRiskSourceProjectionHandlers,
  buildSettlementReputationAccountRiskSourceProjectionHandlers,
} from "./features/wallets/integrations/account-risk-source/account-risk-source-projection";
import { createSettlementPayoutReadinessMcpHandlers } from "./features/payout-readiness/api/mcp";
import { createSettlementPayoutMcpHandlers } from "./features/payouts/api/mcp";
import { createSettlementWalletMcpHandlers } from "./features/wallets/api/mcp";
import { getProtectionCoverageByRemedy } from "./features/protection-coverage/read-model/protection-coverage-queries";
import { SettlementDomainError } from "./support/runtime-support/common";

export const module = defineBoundedContextModule<SettlementServices, PgTransactionalPool, SettlementHostPorts>({
  manifest: contextManifest,
  schemaSql: settlementSchemaSql,
  retentionSweeps: settlementRetentionSweeps,
  retentionExemptions: settlementRetentionExemptions,
  schemaMigrations: [
    ...settlementUnloggedProjectionSchemaMigrations,
    ...settlementSchemaMigrations,
    ...settlementRetentionSchemaMigrations,
  ],
  createServices: (pool, ports) => createSettlementServices(pool, ports),
  buildApis: (services) => [
    { mountPath: "/api/settlement", contextMountOrdinal: 1, router: buildSettlementApi(services) },
    {
      mountPath: "/api/settlement/provider",
      contextMountOrdinal: 2,
      router: buildSettlementMoneyMovementWebhookApi(services),
    },
  ],
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
          buildSettlementPaymentInputProjectionHandlers(services.db, services.wallets, services.protectionCoverage),
        "platform-operations.settlement-support-hold-projection": () =>
          buildSettlementSupportHoldProjectionHandlers(services.db),
        "payments.settlement-support-hold-projection": () => buildSettlementSupportHoldProjectionHandlers(services.db),
        "settlement.settlement-support-hold-projection": () =>
          buildSettlementSupportHoldProjectionHandlers(services.db),
        "platform-operations.settlement-liability-allocation-reserve-projection": () =>
          buildSettlementCoverageReservationHandlers(services.protectionCoverage),
        "platform-operations.settlement-support-hold-lifecycle-projection": () =>
          buildSupportHoldLifecycleReactionHandlers(services.supportHoldLifecycle),
        "fulfillment.settlement-fulfillment-source-projection": () =>
          buildSettlementFulfillmentSourceProjectionHandlers(services.db),
        "inventory.settlement-inventory-recovery-workflow": () => ({
          "inventory.recovered-item.value-reported.v1": async (event: Parameters<BcEventSubscriptionHandler>[0]) => {
            const data = event.data as InventoryRecoveredItemValueReportedPayload;
            const coverage = await getProtectionCoverageByRemedy(services.db, data.remedyId);
            if (!coverage || coverage.status !== "settled") {
              throw new SettlementDomainError("Recovered value is waiting for its originating settled coverage.");
            }
            await services.protectionCoverage.recordRecovery(
              {
                coverageId: coverage.coverage_id,
                remedyId: data.remedyId,
                recoveredItemId: data.recoveredItemId,
                returnShipmentId: data.returnShipmentId,
                recoveryId: data.recoveryId,
                recoveryType: data.recoveryType,
                grossAmount: data.grossAmount,
                costAmount: data.costAmount,
                currencyCode: data.currencyCode,
                policyVersion: data.policyVersion,
                evidenceReferences: data.evidenceReferences,
                causationId: event.id,
                occurredAt: data.recordedAt,
              },
              { tenantId: event.tenantId, audit: event.audit, trace: event.trace },
            );
          },
        }),
        "identity.settlement-account-risk-source-projection": () =>
          buildSettlementIdentityAccountRiskSourceProjectionHandlers(services.db, { policies: services.policies }),
        "marketplace.settlement-account-risk-source-projection": () =>
          buildSettlementReputationAccountRiskSourceProjectionHandlers(services.db, {
            policies: services.policies,
          }),
        "payments.settlement-account-risk-source-projection": () =>
          buildSettlementPaymentsAccountRiskSourceProjectionHandlers(services.db, { policies: services.policies }),
      },
    }),
  seedProfiles: ["critical-bootstrap", "scenario-seed"],
  seed: seedSettlementDatabase,
  inspectSeedState: (pool, options) => inspectSettlementSeedState(pool, options),
  reconcileBootstrapState: reconcileSettlementBootstrapState,
});
