import type { GoogleShoppingSyncMode } from "@chase-sets/discovery/server";
import type { PaymentsServices } from "@chase-sets/payments/server";
import type { SettlementServices } from "@chase-sets/settlement/server";
import type { PlatformControlPlane } from "@chase-sets/platform-runtime/control-plane";
import { createWorkSignalCleanupRunner } from "@chase-sets/platform-runtime/projection-wake-scheduler";
import { createRetentionSweepRunner } from "@chase-sets/platform-runtime/retention-sweep";
import type { WorkerRunner } from "@chase-sets/platform-runtime/worker";
import type { PlatformWorkerConfig } from "./config";

export type ScheduledRunnerLogger = Readonly<{
  info: (message: string, fields?: Readonly<Record<string, unknown>>) => void;
  warn: (message: string, fields?: Readonly<Record<string, unknown>>) => void;
}>;

export type RegisteredScheduledRunnerConfig = Pick<
  PlatformWorkerConfig,
  | "workerId"
  | "leaseTtlMs"
  | "paymentReconciliationIntervalMs"
  | "paymentDeadlineSweepIntervalMs"
  | "supportRequestDeadlineSweepIntervalMs"
  | "customerFeedbackAttentionDigestIntervalMs"
  | "customerFeedbackAttentionTeamRecipientUserIds"
  | "reviewWindowSweepIntervalMs"
  | "reviewOpportunityReminderSweepIntervalMs"
  | "sellerAvailabilityRestoreSweepIntervalMs"
  | "sellerAwayWindowStartSweepIntervalMs"
  | "sellerFundsReleaseIntervalMs"
  | "spendHoldSweepIntervalMs"
  | "payoutReconciliationIntervalMs"
  | "liabilityReconciliationIntervalMs"
  | "marketRollupsCloserIntervalMs"
  | "settlementAccountLinkageCloserIntervalMs"
  | "gmvReconciliationIntervalMs"
  | "catalogProviderScopeRefreshIntervalMs"
  | "googleMerchant"
  | "googleShoppingMaintenanceIntervalMs"
  | "googleShoppingMaintenanceBatchSize"
  | "googleShoppingRefreshWindowDays"
  | "googleShoppingDiagnosticsIntervalMs"
  | "googleShoppingDiagnosticsBatchSize"
  | "discoverySearchEmbeddings"
>;

export function createRegisteredScheduledRunners({
  services,
  config: input,
  controlPlane,
  logger,
  workSignalCleanup,
  retentionSweep,
}: Readonly<{
  services: Readonly<Record<string, unknown>>;
  config: RegisteredScheduledRunnerConfig;
  controlPlane: PlatformControlPlane;
  logger: ScheduledRunnerLogger;
  workSignalCleanup: () => Omit<Parameters<typeof createWorkSignalCleanupRunner>[0], "controlPlane">;
  retentionSweep: () => Omit<Parameters<typeof createRetentionSweepRunner>[0], "controlPlane">;
}>): readonly WorkerRunner[] {
  const payments = services.payments as PaymentsServices | undefined;
  const customerFeedback = services["customer-feedback"] as
    | {
        runAttentionDigest?: (
          input: {
            windowMinutes?: number;
            maxItemsPerGroup?: number;
            teamRecipientUserIds?: readonly string[];
          },
          context: typeof SYSTEM_CONTEXT,
        ) => Promise<{
          groupsRequested: number;
          groupsAlreadyRequested: number;
          noRecipientGroups: number;
          itemCount: number;
        }>;
      }
    | undefined;
  const ordering = services.ordering as
    | {
        orders?: {
          sweepBreachedPaymentDeadlines?: (
            params: { now?: Date; limit?: number } | undefined,
            context: typeof SYSTEM_CONTEXT,
          ) => Promise<{ checked: number; cancelled: number; progressed: number; failed: number }>;
        };
      }
    | undefined;
  const platformOperations = services["platform-operations"] as
    | {
        supportRequests?: {
          sweepSupportRequestDeadlines?: (
            params: { now?: string; limit?: number },
            context: typeof SYSTEM_CONTEXT,
          ) => Promise<{
            autoResolved: number;
            fallbackEscalated: number;
            escalated: number;
            autoClosed: number;
            responseRemindersEmitted: number;
            reviewRemindersEmitted: number;
            returnRefundsReleased: number;
          }>;
        };
        opsDashboard?: {
          recordReconciliationRun?: (params: {
            yearMonth: string;
            tapeGmvAmount: string;
            ledgerSaleAmount: string;
            now?: string;
          }) => Promise<{ status: "ok" | "drift-alarm" }>;
        };
      }
    | undefined;
  const marketplaceReviews = (services.marketplace as { reviews?: unknown } | undefined)?.reviews as
    | {
        sweepReviewWindowExpirations?: (
          params: { now?: string; limit?: number },
          context: typeof SYSTEM_CONTEXT,
        ) => Promise<{ counterpartPairsRevealed: number; windowExpiredRevealed: number }>;
        sweepReviewOpportunityReminders?: (params: {
          now?: string;
          limit?: number;
        }) => Promise<{ remindersSent: number }>;
      }
    | undefined;
  const marketplaceListings = (services.marketplace as { listings?: unknown } | undefined)?.listings as
    | {
        sweepDueSellerAvailabilityRestores?: (
          params: { now?: string; limit?: number } | undefined,
          context: typeof SYSTEM_CONTEXT,
        ) => Promise<{ checked: number; restored: number; skipped: number }>;
        sweepDueSellerAwayWindowStarts?: (
          params: { now?: string; limit?: number } | undefined,
          context: typeof SYSTEM_CONTEXT,
        ) => Promise<{ checked: number; started: number; skipped: number }>;
      }
    | undefined;
  const pricing = services.pricing as
    | {
        marketRollups?: {
          runDailyRollupCloser?: (params?: { now?: string; trailingWindowDays?: number; limit?: number }) => Promise<{
            rollupDaysRecomputed: number;
            marketStateSnapshotsRecomputed: number;
            productAggregatesRecomputed: number;
            platformDaysRecomputed: number;
          }>;
          getPlatformGmvForMonth?: (params: { yearMonth: string }) => Promise<string>;
        };
      }
    | undefined;
  const settlement = services.settlement as SettlementServices | undefined;
  const fulfillment = services.fulfillment as
    | {
        shipments?: {
          listStalePostageOperationLocators?: (params: {
            staleBefore: string;
            afterUpdatedAt?: string | null;
            afterOperationId?: string | null;
            limit?: number;
          }) => Promise<readonly { operationId: string; tenantId: string; shipmentId: string; updatedAt: string }[]>;
          reconcilePostageOperationLocator?: (locator: {
            operationId: string;
            tenantId: string;
            shipmentId: string;
          }) => Promise<{ outcome: string }>;
          reconcileStalePostageLabelPurchases?: (params?: {
            staleAfterMs?: number;
            limit?: number;
          }) => Promise<{ checked: number; attached: number; voided: number; failed: number }>;
          reconcileStalePostageLabelVoids?: (params?: {
            staleAfterMs?: number;
            limit?: number;
          }) => Promise<{ checked: number; failed: number }>;
        };
        returnShipments?: {
          sweepReturnShipmentDeadlines?: (
            params: { now?: string; limit?: number } | undefined,
            context: typeof SYSTEM_CONTEXT,
          ) => Promise<{ checked: number; expired: number; skipped: number }>;
          labelPurchase?: {
            reconcileStaleReturnLabelPurchases?: (params?: {
              staleAfterMs?: number;
              limit?: number;
            }) => Promise<{ checked: number; attached: number; failed: number }>;
          };
        };
      }
    | undefined;
  const discovery = services.discovery as
    | {
        googleShoppingSync?: {
          processScheduledMaintenanceSync?: (input: {
            mode: GoogleShoppingSyncMode;
            limit?: number;
            refreshWindowDays?: number;
          }) => Promise<number>;
          processScheduledDiagnosticsRefresh?: (input: {
            mode: GoogleShoppingSyncMode;
            batchSize?: number;
          }) => Promise<number>;
        };
        searchEmbeddings?: {
          processNextBatch: (input?: { limit?: number; signal?: AbortSignal }) => Promise<{
            processed: number;
            embedded: number;
            totalTokens: number;
          }>;
        };
      }
    | undefined;
  const durableJobRetention = createDurableJobRetentionTask(services, logger);
  const runners: WorkerRunner[] = [];

  if (payments && input.paymentReconciliationIntervalMs) {
    runners.push(
      createScheduledJobRunner(
        "payments.reconciliation",
        input.paymentReconciliationIntervalMs,
        controlPlane,
        async () => {
          const result = await payments.payments.scanPaymentsNeedingReconciliation(
            {
              limit: 100,
              claimOwnerId: input.workerId,
              claimTtlMs: input.leaseTtlMs * 4,
            },
            SYSTEM_CONTEXT,
          );
          logger.info("Payment reconciliation scan completed.", {
            type: "payments.reconciliation",
            result,
          });
          return result.checked;
        },
      ),
    );
  }

  const sweepBreachedPaymentDeadlines = ordering?.orders?.sweepBreachedPaymentDeadlines;
  if (sweepBreachedPaymentDeadlines && input.paymentDeadlineSweepIntervalMs) {
    runners.push(
      createScheduledJobRunner(
        "ordering.payment-deadline-sweep",
        input.paymentDeadlineSweepIntervalMs,
        controlPlane,
        async () => {
          const result = await sweepBreachedPaymentDeadlines({ limit: 100 }, SYSTEM_CONTEXT);
          logger.info("Ordering payment deadline sweep completed.", {
            type: "ordering.payment-deadline-sweep",
            result,
          });
          if (result.failed > 0) {
            throw new Error(`Payment deadline sweep failed for ${result.failed} candidate(s).`);
          }
          return result.cancelled + result.progressed;
        },
      ),
    );
  }

  const sweepSupportRequestDeadlines = platformOperations?.supportRequests?.sweepSupportRequestDeadlines;
  if (sweepSupportRequestDeadlines && input.supportRequestDeadlineSweepIntervalMs) {
    runners.push(
      createScheduledJobRunner(
        "platform-operations.support-request-deadline-sweep",
        input.supportRequestDeadlineSweepIntervalMs,
        controlPlane,
        async () => {
          const result = await sweepSupportRequestDeadlines({ limit: 100 }, SYSTEM_CONTEXT);
          logger.info("Support request deadline sweep completed.", {
            type: "platform-operations.support-request-deadline-sweep",
            result,
          });
          return (
            result.autoResolved +
            result.fallbackEscalated +
            result.escalated +
            result.autoClosed +
            result.responseRemindersEmitted +
            result.reviewRemindersEmitted +
            result.returnRefundsReleased
          );
        },
      ),
    );
  }

  if (customerFeedback?.runAttentionDigest && input.customerFeedbackAttentionDigestIntervalMs) {
    runners.push(
      createScheduledJobRunner(
        "customer-feedback.attention-digest",
        input.customerFeedbackAttentionDigestIntervalMs,
        controlPlane,
        async () => {
          const result = await customerFeedback.runAttentionDigest!(
            {
              windowMinutes: Math.max(1, Math.floor(input.customerFeedbackAttentionDigestIntervalMs! / 60_000)),
              maxItemsPerGroup: 25,
              teamRecipientUserIds: input.customerFeedbackAttentionTeamRecipientUserIds,
            },
            SYSTEM_CONTEXT,
          );
          logger.info("Customer Feedback attention digest completed.", {
            type: "customer-feedback.attention-digest.completed",
            result,
          });
          return result.groupsRequested;
        },
      ),
    );
  }

  const sweepReviewWindowExpirations = marketplaceReviews?.sweepReviewWindowExpirations;
  if (sweepReviewWindowExpirations && input.reviewWindowSweepIntervalMs) {
    runners.push(
      createScheduledJobRunner(
        "marketplace.review-window-sweep",
        input.reviewWindowSweepIntervalMs,
        controlPlane,
        async () => {
          const result = await sweepReviewWindowExpirations({ limit: 100 }, SYSTEM_CONTEXT);
          logger.info("Marketplace review-window reveal sweep completed.", {
            type: "marketplace.review-window-sweep",
            result,
          });
          return result.counterpartPairsRevealed + result.windowExpiredRevealed;
        },
      ),
    );
  }

  const sweepReviewOpportunityReminders = marketplaceReviews?.sweepReviewOpportunityReminders;
  if (sweepReviewOpportunityReminders && input.reviewOpportunityReminderSweepIntervalMs) {
    runners.push(
      createScheduledJobRunner(
        "marketplace.review-opportunity-reminder-sweep",
        input.reviewOpportunityReminderSweepIntervalMs,
        controlPlane,
        async () => {
          const result = await sweepReviewOpportunityReminders({ limit: 100 });
          logger.info("Marketplace review-opportunity reminder sweep completed.", {
            type: "marketplace.review-opportunity-reminder-sweep",
            result,
          });
          return result.remindersSent;
        },
      ),
    );
  }

  const sweepDueSellerAvailabilityRestores = marketplaceListings?.sweepDueSellerAvailabilityRestores;
  if (sweepDueSellerAvailabilityRestores && input.sellerAvailabilityRestoreSweepIntervalMs) {
    runners.push(
      createScheduledJobRunner(
        "marketplace.seller-availability-restore-sweep",
        input.sellerAvailabilityRestoreSweepIntervalMs,
        controlPlane,
        async () => {
          const result = await sweepDueSellerAvailabilityRestores({ limit: 100 }, SYSTEM_CONTEXT);
          logger.info("Marketplace seller-availability auto-resume sweep completed.", {
            type: "marketplace.seller-availability-restore-sweep",
            result,
          });
          return result.restored + result.skipped;
        },
      ),
    );
  }

  const sweepDueSellerAwayWindowStarts = marketplaceListings?.sweepDueSellerAwayWindowStarts;
  if (sweepDueSellerAwayWindowStarts && input.sellerAwayWindowStartSweepIntervalMs) {
    runners.push(
      createScheduledJobRunner(
        "marketplace.seller-away-window-start-sweep",
        input.sellerAwayWindowStartSweepIntervalMs,
        controlPlane,
        async () => {
          const result = await sweepDueSellerAwayWindowStarts({ limit: 100 }, SYSTEM_CONTEXT);
          logger.info("Marketplace seller away-window start sweep completed.", {
            type: "marketplace.seller-away-window-start-sweep",
            result,
          });
          return result.started + result.skipped;
        },
      ),
    );
  }

  const runDailyRollupCloser = pricing?.marketRollups?.runDailyRollupCloser;
  if (runDailyRollupCloser && input.marketRollupsCloserIntervalMs) {
    runners.push(
      createScheduledJobRunner(
        "pricing.market-rollups-closer",
        input.marketRollupsCloserIntervalMs,
        controlPlane,
        async () => {
          const result = await runDailyRollupCloser({ limit: 500 });
          logger.info("Pricing market-rollups closer completed.", {
            type: "pricing.market-rollups-closer",
            result,
          });
          return (
            result.rollupDaysRecomputed + result.marketStateSnapshotsRecomputed + result.productAggregatesRecomputed
          );
        },
      ),
    );
  }

  const runAccountLinkageCloser = settlement?.accountLinkage?.runAccountLinkageCloser;
  if (runAccountLinkageCloser && input.settlementAccountLinkageCloserIntervalMs) {
    runners.push(
      createScheduledJobRunner(
        "settlement.account-linkage-closer",
        input.settlementAccountLinkageCloserIntervalMs,
        controlPlane,
        async () => {
          const result = await runAccountLinkageCloser({ limit: 500 });
          logger.info("Settlement account-linkage closer completed.", {
            type: "settlement.account-linkage-closer",
            result,
          });
          return result.flagsPublished;
        },
      ),
    );
  }

  const getPlatformGmvForMonth = pricing?.marketRollups?.getPlatformGmvForMonth;
  const getLedgerSaleCreditTotalForMonth = settlement?.wallets?.getLedgerSaleCreditTotalForMonth;
  const recordReconciliationRun = platformOperations?.opsDashboard?.recordReconciliationRun;
  if (
    getPlatformGmvForMonth &&
    getLedgerSaleCreditTotalForMonth &&
    recordReconciliationRun &&
    input.gmvReconciliationIntervalMs
  ) {
    runners.push(
      createScheduledJobRunner(
        "platform-operations.gmv-reconciliation",
        input.gmvReconciliationIntervalMs,
        controlPlane,
        async () => {
          // Reconciles the most recently completed calendar month: on any
          // given day, the current month is still accumulating trades and
          // settlements, so comparing it would show expected, not
          // anomalous, "drift". A trailing re-check of the last completed
          // month (rather than a strict once-per-month run) mirrors the
          // rollup closer's own trailing-window re-derivation, catching a
          // late refund or settlement correction that lands after the
          // month first closes.
          const lastMonthDate = new Date();
          lastMonthDate.setUTCDate(0);
          const yearMonth = lastMonthDate.toISOString().slice(0, 7);
          const [tapeGmvAmount, ledgerSaleAmount] = await Promise.all([
            getPlatformGmvForMonth({ yearMonth }),
            getLedgerSaleCreditTotalForMonth({ yearMonth }),
          ]);
          const run = await recordReconciliationRun({ yearMonth, tapeGmvAmount, ledgerSaleAmount });
          const log = run.status === "drift-alarm" ? logger.warn : logger.info;
          log("Platform-operations GMV reconciliation completed.", {
            type: "platform-operations.gmv-reconciliation",
            yearMonth,
            tapeGmvAmount,
            ledgerSaleAmount,
            status: run.status,
          });
          return 1;
        },
      ),
    );
  }

  const catalogProviderScopeDiscovery = (
    services.catalog as
      | {
          providerScopeDiscovery?: {
            processScheduledRefresh: (input: { context: typeof SYSTEM_CONTEXT; triggeredBy?: string }) => Promise<{
              scanId: string;
              providersDue: number;
              observationsRecorded: number;
              mappingsProposed: number;
              failures: number;
              providers: readonly { providerKey: string; status: string; errorMessage: string | null }[];
            }>;
          };
        }
      | undefined
  )?.providerScopeDiscovery;
  if (catalogProviderScopeDiscovery && input.catalogProviderScopeRefreshIntervalMs) {
    runners.push(
      createScheduledJobRunner(
        "catalog.provider-scope-refresh",
        input.catalogProviderScopeRefreshIntervalMs,
        controlPlane,
        async () => {
          const result = await catalogProviderScopeDiscovery.processScheduledRefresh({
            context: SYSTEM_CONTEXT,
            triggeredBy: "schedule",
          });
          logger.info("Catalog provider scope refresh sweep completed.", {
            type: "catalog.provider-scope-refresh",
            result,
          });
          // m72 lesson: scheduled failures must never pass silently. Every
          // provider outcome is recorded on the schedule row first (the
          // scheduled-alerting watch reads those rows), then a failed provider
          // fails the runner so the worker logs an error for this sweep too.
          if (result.failures > 0) {
            const failed = result.providers
              .filter((provider) => provider.status === "failed")
              .map((provider) => `${provider.providerKey}: ${provider.errorMessage ?? "unknown error"}`)
              .join("; ");
            throw new Error(`Catalog provider scope refresh failed for ${result.failures} provider(s): ${failed}`);
          }
          return result.observationsRecorded + result.mappingsProposed;
        },
      ),
    );
  }

  if (settlement && input.sellerFundsReleaseIntervalMs) {
    runners.push(
      createScheduledJobRunner(
        "settlement.seller-funds-release",
        input.sellerFundsReleaseIntervalMs,
        controlPlane,
        async () => {
          const result = await settlement.wallets.releaseMaturePendingSaleCredits(
            {
              limit: 500,
              claimOwnerId: input.workerId,
              claimTtlMs: input.leaseTtlMs * 4,
            },
            SYSTEM_CONTEXT,
          );
          logger.info("Seller funds release completed.", {
            type: "settlement.funds-release",
            result,
          });
          return typeof result === "object" && result && "released" in result
            ? Number((result as { released: unknown }).released)
            : 0;
        },
      ),
    );
  }

  if (settlement && input.spendHoldSweepIntervalMs) {
    runners.push(
      createScheduledJobRunner(
        "settlement.spend-hold-sweep",
        input.spendHoldSweepIntervalMs,
        controlPlane,
        async () => {
          // Backstop against buyer-spend holds leaking on payments that never
          // conclude: release any hold whose expiry has elapsed, returning the
          // reserved credit to the buyer's spendable balance.
          const result = await settlement.wallets.sweepExpiredSpendHolds({ limit: 500 }, SYSTEM_CONTEXT);
          logger.info("Spend-hold sweep completed.", {
            type: "settlement.spend-hold-sweep",
            result,
          });
          return typeof result === "object" && result && "released" in result
            ? Number((result as { released: unknown }).released)
            : 0;
        },
      ),
    );
  }

  if (settlement && input.payoutReconciliationIntervalMs) {
    runners.push(
      createScheduledJobRunner(
        "settlement.payout-reconciliation",
        input.payoutReconciliationIntervalMs,
        controlPlane,
        async () => {
          const result = await settlement.payouts.reconcilePayoutsNeedingAttention(
            {
              limit: 100,
              claimOwnerId: input.workerId,
              claimTtlMs: input.leaseTtlMs * 4,
            },
            SYSTEM_CONTEXT,
          );
          logger.info("Payout reconciliation completed.", {
            type: "settlement.reconciliation",
            result,
          });
          return typeof result === "object" && result && "checked" in result
            ? Number((result as { checked: unknown }).checked)
            : 0;
        },
      ),
    );
  }

  if (settlement && input.liabilityReconciliationIntervalMs) {
    runners.push(
      createScheduledJobRunner(
        "settlement.liability-reconciliation",
        input.liabilityReconciliationIntervalMs,
        controlPlane,
        async () => {
          // Solvency invariant: the provider platform balance must cover what the
          // platform owes sellers (Σ wallet liabilities + in-flight payout
          // demand). A shortfall beyond tolerance is a leak signal (double
          // transfer, missed reversal) that is otherwise invisible until
          // cash-out. Detective control only -- it never moves money.
          const result = await settlement.liabilityReconciliation.reconcileLedgerAgainstProvider({
            currencyCode: "usd",
          });
          const log = result.status === "shortfall-alarm" ? logger.warn : logger.info;
          log("Settlement liability reconciliation completed.", {
            type: "settlement.liability-reconciliation",
            status: result.status,
            currencyCode: result.currencyCode,
            expectedObligationAmount: result.expectedObligationAmount,
            providerAvailableAmount: result.providerAvailableAmount,
            driftAmount: result.driftAmount,
          });
          return result.status === "shortfall-alarm" ? 1 : 0;
        },
      ),
    );
  }

  if (
    fulfillment?.shipments?.listStalePostageOperationLocators &&
    fulfillment.shipments.reconcilePostageOperationLocator
  ) {
    runners.push(
      createScheduledJobRunner(
        "fulfillment.postage-operation-reconciliation",
        5 * 60 * 1000,
        controlPlane,
        async () => {
          const staleBefore = new Date(Date.now() - 5 * 60 * 1000).toISOString();
          let afterUpdatedAt: string | null = null;
          let afterOperationId: string | null = null;
          let checked = 0;
          let quarantined = 0;
          while (true) {
            const locators = await fulfillment.shipments!.listStalePostageOperationLocators!({
              staleBefore,
              afterUpdatedAt,
              afterOperationId,
              limit: 100,
            });
            for (const locator of locators) {
              const result = await fulfillment.shipments!.reconcilePostageOperationLocator!(locator);
              checked += 1;
              if (result.outcome === "quarantined") quarantined += 1;
            }
            if (locators.length < 100) break;
            const last = locators.at(-1)!;
            afterUpdatedAt = last.updatedAt;
            afterOperationId = last.operationId;
          }
          logger.info("Fulfillment postage operation reconciliation completed.", {
            type: "fulfillment.postage-operation-reconciliation",
            checked,
            quarantined,
          });
          return checked;
        },
      ),
    );
  } else if (fulfillment?.shipments?.reconcileStalePostageLabelPurchases) {
    runners.push(
      createScheduledJobRunner(
        "fulfillment.postage-label-purchase-reconciliation",
        5 * 60 * 1000,
        controlPlane,
        async () => {
          const result = await fulfillment.shipments!.reconcileStalePostageLabelPurchases!({
            staleAfterMs: 5 * 60 * 1000,
            limit: 100,
          });
          logger.info("Fulfillment postage label purchase reconciliation completed.", {
            type: "fulfillment.postage-label-purchase-reconciliation",
            result,
          });
          return result.checked;
        },
      ),
    );
  }

  if (fulfillment?.shipments?.reconcileStalePostageLabelVoids) {
    runners.push(
      createScheduledJobRunner(
        "fulfillment.postage-label-void-reconciliation",
        5 * 60 * 1000,
        controlPlane,
        async () => {
          const result = await fulfillment.shipments!.reconcileStalePostageLabelVoids!({
            staleAfterMs: 24 * 60 * 60 * 1000,
            limit: 100,
          });
          logger.info("Fulfillment postage label void reconciliation completed.", {
            type: "fulfillment.postage-label-void-reconciliation",
            result,
          });
          return result.checked;
        },
      ),
    );
  }

  if (fulfillment?.returnShipments?.sweepReturnShipmentDeadlines) {
    runners.push(
      createScheduledJobRunner("fulfillment.return-shipment-deadline-sweep", 5 * 60 * 1000, controlPlane, async () => {
        const result = await fulfillment.returnShipments!.sweepReturnShipmentDeadlines!({ limit: 100 }, SYSTEM_CONTEXT);
        logger.info("Fulfillment return-shipment deadline sweep completed.", {
          type: "fulfillment.return-shipment-deadline-sweep",
          result,
        });
        return result.checked;
      }),
    );
  }

  if (fulfillment?.returnShipments?.labelPurchase?.reconcileStaleReturnLabelPurchases) {
    runners.push(
      createScheduledJobRunner(
        "fulfillment.return-label-purchase-reconciliation",
        5 * 60 * 1000,
        controlPlane,
        async () => {
          const result = await fulfillment.returnShipments!.labelPurchase!.reconcileStaleReturnLabelPurchases!({
            staleAfterMs: 5 * 60 * 1000,
            limit: 100,
          });
          logger.info("Fulfillment return-label purchase reconciliation completed.", {
            type: "fulfillment.return-label-purchase-reconciliation",
            result,
          });
          return result.checked;
        },
      ),
    );
  }

  if (
    discovery?.googleShoppingSync?.processScheduledMaintenanceSync &&
    input.googleMerchant.syncEnabled &&
    input.googleShoppingMaintenanceIntervalMs
  ) {
    runners.push(
      createScheduledJobRunner(
        "discovery.google-shopping-maintenance",
        input.googleShoppingMaintenanceIntervalMs,
        controlPlane,
        async () => {
          const processed = await discovery.googleShoppingSync!.processScheduledMaintenanceSync!({
            mode: input.googleMerchant.dryRun ? "dry-run" : "live",
            limit: input.googleShoppingMaintenanceBatchSize,
            refreshWindowDays: input.googleShoppingRefreshWindowDays,
          });
          logger.info("Google Shopping maintenance scan completed.", {
            type: "google-shopping.maintenance",
            processed,
            mode: input.googleMerchant.dryRun ? "dry-run" : "live",
          });
          return processed;
        },
      ),
    );
  }

  if (
    discovery?.googleShoppingSync?.processScheduledDiagnosticsRefresh &&
    input.googleMerchant.syncEnabled &&
    input.googleShoppingDiagnosticsIntervalMs
  ) {
    runners.push(
      createScheduledJobRunner(
        "discovery.google-shopping-diagnostics",
        input.googleShoppingDiagnosticsIntervalMs,
        controlPlane,
        async () => {
          const processed = await discovery.googleShoppingSync!.processScheduledDiagnosticsRefresh!({
            mode: input.googleMerchant.dryRun ? "dry-run" : "live",
            batchSize: input.googleShoppingDiagnosticsBatchSize,
          });
          logger.info("Google Shopping diagnostics refresh scan completed.", {
            type: "google-shopping.diagnostics",
            processed,
            mode: input.googleMerchant.dryRun ? "dry-run" : "live",
          });
          return processed;
        },
      ),
    );
  }

  if (discovery?.searchEmbeddings) {
    runners.push(
      createScheduledJobRunner(
        "discovery.search-embedding-enrichment",
        input.discoverySearchEmbeddings.intervalMs,
        controlPlane,
        async () => {
          const result = await discovery.searchEmbeddings!.processNextBatch({
            limit: input.discoverySearchEmbeddings.batchSize,
          });
          if (result.processed > 0) {
            logger.info("Discovery search embedding enrichment batch completed.", {
              type: "discovery.search-embedding-enrichment",
              processed: result.processed,
              embedded: result.embedded,
              totalTokens: result.totalTokens,
              model: input.discoverySearchEmbeddings.model,
            });
          }
          return result.embedded;
        },
      ),
    );
  }

  if (durableJobRetention) {
    runners.push(createScheduledJobRunner("durable-jobs.retention", 60 * 60 * 1000, controlPlane, durableJobRetention));
  }

  return [
    ...runners,
    createWorkSignalCleanupRunner({ controlPlane, ...workSignalCleanup() }),
    createRetentionSweepRunner({ controlPlane, ...retentionSweep() }),
  ];
}

function createDurableJobRetentionTask(
  services: Readonly<Record<string, unknown>>,
  logger: ScheduledRunnerLogger,
): (() => Promise<number>) | null {
  const tasks: Array<() => Promise<number>> = [];
  const catalog = services.catalog as
    | {
        authoringBulkJobs?: {
          pruneRetention?: (input?: { completedBefore?: Date; limit?: number }) => Promise<number>;
        };
        sourceObservations?: {
          pruneSourceObservationJobRetention?: (input?: {
            completedBefore?: Date;
            limit?: number;
          }) => Promise<{ bulkReviewJobs: number; integrationJobs: number }>;
        };
      }
    | undefined;
  const inventory = services.inventory as
    | {
        importBatches?: {
          pruneImportBatchJobRetention?: (input?: {
            completedBefore?: Date;
            stagedInputCreatedBefore?: Date;
            limit?: number;
          }) => Promise<{ jobs: number; stagedInputs: number }>;
        };
      }
    | undefined;
  const pricing = services.pricing as
    | {
        recommendations?: {
          pruneRecommendationJobRetention?: (input?: { completedBefore?: Date; limit?: number }) => Promise<number>;
        };
      }
    | undefined;
  const settlement = services.settlement as
    | {
        payouts?: {
          prunePayoutReconciliationJobRetention?: (input?: {
            completedBefore?: Date;
            limit?: number;
          }) => Promise<number>;
        };
      }
    | undefined;
  const discovery = services.discovery as
    | {
        googleShoppingSync?: {
          pruneFullSyncJobRetention?: (input?: { completedBefore?: Date; limit?: number }) => Promise<number>;
        };
      }
    | undefined;

  const completedBefore = () => new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const stagedInputCreatedBefore = () => new Date(Date.now() - 24 * 60 * 60 * 1000);

  if (catalog?.authoringBulkJobs?.pruneRetention) {
    tasks.push(() => catalog.authoringBulkJobs!.pruneRetention!({ completedBefore: completedBefore(), limit: 500 }));
  }
  if (catalog?.sourceObservations?.pruneSourceObservationJobRetention) {
    tasks.push(async () => {
      const result = await catalog.sourceObservations!.pruneSourceObservationJobRetention!({
        completedBefore: completedBefore(),
        limit: 500,
      });
      return result.bulkReviewJobs + result.integrationJobs;
    });
  }
  if (inventory?.importBatches?.pruneImportBatchJobRetention) {
    tasks.push(async () => {
      const result = await inventory.importBatches!.pruneImportBatchJobRetention!({
        completedBefore: completedBefore(),
        stagedInputCreatedBefore: stagedInputCreatedBefore(),
        limit: 500,
      });
      return result.jobs + result.stagedInputs;
    });
  }
  if (pricing?.recommendations?.pruneRecommendationJobRetention) {
    tasks.push(() =>
      pricing.recommendations!.pruneRecommendationJobRetention!({ completedBefore: completedBefore(), limit: 500 }),
    );
  }
  if (settlement?.payouts?.prunePayoutReconciliationJobRetention) {
    tasks.push(() =>
      settlement.payouts!.prunePayoutReconciliationJobRetention!({
        completedBefore: completedBefore(),
        limit: 500,
      }),
    );
  }
  if (discovery?.googleShoppingSync?.pruneFullSyncJobRetention) {
    tasks.push(() =>
      discovery.googleShoppingSync!.pruneFullSyncJobRetention!({ completedBefore: completedBefore(), limit: 500 }),
    );
  }

  if (tasks.length === 0) {
    return null;
  }

  return async () => {
    const counts = await Promise.all(tasks.map((task) => task()));
    const deleted = counts.reduce((sum, count) => sum + count, 0);
    logger.info("Durable job retention completed.", {
      type: "durable-jobs.retention",
      deleted,
    });
    return deleted;
  };
}
function createScheduledJobRunner(
  name: string,
  intervalMs: number,
  controlPlane: PlatformControlPlane,
  job: () => Promise<number>,
): WorkerRunner {
  return {
    name,
    kind: "job",
    runOnce: async () => {
      const claimed = await controlPlane.claimScheduledRunner({ runnerName: name, intervalMs });
      if (!claimed) {
        return { processed: 0, lastGlobalPosition: "0" as never };
      }

      const processed = await job();
      await controlPlane.recordScheduledRunnerCompleted({ runnerName: name });
      return { processed, lastGlobalPosition: "0" as never };
    },
  };
}

const SYSTEM_CONTEXT = {
  tenantId: "tnt_identity" as never,
  audit: {
    performedByUserId: "usr_identity_system" as never,
    forAccountId: "acc_identity_system" as never,
  },
};
