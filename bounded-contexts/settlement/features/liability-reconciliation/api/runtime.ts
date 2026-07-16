import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { MoneyMovementGateway } from "@chase-sets/money-movement";
import { createId } from "@chase-sets/primitives/typed-ids";
import { normalizeCurrencyCode } from "../../../support/runtime-support/common";
import {
  DEFAULT_LIABILITY_RECONCILIATION_TOLERANCE_AMOUNT,
  evaluateLiabilityReconciliation,
  listLiabilityReconciliationRuns,
  queryLiabilitySnapshot,
  recordLiabilityReconciliationRun,
  type LiabilityReconciliationResult,
  type SettlementLiabilityReconciliationRunRow,
} from "../read-model/liability-reconciliation";

export type LiabilityReconciliationServices = Readonly<{
  /**
   * Compare the ledger's liability total (Σ wallet balances + in-flight payout
   * demand) against the provider platform balance, record the run, and return
   * the evaluated result. `shortfall-alarm` means the provider balance no longer
   * covers what the platform owes.
   */
  reconcileLedgerAgainstProvider: (
    params?: Readonly<{ currencyCode?: string; toleranceAmount?: string }>,
  ) => Promise<LiabilityReconciliationResult>;
  listReconciliationRuns: (
    params?: Readonly<{ limit?: number }>,
  ) => Promise<readonly SettlementLiabilityReconciliationRunRow[]>;
}>;

export function createLiabilityReconciliationRuntime(
  deps: Readonly<{
    db: PgQueryable;
    moneyMovementGateway: MoneyMovementGateway;
    toleranceAmount?: string;
  }>,
): LiabilityReconciliationServices {
  const defaultToleranceAmount = deps.toleranceAmount ?? DEFAULT_LIABILITY_RECONCILIATION_TOLERANCE_AMOUNT;

  return {
    async reconcileLedgerAgainstProvider(params) {
      const currencyCode = normalizeCurrencyCode(params?.currencyCode ?? "usd");
      const toleranceAmount = params?.toleranceAmount ?? defaultToleranceAmount;
      const startedAt = new Date().toISOString();
      const [snapshot, providerBalance] = await Promise.all([
        queryLiabilitySnapshot(deps.db, currencyCode),
        deps.moneyMovementGateway.retrievePlatformBalance({ currencyCode }),
      ]);
      const result = evaluateLiabilityReconciliation(
        {
          currencyCode,
          walletLiabilityAmount: snapshot.walletLiabilityAmount,
          inFlightPayoutDemandAmount: snapshot.inFlightPayoutDemandAmount,
          providerAvailableAmount: providerBalance.availableAmount,
        },
        toleranceAmount,
      );
      await recordLiabilityReconciliationRun(deps.db, {
        reconciliationRunId: createId("rec"),
        result,
        startedAt,
        completedAt: new Date().toISOString(),
      });
      return result;
    },
    listReconciliationRuns: (params) => listLiabilityReconciliationRuns(deps.db, params ?? {}),
  };
}
