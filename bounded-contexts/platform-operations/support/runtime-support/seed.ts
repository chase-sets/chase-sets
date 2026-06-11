import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { identitySeedIds } from "@chase-sets/identity/seed-support/ids";
import type { AccountId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";
import { createPlatformOperationsServices } from "./services";
import { experienceSeedIds } from "../seed-support/ids";

function isoDate(value: string) {
  return new Date(value).toISOString();
}

export async function seedPlatformFeedbackData(pool: PgTransactionalPool) {
  const services = createPlatformOperationsServices(pool);

  try {
    const existing = await services.db.query("SELECT COUNT(*) AS count FROM experience_platform_feedback_pages");
    if (Number(existing.rows[0]?.count ?? 0) > 0) {
      console.log("Platform feedback already contains data. Skipping seed.");
      return;
    }
  } catch {
    // Table may not exist yet. Proceed with seeding.
  }

  const context = {
    tenantId: "tnt_seed_demo" as TenantId,
    audit: {
      performedByUserId: identitySeedIds.demo.userId as UserId,
      forAccountId: identitySeedIds.demo.accountId as AccountId,
    },
    trace: {},
  };
  const samples = [
    {
      feedbackId: experienceSeedIds.checkout,
      userId: identitySeedIds.collector.userId,
      accountId: identitySeedIds.collector.accountId,
      rating: 5,
      topic: "checkout-payment" as const,
      comment: "Checkout totals were clear before payment.",
      followUpConsent: false,
      workflow: "checkout-payment" as const,
      sourceRoutePath: "/account/payments/pay_seed_checkout",
      relatedEntities: [{ type: "payment", id: "pay_seed_checkout" }],
      submittedAt: isoDate("2026-05-04T15:00:00.000Z"),
    },
    {
      feedbackId: experienceSeedIds.listing,
      userId: identitySeedIds.cardVault.userId,
      accountId: identitySeedIds.cardVault.accountId,
      rating: 4,
      topic: "pricing-fees" as const,
      comment: "The fee preview helped, but comparing net proceeds still takes focus.",
      followUpConsent: true,
      workflow: "listing-publish" as const,
      sourceRoutePath: "/account/listings/lst_seed_card_vault",
      relatedEntities: [{ type: "listing", id: "lst_seed_card_vault" }],
      submittedAt: isoDate("2026-05-05T16:00:00.000Z"),
    },
    {
      feedbackId: experienceSeedIds.offer,
      userId: identitySeedIds.valueTrader.userId,
      accountId: identitySeedIds.valueTrader.accountId,
      rating: 3,
      topic: "ease-of-use" as const,
      comment: "Offer tracking is useful, but the next expected step could be clearer.",
      followUpConsent: true,
      workflow: "offer-submit" as const,
      sourceRoutePath: "/account/offers/submitted/off_seed_value",
      relatedEntities: [{ type: "offer", id: "off_seed_value" }],
      submittedAt: isoDate("2026-05-06T17:00:00.000Z"),
    },
    {
      feedbackId: experienceSeedIds.inventory,
      userId: identitySeedIds.sealedStockroom.userId,
      accountId: identitySeedIds.sealedStockroom.accountId,
      rating: 4,
      topic: "selling-inventory" as const,
      comment: "Adding stock was direct. Bulk import will matter soon.",
      followUpConsent: false,
      workflow: "inventory-create" as const,
      sourceRoutePath: "/account/inventory",
      relatedEntities: [{ type: "inventory-item", id: "inv_seed_box" }],
      submittedAt: isoDate("2026-05-07T18:00:00.000Z"),
    },
  ];

  for (const sample of samples) {
    await services.platformFeedback.commandHandler({
      streamId: `experience.platform-feedback-${sample.feedbackId}`,
      command: {
        type: "SubmitPlatformFeedback",
        ...sample,
      },
      context,
    });
  }
}
