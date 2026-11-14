import { describe, expect, it } from "vitest";
import { createCheckoutSellListRuntime } from "../api/runtime";
import {
  checkoutOwnerRuntimeFixture,
  choices,
  fixtureLine,
  origin,
  ownedAbsentRisk,
  stamp,
} from "../api/owner-read.fixture";
import matrix from "./authority-matrix.fixture.json";
import { createSellListReadinessSnapshot } from "../domain/readiness";
import { loadCheckoutSellListCompositeReview } from "./queries";
import {
  parseSellerCheckoutChoices,
  readSellerCheckoutOwners,
  sellerCheckoutEstimate,
  sellerCheckoutEvidence,
  sellerCheckoutOwner,
} from "./seller-checkout-owner-reads";

describe("Smart Match per-listing evidence authority", () => {
  it.each(["missing", "incomplete", "invalid-timestamp", "complete"])(
    "%s evidence uses real composite coverage with all other dimensions ready",
    async (state) => {
      const f = checkoutOwnerRuntimeFixture();
      f.setLines([{ ...fixtureLine, line_type: "product", offer_id: null, listing_id: null }]);
      const evidence = f.getListingEvidence()!;
      if (state === "missing") f.setListingEvidence(null);
      if (state === "incomplete") evidence.evidence_requirements.requirements.minimumPhotoCount = 1;
      if (state === "invalid-timestamp") evidence.updated_at = "2026-02-30T01:02:03.000Z";
      const snapshot = await f.services.createReadinessSnapshot({
        sellerAccountId: "acc_seller",
        ...choices,
        decisions: { lineActions: [{ lineId: fixtureLine.line_id, action: "smart-match" }] },
      });
      const ready = state === "complete" ? "ready" : "blocked";
      expect(snapshot.sellerReadiness).toMatchObject({
        status: ready,
        freshness: ready,
        shipFrom: "ready",
        payout: "ready",
        label: "ready",
        risk: "ready",
        provider: "ready",
      });
      expect(snapshot.ownerReads?.estimate).toMatchObject({ status: "complete", amount: "10.00" });
      expect(snapshot.sellerReadiness.outcomes.find((row) => row.dimension === "freshness")?.reason).toBe(
        state === "complete" ? "ready" : "seller-evidence-stale",
      );
    },
  );

  it("binds a sorted set of exact matched offer/listing keys and ignores excluded reviews", async () => {
    const f = checkoutOwnerRuntimeFixture();
    const lines = [{ ...fixtureLine, line_type: "product" as const, quantity: 2, offer_id: null, listing_id: null }];
    const lineSnapshot = createSellListReadinessSnapshot(lines, {
      lineActions: [{ lineId: fixtureLine.line_id, action: "smart-match" }],
    });
    const review = await loadCheckoutSellListCompositeReview(f.deps.db, f.deps.commercialTermsResolver, {
      sellerAccountId: "acc_seller",
      lines,
    });
    const first = review.productOfferReviews[0]!.offers[0]!;
    const second = {
      ...first,
      offer: { ...first.offer, offer_id: "off_second", listing_id: "lst_second" },
      evidence: { ...first.evidence!, listingId: "lst_second" },
    };
    const reads = await readSellerCheckoutOwners({
      ownerId: "acc_seller",
      choices,
      ports: f.ports,
      addresses: async () => [],
    });
    const assess = (offers: (typeof first)[]) => {
      const value = { ...review, productOfferReviews: [{ ...review.productOfferReviews[0]!, offers }] };
      return sellerCheckoutEvidence({
        reads,
        payout: { account_id: "acc_seller", status: "ready", missing_requirements: [], updated_at: stamp },
        estimate: sellerCheckoutEstimate(lines, value, lineSnapshot),
        lines,
        review: value,
        lineSnapshot,
      });
    };
    expect(assess([first, second]).authorityRevision).toBe(assess([second, first]).authorityRevision);
    expect(assess([first, second]).authorityRevision).not.toBe(
      assess([
        first,
        {
          ...second,
          offer: { ...second.offer, offer_id: "off_replacement" },
        },
      ]).authorityRevision,
    );
    const baseline = assess([first, second]);
    const value = {
      ...review,
      productOfferReviews: [
        { ...review.productOfferReviews[0]!, offers: [first, second] },
        { lineId: "sll_excluded", status: "ready" as const, offers: [{ ...first, evidence: null }], message: null },
      ],
    };
    const excluded = sellerCheckoutEvidence({
      reads,
      payout: { account_id: "acc_seller", status: "ready", missing_requirements: [], updated_at: stamp },
      estimate: sellerCheckoutEstimate(lines, value, lineSnapshot),
      lines,
      review: value,
      lineSnapshot,
    });
    expect(excluded.authorityRevision).toBe(baseline.authorityRevision);
    expect(excluded.freshness.status).toBe("current");
  });
});

describe("AC1 complete owner authority matrix", () => {
  it("covers each dimension at both composed moments without a browser authority cell", async () => {
    expect(Object.keys(matrix)).toEqual(["risk", "label", "provider", "payoutEstimate", "freshness"]);
    for (const dimension of Object.values(matrix)) {
      expect(dimension.moments).toEqual(["readiness", "pre-confirm"]);
      for (const cell of Object.values(dimension)) expect(cell).not.toBe("");
    }
    const f = checkoutOwnerRuntimeFixture();
    const snapshot = await f.services.createReadinessSnapshot({ sellerAccountId: "acc_seller", ...choices });
    expect(snapshot.sellerReadiness.status).toBe("ready");
    expect(snapshot.ownerReads).toMatchObject({
      owner: { kind: "account", accountId: "acc_seller" },
      risk: ownedAbsentRisk,
      fulfillment: { sourceRevision: 2, sourceTimestamp: stamp },
      estimate: { status: "complete", amount: "10.00", currencyCode: "USD" },
      lineTimestamps: [stamp],
    });
  });
});

describe("AC2 typed reads and full origin choices", () => {
  it.each(["acc_seller", "anon_sell_fixture"])("uses the full manual address and trusted %s key", async (ownerId) => {
    const f = checkoutOwnerRuntimeFixture(ownerId);
    const snapshot = await f.services.createReadinessSnapshot({ sellerAccountId: ownerId, ...choices });
    expect(snapshot.sellerReadiness.shipFrom).toBe("ready");
    expect(snapshot.ownerReads?.fulfillment?.sourceRevision).toBe(2);
    expect(f.ports.resolveOrigin).toHaveBeenCalledWith(sellerCheckoutOwner(ownerId), {
      origin,
      labelPreference: "prepaid-label",
    });
    expect(f.ports.readFulfillment).toHaveBeenCalledWith({
      owner: sellerCheckoutOwner(ownerId),
      shipFromLocationId: "sfl_fixture",
      labelPreference: "prepaid-label",
    });
  });
  it("resolves only an account-owned saved address to its full origin", async () => {
    const f = checkoutOwnerRuntimeFixture();
    const request = { sellerAccountId: "acc_seller", shipFrom: { addressId: "adr_fixture" }, label: choices.label };
    expect((await f.services.createReadinessSnapshot(request)).sellerReadiness.shipFrom).toBe("ready");
    f.address.account_id = "acc_foreign";
    expect((await f.services.createReadinessSnapshot(request)).sellerReadiness.shipFrom).toBe("blocked");
    expect(
      (
        await checkoutOwnerRuntimeFixture("anon_list").services.createReadinessSnapshot({
          ...request,
          sellerAccountId: "anon_list",
        })
      ).sellerReadiness.shipFrom,
    ).toBe("blocked");
  });
  it.each([
    {},
    { shipFrom: { country: "US", state: "KS", postalCode: "67202" }, label: choices.label },
    { ...choices, shipFrom: { ...origin, line1: "2 Main St" } },
    { ...choices, shipFrom: { ...origin, shipFromLocationId: "sfl_fixture" } },
    { ...choices, label: { preference: "seller-label-later" } },
    { ...choices, shipFrom: { ...origin, addressId: "adr_fixture" } },
  ])("blocks partial, conflicting or omitted choices %j", async (request) => {
    const f = checkoutOwnerRuntimeFixture();
    expect(
      (
        await f.services.createReadinessSnapshot({
          sellerAccountId: "acc_seller",
          ...parseSellerCheckoutChoices(request),
        })
      ).sellerReadiness.shipFrom,
    ).toBe("blocked");
  });
});

describe("AC3 missing authority is explicit", () => {
  it("does not use seed/no-op commercial terms as payout estimate authority", async () => {
    const f = checkoutOwnerRuntimeFixture();
    const snapshot = await createCheckoutSellListRuntime({
      ...f.deps,
      commercialTermsResolver: undefined,
    }).createReadinessSnapshot({ sellerAccountId: "acc_seller", ...choices });
    expect(snapshot.sellerReadiness).toMatchObject({
      risk: "ready",
      label: "ready",
      provider: "ready",
      payout: "blocked",
    });
    expect(snapshot.ownerReads?.estimate.status).toBe("unavailable");
  });
  it("does not authorize from posted ready statuses when the owner port is omitted", async () => {
    const f = checkoutOwnerRuntimeFixture();
    const snapshot = await createCheckoutSellListRuntime({
      ...f.deps,
      sellerCheckoutOwners: undefined,
    }).createReadinessSnapshot({
      sellerAccountId: "acc_seller",
      ...choices,
      sellerEvidence: {
        shipFrom: { status: "ready", addressId: null, country: "US", region: "KS", postalCode: "67202" },
        payout: { status: "ready", method: "saved-payout", readinessStatus: "ready", lastCheckedAt: stamp },
        label: { status: "ready", preference: "prepaid-label" },
        risk: { status: "clear" },
        provider: { status: "ready" },
        freshness: { status: "current" },
      },
    });
    expect(snapshot.sellerReadiness).toMatchObject({
      risk: "blocked",
      label: "blocked",
      provider: "blocked",
      freshness: "blocked",
    });
  });
  it.each([
    null,
    {},
    { ...ownedAbsentRisk, extra: true },
    { ...ownedAbsentRisk, rowState: "unavailable" },
    { ...ownedAbsentRisk, sourceRevision: Number.MAX_SAFE_INTEGER + 1 },
    { ...ownedAbsentRisk, sourceTimestamp: stamp },
  ])("blocks malformed risk %j with every other dimension valid", async (result) => {
    const f = checkoutOwnerRuntimeFixture();
    f.ports.readRisk.mockResolvedValue(result as never);
    const snapshot = await f.services.createReadinessSnapshot({ sellerAccountId: "acc_seller", ...choices });
    expect(snapshot.sellerReadiness).toMatchObject({
      risk: "blocked",
      shipFrom: "ready",
      label: "ready",
      provider: "ready",
      payout: "ready",
      freshness: "ready",
    });
    expect(snapshot.sellerReadiness.outcomes.find((row) => row.dimension === "risk")?.reason).toBe("risk-not-clear");
  });
  it.each(["missing", "unavailable", "stale", "conflicting"] as const)(
    "blocks %s Fulfillment while risk and payout stay valid",
    async (fact) => {
      const f = checkoutOwnerRuntimeFixture();
      f.ports.readFulfillment.mockResolvedValue({
        schemaVersion: "fulfillment.seller-checkout-readiness.v1",
        label: { status: "blocked", reason: "label-not-ready", fact },
        provider: { status: "blocked", reason: "provider-not-ready", fact },
        sourceRevision: null,
        sourceTimestamp: null,
      });
      const snapshot = await f.services.createReadinessSnapshot({ sellerAccountId: "acc_seller", ...choices });
      expect(snapshot.sellerReadiness).toMatchObject({
        risk: "ready",
        payout: "ready",
        label: "blocked",
        provider: "blocked",
        freshness: "blocked",
      });
    },
  );
  it.each([
    { label: { status: "ready", reason: "label-not-ready" } },
    { provider: { status: "unknown", reason: "ready" } },
    { sourceRevision: Number.MAX_SAFE_INTEGER + 1 },
    { sourceTimestamp: "not-a-time" },
    { extra: true },
  ])("closes nested Fulfillment results and stamps %j", async (delta) => {
    const f = checkoutOwnerRuntimeFixture();
    const ready = await f.ports.readFulfillment({
      owner: { kind: "account", accountId: "acc_seller" as never },
      shipFromLocationId: "sfl_fixture",
      labelPreference: "prepaid-label",
    });
    f.ports.readFulfillment.mockResolvedValue({ ...ready, ...delta } as never);
    expect(
      (await f.services.createReadinessSnapshot({ sellerAccountId: "acc_seller", ...choices })).sellerReadiness.label,
    ).toBe("blocked");
  });
  it("rejects foreign/unknown resolved keys, unavailable estimate, payout and real timestamps", async () => {
    const f = checkoutOwnerRuntimeFixture();
    const accepted = await f.ports.resolveOrigin(
      { kind: "account", accountId: "acc_foreign" as never },
      { origin, labelPreference: "prepaid-label" },
    );
    f.ports.resolveOrigin.mockResolvedValue(accepted);
    expect(
      (await f.services.createReadinessSnapshot({ sellerAccountId: "acc_seller", ...choices })).sellerReadiness
        .shipFrom,
    ).toBe("blocked");
    const g = checkoutOwnerRuntimeFixture();
    g.setOfferAvailable(false);
    expect(
      (await g.services.createReadinessSnapshot({ sellerAccountId: "acc_seller", ...choices })).sellerReadiness.payout,
    ).toBe("blocked");
    const h = checkoutOwnerRuntimeFixture();
    h.setPayout("ready", null);
    expect(
      (await h.services.createReadinessSnapshot({ sellerAccountId: "acc_seller", ...choices })).sellerReadiness.payout,
    ).toBe("blocked");
    h.setPayout("ready", new Date(stamp));
    expect(
      (await h.services.createReadinessSnapshot({ sellerAccountId: "acc_seller", ...choices })).sellerReadiness.payout,
    ).toBe("ready");
    h.setLines([{ ...fixtureLine, updated_at: "" }]);
    expect(
      (await h.services.createReadinessSnapshot({ sellerAccountId: "acc_seller", ...choices })).sellerReadiness
        .freshness,
    ).toBe("blocked");
    for (const owner of ["acc_anonymous_sell_list", "", "acc_", "other_x", "anon_ "])
      expect(sellerCheckoutOwner(owner)).toBeNull();
  });
});

describe("AC4 exact timing and canonical drift", () => {
  it("normalizes actual driver Dates, rejects invalid instants and hashes changed real line stamps", async () => {
    const f = checkoutOwnerRuntimeFixture();
    const first = await f.services.createReadinessSnapshot({ sellerAccountId: "acc_seller", ...choices });
    f.setLines([{ ...fixtureLine, updated_at: new Date(stamp) as never }]);
    const driver = await f.services.createReadinessSnapshot({ sellerAccountId: "acc_seller", ...choices });
    expect(driver.snapshotId).toBe(first.snapshotId);
    expect(driver.ownerReads?.lineTimestamps).toEqual([stamp]);
    f.setLines([{ ...fixtureLine, updated_at: "2026-11-06T01:02:04.000Z" }]);
    expect(
      (await f.services.createReadinessSnapshot({ sellerAccountId: "acc_seller", ...choices })).sourceRevision,
    ).not.toBe(first.sourceRevision);
    f.setLines([{ ...fixtureLine, updated_at: "2026-02-30T01:02:03.000Z" }]);
    expect(
      (await f.services.createReadinessSnapshot({ sellerAccountId: "acc_seller", ...choices })).sellerReadiness
        .freshness,
    ).toBe("blocked");
  });
  it("records risk stamp drift without changing identity; Fulfillment revision drift changes identity", async () => {
    const f = checkoutOwnerRuntimeFixture();
    const first = await f.services.createReadinessSnapshot({ sellerAccountId: "acc_seller", ...choices });
    f.ports.readRisk.mockResolvedValue({
      ...ownedAbsentRisk,
      rowState: "present",
      sourceRevision: 4,
      sourceTimestamp: stamp as never,
    });
    const second = await f.services.createReadinessSnapshot({ sellerAccountId: "acc_seller", ...choices });
    expect(second.snapshotId).toBe(first.snapshotId);
    expect(second.ownerReads?.risk?.sourceRevision).toBe(4);
    f.ports.resolveOrigin.mockResolvedValue({
      status: "accepted",
      key: {
        owner: { kind: "account", accountId: "acc_seller" as never },
        shipFromLocationId: "sfl_fixture",
        labelPreference: "prepaid-label",
      },
      sourceRevision: 3,
      sourceTimestamp: stamp as never,
    });
    const third = await f.services.createReadinessSnapshot({ sellerAccountId: "acc_seller", ...choices });
    expect(third.snapshotId).not.toBe(first.snapshotId);
    expect(third.sellerReadiness.freshness).toBe("blocked");
  });
});

describe.each(["acc_seller", "anon_sell_fixture"])("AC3 authority state matrix for %s", (ownerId) => {
  it.each(["absent", "unavailable", "malformed", "stale", "revoked", "current"] as const)(
    "keeps all other dimensions valid for Fulfillment %s and proves the repaired source escapes",
    async (state) => {
      const f = checkoutOwnerRuntimeFixture(ownerId);
      const key = {
        owner: sellerCheckoutOwner(ownerId)!,
        shipFromLocationId: "sfl_fixture",
        labelPreference: "prepaid-label" as const,
      };
      const current = await f.ports.readFulfillment(key);
      if (state === "unavailable") f.ports.readFulfillment.mockRejectedValue(new Error("source unavailable"));
      else if (state === "malformed")
        f.ports.readFulfillment.mockResolvedValue({
          ...current,
          provider: { status: "ready", reason: "unknown" },
        } as never);
      else if (state !== "current")
        f.ports.readFulfillment.mockResolvedValue({
          ...current,
          sourceRevision: state === "absent" ? null : current.sourceRevision,
          sourceTimestamp: state === "absent" ? null : current.sourceTimestamp,
          label: { status: "blocked", reason: "label-not-ready", fact: state === "stale" ? "stale" : "missing" },
          provider: { status: "blocked", reason: "provider-not-ready", fact: state === "stale" ? "stale" : "missing" },
        });
      const request = { sellerAccountId: ownerId, ...choices };
      const snapshot = await f.services.createReadinessSnapshot(request);
      expect(snapshot.sellerReadiness).toMatchObject({
        risk: "ready",
        payout: "ready",
        label: state === "current" ? "ready" : "blocked",
        provider: state === "current" ? "ready" : "blocked",
      });
      f.ports.readFulfillment.mockResolvedValue(current);
      expect((await f.services.createReadinessSnapshot(request)).sellerReadiness.status).toBe("ready");
    },
  );

  it.each(["absent", "unavailable", "malformed", "current"] as const)(
    "keeps shipping valid for risk %s and proves the repaired source escapes",
    async (state) => {
      const f = checkoutOwnerRuntimeFixture(ownerId);
      if (state === "unavailable") f.ports.readRisk.mockRejectedValue(new Error("source unavailable"));
      if (state === "malformed")
        f.ports.readRisk.mockResolvedValue({ ...ownedAbsentRisk, rowState: "unknown" } as never);
      if (state === "current")
        f.ports.readRisk.mockResolvedValue({
          ...ownedAbsentRisk,
          rowState: "present",
          sourceRevision: 7,
          sourceTimestamp: stamp as never,
        });
      const request = { sellerAccountId: ownerId, ...choices };
      const snapshot = await f.services.createReadinessSnapshot(request);
      expect(snapshot.sellerReadiness).toMatchObject({
        shipFrom: "ready",
        label: "ready",
        provider: "ready",
        payout: "ready",
        freshness: "ready",
        risk: state === "absent" || state === "current" ? "ready" : "blocked",
      });
      f.ports.readRisk.mockResolvedValue(ownedAbsentRisk);
      expect((await f.services.createReadinessSnapshot(request)).sellerReadiness.status).toBe("ready");
    },
  );
});

describe("AC5 existing risk reason mapping, no policy or copy changes", () => {
  it.each(["hold", "block"] as const)("maps typed %s to risk-not-clear", async (status) => {
    const f = checkoutOwnerRuntimeFixture();
    f.ports.readRisk.mockResolvedValue({
      ...ownedAbsentRisk,
      rowState: "present",
      ...(status === "hold"
        ? ({ status: "hold", reasonCode: "risk-hold" } as const)
        : ({ status: "block", reasonCode: "risk-block" } as const)),
      sourceRevision: 1,
      sourceTimestamp: stamp as never,
    });
    const snapshot = await f.services.createReadinessSnapshot({ sellerAccountId: "acc_seller", ...choices });
    expect(snapshot.sellerReadiness.outcomes.find((row) => row.dimension === "risk")).toEqual({
      dimension: "risk",
      status: "blocked",
      reason: "risk-not-clear",
    });
  });
});
