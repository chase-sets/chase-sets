import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";

// Bypass control for the candidate matrix: with only the safeguard stubbed
// out, every input the candidate rejects is accepted and appended. That
// proves the safeguard -- not another validation -- is what rejects them.
vi.mock("../features/reviews/domain/authored-text-safeguard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../features/reviews/domain/authored-text-safeguard")>()),
  assertSafeAuthoredText: () => undefined,
}));

const { createReviewRuntime } = await import("../features/reviews/api/runtime");
const { decideMarketplaceListing, evolveMarketplaceListing, initialMarketplaceListingState } =
  await import("../features/listings/domain/domain");

const context = {
  tenantId: "tnt_test" as never,
  audit: { performedByUserId: "usr_test" as never, forAccountId: "acc_buyer" as never },
};

const candidateRejectedText = [
  "Nice\u0000seller",
  "Great \u202Eevil",
  "ｊａｖａｓｃｒｉｐｔ：alert(1)",
  "https://spam.example/buy https://spam.example/buy",
];

function reviewRuntime() {
  const db = {
    query: vi.fn(async (sql: string) =>
      sql.includes("FROM marketplace_review_eligibility_pages") && sql.includes("author_account_id = $2")
        ? {
            rows: [
              {
                order_id: "ord_1",
                author_account_id: "acc_buyer",
                subject_account_id: "acc_seller",
                author_role: "buyer",
                eligible_at: new Date().toISOString(),
              },
            ],
          }
        : { rows: [] },
    ),
  };
  const { allEvents, eventStore } = createInMemoryEventStore();
  const runtime = createReviewRuntime({
    eventStore,
    db: db as never,
    checkpointStore: { loadCheckpoint: async () => ZERO_GLOBAL_POSITION, saveCheckpoint: async () => undefined },
  });
  return { allEvents, runtime };
}

describe("issue-5258-marketplace-ac2 safeguard bypass control", () => {
  it.each(candidateRejectedText)("appends Review Feedback and a Response the candidate rejects: %j", async (text) => {
    const { allEvents, runtime } = reviewRuntime();

    const { reviewId } = await runtime.submitReview(
      { orderId: "ord_1", authorAccountId: "acc_buyer", subjectAccountId: "acc_seller", rating: 4, feedback: text },
      context,
    );
    expect(allEvents.map((event) => event.eventType)).toEqual([
      "marketplace.review.submitted",
      "marketplace.csat-outcome-fact.v1",
    ]);

    await runtime.commandHandler({
      streamId: `marketplace.review-${reviewId}`,
      command: { type: "RevealReview", revealedAt: new Date().toISOString(), reason: "window-expired" },
      context,
    });
    await runtime.submitReviewReply({ reviewId, subjectAccountId: "acc_seller", feedback: text }, context);
    expect(allEvents.at(-1)?.eventType).toBe("marketplace.review.reply-submitted");
  });

  it.each(candidateRejectedText)("appends Listing Evidence descriptions the candidate rejects: %j", (text) => {
    const state = [
      {
        type: "marketplace.listing.created",
        data: { listingId: "lst_1", accountId: "acc_seller", status: "draft", evidence: [listingPhoto("lpho_1")] },
      },
    ].reduce(evolveMarketplaceListing as never, initialMarketplaceListingState);

    expect(
      decideMarketplaceListing(state, {
        type: "AddListingPhotos",
        photos: [{ ...listingPhoto("lpho_2"), altText: text }],
      }),
    ).toHaveLength(1);
    expect(
      decideMarketplaceListing(state, {
        type: "ClassifyListingPhoto",
        photoId: "lpho_1",
        slotId: null,
        viewKind: null,
        altText: text,
      }),
    ).toHaveLength(1);
  });
});

function listingPhoto(photoId: string) {
  const asset = {
    role: "source",
    width: 600,
    height: 840,
    density: null,
    mediaType: "image/webp",
    storageKey: `marketplace/listings/acc_seller/lst_1/${photoId}/source.webp`,
    publicUrl: "https://assets.test/source.webp",
    byteSize: 1234,
    generatedAt: "2026-05-21T00:00:00.000Z",
  } as const;
  return {
    photoId,
    originalFilename: `${photoId}.png`,
    altText: null,
    sortOrder: 0,
    uploadedAt: "2026-05-21T00:00:00.000Z",
    assetSet: { kind: "listing-photo", sourceHash: `hash_${photoId}`, source: asset, variants: [] },
  } as const;
}
