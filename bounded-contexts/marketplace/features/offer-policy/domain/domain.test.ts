import { describe, expect, it } from "vitest";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import {
  decideMarketplaceOffer,
  evolveMarketplaceOffer,
  initialMarketplaceOfferState,
  type MarketplaceOfferEvent,
} from "../../offers/domain/domain";
import { buyerOfferPolicyCodec } from "./codec";
import {
  assertBuyerOfferPolicyAdmission,
  assertBuyerOfferPolicySelection,
  decideBuyerOfferPolicy,
  evolveBuyerOfferPolicy,
  initialBuyerOfferPolicyState,
  validateBuyerOfferPolicyTerms,
  type BuyerOfferPolicyAudit,
  type BuyerOfferPolicyCommand,
  type BuyerOfferPolicyStatus,
} from "./domain";
import { activate, context, fixture, terms } from "../tests/fixtures";

const audit: BuyerOfferPolicyAudit = {
  schemaVersion: 1,
  policyId: "bop_one",
  buyerAccountId: "acc_buyer",
  actorUserId: "usr_buyer",
  operationId: "operation",
  requestHash: "a".repeat(64),
  recordedAt: "2026-09-27T16:00:00.000Z",
};
const pending = { previewId: "b".repeat(64), policyVersion: 3, terms };
const commands: Record<string, BuyerOfferPolicyCommand> = {
  create: { type: "CreateBuyerOfferPolicy", audit },
  preview: { type: "PreviewBuyerOfferPolicy", audit, preview: pending },
  authorize: {
    type: "AuthorizeBuyerOfferPolicy",
    audit,
    previewId: pending.previewId,
    policyVersion: 3,
    consent: true,
  },
  pause: { type: "PauseBuyerOfferPolicy", audit },
  stop: { type: "StopBuyerOfferPolicy", audit },
};
describe("Buyer Offer Policy lifecycle", () => {
  it("compares option tuples independent of persisted object key order without relaxing selection", async () => {
    const { store } = await fixture();
    const state = (await store.readStream({ streamId: "marketplace.offer-off_one" }))
      .map(createPassthroughDomainEventCodec<MarketplaceOfferEvent>().decode)
      .reduce(evolveMarketplaceOffer, initialMarketplaceOfferState);
    const selectedOptions = [
      { dimensionId: "dim_condition", optionId: "opt_excellent" },
      { dimensionId: "dim_form", optionId: "opt_regular" },
    ];
    const storedOptions = selectedOptions.map(({ dimensionId, optionId }) => ({ optionId, dimensionId }));
    const selection = { ...terms, offers: [{ ...terms.offers[0]!, selectedOptions }] };
    const offers = [{ state: { ...state, selectedOptions: storedOptions }, version: 1 }];
    const check = (options: typeof selectedOptions) =>
      assertBuyerOfferPolicySelection(
        "bop_one",
        "acc_buyer",
        {
          ...selection,
          offers: [{ ...selection.offers[0]!, selectedOptions: options }],
        },
        offers,
      );

    expect(() => check(selectedOptions)).not.toThrow();
    for (const options of [
      [{ ...selectedOptions[0]!, optionId: "opt_other" }, selectedOptions[1]!],
      [{ ...selectedOptions[0]!, dimensionId: "dim_other" }, selectedOptions[1]!],
      [selectedOptions[0]!],
      [...selectedOptions, { dimensionId: "dim_extra", optionId: "opt_extra" }],
    ]) {
      expect(() => check(options)).toThrow("Offer options must match exactly.");
      expect(() => check(options)).toThrow(expect.objectContaining({ code: "invalid_authority" }));
    }
  });
  const transitions = {
    draft: { create: "reject", preview: "draft", authorize: "active", pause: "reject", stop: "stopped" },
    active: { create: "reject", preview: "active", authorize: "active", pause: "paused", stop: "stopped" },
    paused: { create: "reject", preview: "paused", authorize: "active", pause: "paused", stop: "stopped" },
    stopped: { create: "reject", preview: "reject", authorize: "reject", pause: "reject", stop: "stopped" },
  } as const;
  for (const [status, row] of Object.entries(transitions)) {
    for (const [command, outcome] of Object.entries(row)) {
      it(`${status} + ${command} -> ${outcome}; consumption never resets`, () => {
        const state = {
          ...initialBuyerOfferPolicyState,
          policyId: "bop_one",
          buyerAccountId: "acc_buyer",
          status: status as BuyerOfferPolicyStatus,
          currency: status === "draft" ? null : "USD",
          revision: 1,
          consumedItemAmount: "25.00",
          authority: terms,
          preview: pending,
        };
        const run = () => decideBuyerOfferPolicy(state, commands[command]!);
        if (outcome === "reject") expect(run).toThrow();
        else {
          const events = run();
          const next = events.reduce(evolveBuyerOfferPolicy, state);
          expect(next.status).toBe(outcome);
          expect(next.consumedItemAmount).toBe("25.00");
          if ((command === "stop" && status === "stopped") || (command === "pause" && status === "paused"))
            expect(events).toEqual([]);
        }
      });
    }
  }
  it("requires fresh consent for every revision and preserves immutable currency and consumption", () => {
    const state = {
      ...initialBuyerOfferPolicyState,
      policyId: "bop_one",
      buyerAccountId: "acc_buyer",
      currency: "USD",
      consumedItemAmount: "25.00",
    };
    expect(() => validateBuyerOfferPolicyTerms(state, { ...terms, itemCommitmentAllowance: "24.99" })).toThrow(
      "below consumed",
    );
    expect(() => validateBuyerOfferPolicyTerms(state, { ...terms, currency: "EUR" })).toThrow("currency");
    expect(() => decideBuyerOfferPolicy(state, commands.authorize!)).toThrow("fresh");
  });
  it("replays codec events exactly and rejects unknown versions and authority fields", async () => {
    const { runtime, store } = await fixture();
    const result = await activate(runtime);
    const events = await store.readStream({ streamId: "marketplace.offer-policy-bop_one" });
    const decoded = events.map(buyerOfferPolicyCodec.decode);
    const state = decoded.reduce(evolveBuyerOfferPolicy, initialBuyerOfferPolicyState);
    expect(state.authority).toEqual(result.authority);
    expect(state.revision).toBe(1);
    expect(state.consumedItemAmount).toBe("0.00");
    for (const event of decoded)
      expect(buyerOfferPolicyCodec.decode(buyerOfferPolicyCodec.encode(event))).toEqual(event);
    expect(() =>
      buyerOfferPolicyCodec.decode({ eventType: decoded[0]!.type, payload: { ...audit, schemaVersion: 2 } }),
    ).toThrow();
    expect(() =>
      buyerOfferPolicyCodec.decode({ eventType: decoded[0]!.type, payload: { ...audit, consumedItemAmount: "0.00" } }),
    ).toThrow();
  });
  it("permanent membership blocks manual edits and fixed acceptance; only active exact scope admits automation", async () => {
    const { runtime, store } = await fixture();
    await activate(runtime);
    const offer = (await store.readStream({ streamId: "marketplace.offer-off_one" }))
      .map(createPassthroughDomainEventCodec<MarketplaceOfferEvent>().decode)
      .reduce(evolveMarketplaceOffer, initialMarketplaceOfferState);
    const policy = (await store.readStream({ streamId: "marketplace.offer-policy-bop_one" }))
      .map(buyerOfferPolicyCodec.decode)
      .reduce(evolveBuyerOfferPolicy, initialBuyerOfferPolicyState);
    expect(() => assertBuyerOfferPolicyAdmission(policy, offer)).not.toThrow();
    for (const status of ["draft", "paused", "stopped"] as const)
      expect(() => assertBuyerOfferPolicyAdmission({ ...policy, status }, offer)).toThrow("Only active");
    for (const change of [
      { quantityRequested: 3 },
      { priceAmount: "20.01" },
      { priceCurrencyCode: "EUR" },
      { productId: "other" as never },
      { buyerOfferPolicyId: null },
    ]) {
      expect(() => assertBuyerOfferPolicyAdmission(policy, { ...offer, ...change })).toThrow();
    }
    expect(() =>
      decideMarketplaceOffer(offer, {
        type: "UpdateOfferPrice",
        buyerAccountId: context.audit.forAccountId,
        priceAmount: "1.00",
        priceCurrencyCode: "USD",
      }),
    ).toThrow("fresh policy");
    expect(() => decideMarketplaceOffer(offer, { type: "AcceptOffer" } as never)).toThrow("enforcement");
    expect(() =>
      decideMarketplaceOffer(offer, {
        type: "BindOfferToBuyerPolicy",
        buyerAccountId: context.audit.forAccountId,
        policyId: "bop_other",
      }),
    ).toThrow("permanent");
  });
});
