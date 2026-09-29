import { describe, expect, it } from "vitest";
import { prepareListingStandingAuthority } from "@chase-sets/platform-runtime/listing-authority-fence";
import {
  listingAuthorityOwnerConformance,
  type ListingAuthorityOwnerProofs,
} from "@chase-sets/platform-runtime/listing-authority-conformance";
import { fixture } from "../tests/listing-authority-fixture";
import { createRepricingPolicyRuntime } from "../../repricing-policies/api/runtime";
import { createPolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { repricingEnginePolicy } from "../domain/policy";
import { toTransportEvent } from "@chase-sets/event-core/transport";

const proofs: ListingAuthorityOwnerProofs["pricing"] = {
  exactEvaluatedPairTargetAndDecisionBinding: async () => {
    const f = await fixture();
    expect(f.evaluation.pair).toEqual({ amount: "12.00", currencyCode: "USD" });
    expect((await f.authority.readEvaluation(f.request, f.context.tenantId))?.decision).toEqual(f.evaluation.decision);
    let caseNumber = 0;
    for (const command of [
      { ...f.input.command, decision: { ...f.evaluation.decision, evaluationRevision: "2" } },
      {
        ...f.input.command,
        decision: { ...f.evaluation.decision, goal: { goalId: "synthetic-invented", version: "1" } },
      },
    ]) {
      const operation = await f.fence.open(
        { ...f.input, requestId: `synthetic-altered-decision-${caseNumber++}`, command },
        f.context,
      );
      await expect(f.source.prepare(operation, f.context)).rejects.toThrow();
    }
  },
  policyGoalAndStandingAuthorizationInvalidation: async () => {
    const f = await fixture();
    const operation = await f.fence.open(f.input, f.context);
    const grant = await prepareListingStandingAuthority(operation, f.context, f.authority.standingAuthority);
    const terminal = await f.fence.prepareCommit(operation, [grant], {});
    await f.invalidate();
    expect((await f.fence.inspect(operation)).status).toBe("aborted");
    await expect(f.consumerStore.appendToStreams!(terminal)).rejects.toThrow();
  },
  dryRunHasNoReservationsOrEmission: async () => {
    const f = await fixture();
    const before = structuredClone([...f.sourceMemory.streams]);
    const budgets = structuredClone([...f.budgetRows]);
    const result = await f.authority.evaluate({ ...f.request, evaluationId: "synthetic-dry-run" }, f.context, true);
    expect(result.pair).toEqual(f.evaluation.pair);
    expect([...f.sourceMemory.streams]).toEqual(before);
    expect([...f.budgetRows]).toEqual(budgets);
  },
};
describe("Actual Pricing owner proofs", () => listingAuthorityOwnerConformance(it, "pricing", proofs));

it("does not trust a post-evaluation change in input evidence", async () => {
  const f = await fixture();
  await f.setEstimate("11.00");
  const operation = await f.fence.open(f.input, f.context);
  await expect(f.source.prepare(operation, f.context)).rejects.toThrow("inputs or assignment changed");
});

it("retains closure across restart and resumes the original writer plan", async () => {
  const f = await fixture();
  const operation = await f.fence.open(f.input, f.context);
  await f.source.prepare(operation, f.context);
  f.blockInvalidation(true);
  let pending: unknown;
  try {
    await f.invalidate();
  } catch (error) {
    pending = error;
  }
  expect(pending).toHaveProperty("inputs");
  expect((await f.fence.inspect(operation)).status).toBe("pending");
  await expect(f.source.settle(operation)).rejects.toThrow();
  f.restart();
  f.blockInvalidation(false);
  await f.authority.resumePending(pending as Parameters<typeof f.authority.resumePending>[0]);
  expect((await f.fence.inspect(operation)).status).toBe("aborted");
  await f.authority.resumePending(pending as Parameters<typeof f.authority.resumePending>[0]);
  expect(
    (await f.sourceStore.readStream({ streamId: `pricing.repricing-halt-${f.context.audit.forAccountId}` })).length,
  ).toBe(1);
});

it.each([
  "new-policy",
  "revise-policy",
  "pause-policy",
  "delete-policy",
  "new-engine-policy",
  "estimate",
  "listing-input",
  "catalog-input",
] as const)("%s writer revokes the actual Pricing promise before becoming effective", async (kind) => {
  const f = await fixture();
  const operation = await f.fence.open(f.input, f.context);
  const grant = await f.source.prepare(operation, f.context);
  const terminal = await f.fence.prepareCommit(operation, [grant], { accepted: true });
  const runtime = createRepricingPolicyRuntime({ eventStore: f.authority.eventStore, db: f.db });
  const at = new Date().toISOString();
  if (kind === "new-policy")
    await runtime.commandHandler({
      streamId: runtime.streamIdForPolicy("rpp_synthetic_competitor"),
      context: f.context,
      command: {
        type: "CreateRepricingPolicy",
        policyId: "rpp_synthetic_competitor",
        accountId: f.context.audit.forAccountId,
        name: "Synthetic inserted competitor",
        scope: { kind: "listing-set", listingIds: [f.request.listingId] },
        rules: f.rules,
        maxChangesPerDay: 10,
        createdAt: at,
      },
    });
  else if (kind === "revise-policy")
    await runtime.executeOwnedRepricingPolicy({
      policyId: f.policyId,
      accountId: f.context.audit.forAccountId,
      context: f.context,
      command: {
        type: "ReviseRepricingPolicy",
        name: "Revised synthetic policy",
        scope: { kind: "all-listings" },
        rules: f.rules,
        maxChangesPerDay: 9,
        revisedAt: at,
      },
    });
  else if (kind === "pause-policy" || kind === "delete-policy")
    await runtime.executeOwnedRepricingPolicy({
      policyId: f.policyId,
      accountId: f.context.audit.forAccountId,
      context: f.context,
      command:
        kind === "pause-policy"
          ? { type: "PauseRepricingPolicy", pausedAt: at }
          : { type: "DeleteRepricingPolicy", deletedAt: at },
    });
  else if (kind === "new-engine-policy")
    await createPolicyRuntime({ eventStore: f.authority.eventStore, db: f.db }).commandHandler({
      streamId: "platform-policy.document-synthetic-engine",
      context: f.context,
      command: {
        type: "CreatePolicyDocument",
        documentId: "synthetic-engine",
        policyKey: repricingEnginePolicy.policyKey,
        contextName: "pricing",
        schemaSummary: "Synthetic engine policy",
        status: "active",
        value: { ...repricingEnginePolicy.defaultValue, hardAskOutlierPriceRatio: 11 },
        effectiveFrom: at,
        effectiveUntil: null,
        actorUserId: f.context.audit.performedByUserId,
      },
    });
  else if (kind === "estimate")
    await f.authority.eventStore.appendToStream({
      streamId: "pricing.market-price-estimate-cat_synthetic_owner::",
      expectedVersion: 1,
      context: f.context,
      events: [
        {
          eventType: "pricing.market-price.estimated",
          payload: {
            catalogItemId: f.request.catalogItemId,
            productId: f.request.productId,
            amount: "13.00",
            currencyCode: "USD",
            freshUntil: new Date(Date.now() + 3_600_000).toISOString(),
          },
        },
      ],
    });
  else {
    const listing = kind === "listing-input";
    const changed = await f.external.appendToStream({
      streamId: listing ? `marketplace.listing-${f.request.listingId}` : `catalog.item-${f.request.catalogItemId}`,
      expectedVersion: listing ? 2 : 1,
      context: f.context,
      events: [
        {
          eventType: listing ? "marketplace.listing.price-updated" : "catalog.catalog-item.category-assigned",
          payload: listing
            ? { priceAmount: "11.00", priceCurrencyCode: "USD" }
            : { categoryId: "cat_synthetic_changed" },
        },
      ],
    });
    await f.authority.observations.observe(toTransportEvent(changed[0]!));
  }
  expect((await f.fence.inspect(operation)).status).toBe("aborted");
  await expect(f.consumerStore.appendToStreams!(terminal)).rejects.toThrow();
  expect((await f.source.inspect(operation))?.status).toBe("released");
});

it("binds exactly one consumer to each target decision and does not spend another budget ticket on retry", async () => {
  const f = await fixture();
  const tickets = [...f.budgetRows];
  expect(await f.authority.evaluate(f.request, f.context)).toEqual(f.evaluation);
  expect([...f.budgetRows]).toEqual(tickets);
  const operation = await f.fence.open(f.input, f.context);
  await f.source.prepare(operation, f.context);
  const other = await f.fence.open({ ...f.input, requestId: "synthetic-double-spend" }, f.context);
  await expect(f.source.prepare(other, f.context)).rejects.toThrow("already binds another consumer");
  expect((await f.source.inspect(operation))?.status).toBe("reserved");
});

it("does not treat a worker evaluation fact as a policy writer or a new price anchor", async () => {
  const f = await fixture();
  const operation = await f.fence.open(f.input, f.context);
  await f.source.prepare(operation, f.context);
  await f.authority.eventStore.appendToStream({
    streamId: "pricing.repricing-evaluation-synthetic",
    expectedVersion: 0,
    context: f.context,
    events: [
      {
        eventType: "pricing.repricing-policy.evaluated",
        payload: { sellerAccountId: f.context.audit.forAccountId, policyId: f.policyId, synthetic: true },
      },
    ],
  });
  expect((await f.fence.inspect(operation)).status).toBe("pending");
  expect((await f.source.inspect(operation))?.status).toBe("reserved");
});
