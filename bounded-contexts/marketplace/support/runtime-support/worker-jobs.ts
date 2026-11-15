import type { WorkerRunner } from "@chase-sets/bounded-context-module";

import { createScheduledJobRunner, type WorkerJobInput } from "@chase-sets/platform-runtime/worker-jobs";
import type { MarketplaceServices } from "./services";

const SYSTEM_CONTEXT = {
  tenantId: "tnt_identity" as never,
  audit: {
    performedByUserId: "usr_identity_system" as never,
    forAccountId: "acc_identity_system" as never,
  },
};

type CreateMarketplaceReviewOpportunityPublicationRunnersConfig = Readonly<{}>;
export function createMarketplaceReviewOpportunityPublicationRunners({
  services,
  controlPlane,
}: Pick<
  WorkerJobInput<CreateMarketplaceReviewOpportunityPublicationRunnersConfig>,
  "services" | "controlPlane"
>): readonly WorkerRunner[] {
  const reviewOpportunityPublication = (services.marketplace as MarketplaceServices | undefined)
    ?.reviewOpportunityPublication;
  const runners: WorkerRunner[] = [];
  if (reviewOpportunityPublication) {
    runners.push(
      createScheduledJobRunner("marketplace.review-opportunity-publication", 1_000, controlPlane, () =>
        reviewOpportunityPublication.run(SYSTEM_CONTEXT),
      ),
    );
    runners.push(
      createScheduledJobRunner("marketplace.review-opportunity-backfill", 60_000, controlPlane, () =>
        reviewOpportunityPublication.backfill(),
      ),
    );
  }
  return runners;
}

type CreateMarketplaceManagedOfferWorkRunnersConfig = Readonly<{}>;
export function createMarketplaceManagedOfferWorkRunners({
  services,
  controlPlane,
}: Pick<
  WorkerJobInput<CreateMarketplaceManagedOfferWorkRunnersConfig>,
  "services" | "controlPlane"
>): readonly WorkerRunner[] {
  const managedOfferWork = (services.marketplace as MarketplaceServices | undefined)?.managedOfferWork;
  const runners: WorkerRunner[] = [];
  if (managedOfferWork) {
    runners.push(
      createScheduledJobRunner("marketplace.managed-offer-work", 1_000, controlPlane, () =>
        managedOfferWork.run(SYSTEM_CONTEXT),
      ),
    );
    runners.push(
      createScheduledJobRunner("marketplace.managed-offer-recovery", 60_000, controlPlane, () =>
        managedOfferWork.recover(SYSTEM_CONTEXT),
      ),
    );
  }
  return runners;
}

type CreateMarketplaceReviewWindowSweepRunnersConfig = Readonly<{ reviewWindowSweepIntervalMs: number | null }>;
export function createMarketplaceReviewWindowSweepRunners({
  services,
  config: input,
  controlPlane,
  logger,
}: Pick<
  WorkerJobInput<CreateMarketplaceReviewWindowSweepRunnersConfig>,
  "services" | "config" | "controlPlane" | "logger"
>): readonly WorkerRunner[] {
  const marketplaceReviews = (services.marketplace as MarketplaceServices | undefined)?.reviews;
  const sweepReviewWindowExpirations = marketplaceReviews?.sweepReviewWindowExpirations;
  const runners: WorkerRunner[] = [];
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
  return runners;
}

type CreateMarketplaceReviewOpportunityReminderSweepRunnersConfig = Readonly<{
  reviewOpportunityReminderSweepIntervalMs: number | null;
}>;
export function createMarketplaceReviewOpportunityReminderSweepRunners({
  services,
  config: input,
  controlPlane,
  logger,
}: Pick<
  WorkerJobInput<CreateMarketplaceReviewOpportunityReminderSweepRunnersConfig>,
  "services" | "config" | "controlPlane" | "logger"
>): readonly WorkerRunner[] {
  const marketplaceReviews = (services.marketplace as MarketplaceServices | undefined)?.reviews;
  const sweepReviewOpportunityReminders = marketplaceReviews?.sweepReviewOpportunityReminders;
  const runners: WorkerRunner[] = [];
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
  return runners;
}

type CreateMarketplaceSellerAvailabilityRestoreSweepRunnersConfig = Readonly<{
  sellerAvailabilityRestoreSweepIntervalMs: number | null;
}>;
export function createMarketplaceSellerAvailabilityRestoreSweepRunners({
  services,
  config: input,
  controlPlane,
  logger,
}: Pick<
  WorkerJobInput<CreateMarketplaceSellerAvailabilityRestoreSweepRunnersConfig>,
  "services" | "config" | "controlPlane" | "logger"
>): readonly WorkerRunner[] {
  const marketplaceListings = (services.marketplace as MarketplaceServices | undefined)?.listings;
  const sweepDueSellerAvailabilityRestores = marketplaceListings?.sweepDueSellerAvailabilityRestores;
  const runners: WorkerRunner[] = [];
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
  return runners;
}

type CreateMarketplaceSellerAwayWindowStartSweepRunnersConfig = Readonly<{
  sellerAwayWindowStartSweepIntervalMs: number | null;
}>;
export function createMarketplaceSellerAwayWindowStartSweepRunners({
  services,
  config: input,
  controlPlane,
  logger,
}: Pick<
  WorkerJobInput<CreateMarketplaceSellerAwayWindowStartSweepRunnersConfig>,
  "services" | "config" | "controlPlane" | "logger"
>): readonly WorkerRunner[] {
  const marketplaceListings = (services.marketplace as MarketplaceServices | undefined)?.listings;
  const sweepDueSellerAwayWindowStarts = marketplaceListings?.sweepDueSellerAwayWindowStarts;
  const runners: WorkerRunner[] = [];
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
  return runners;
}
