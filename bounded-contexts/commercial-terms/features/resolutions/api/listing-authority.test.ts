import { withSyntheticListingPrincipal } from "@chase-sets/event-core/test-support";
import { describe, expect, it } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  createListingAuthorityFence,
  type ListingAuthorityOperationInput,
} from "@chase-sets/platform-runtime/listing-authority-fence";
import { createListingAuthorityParticipant } from "@chase-sets/platform-runtime/listing-authority-participant";
import { createCommercialTermsListingAuthority } from "./listing-authority";
import { createCommercialTermsPolicyRuntime } from "../../../support/runtime-support/policy-runtime";
import {
  marketplaceSalesFeeSchedulePolicy,
  MARKETPLACE_SALES_FEE_SCHEDULE_LAUNCH_POLICY_VALUE,
} from "../../marketplace-sales-fee/domain/policy";
import { commercialTermsAgreementPolicy } from "../../../support/runtime-support/terms-policy";
import type { CommercialTermsAccountFacts } from "../read-model/resolve";

async function fixture() {
  const memory = createInMemoryEventStore();
  const { eventStore: consumerStore } = createInMemoryEventStore();
  const { eventStore: identityStore } = createInMemoryEventStore();
  const context = withSyntheticListingPrincipal({
    tenantId: "tnt_synthetic",
    audit: { forAccountId: "acc_synthetic", performedByUserId: "usr_synthetic" },
  });
  const now = new Date();
  const before = new Date(now.getTime() - 60_000).toISOString();
  const future = new Date(now.getTime() + 30_000).toISOString();
  const account: CommercialTermsAccountFacts = {
    account_id: "acc_synthetic",
    account_type: "personal",
    status: "active",
    founders_window_started_at: null,
    founders_window_ends_at: null,
  };
  const identity = createListingAuthorityParticipant({
    eventStore: identityStore,
    participant: { owner: "identity", purpose: "manage-listing" },
    consumer: () => fence.forParticipant("identity"),
    resources: () => ["synthetic-account"],
    validate: async (operation) => ({
      value: { account },
      sourceRevisions: [{ resourceId: "synthetic-account", revision: "1" }],
      validBefore: operation.prepareBefore,
    }),
  });
  const db: PgQueryable = {
    async query<Row>(sql: string, params?: readonly unknown[]) {
      if (!sql.includes("WITH identities")) return { rows: [] as Row[] };
      const keys = params![0] as string[];
      const at = params![2] as string;
      const rows = [...memory.streams]
        .filter(([, events]) => keys.includes(String(events[0]?.payload.policyKey)))
        .filter(([, events]) => {
          const value = events.at(-1)!.payload;
          return value.status === "active" && (!value.effectiveUntil || String(value.effectiveUntil) > at);
        })
        .map(([stream_id]) => ({ stream_id }));
      return { rows: rows as Row[] };
    },
  };
  const restart = () =>
    createCommercialTermsListingAuthority(
      { eventStore: memory.eventStore, db, now: () => now },
      {
        consumer: () => fence.forParticipant("commercial-terms"),
        identity: {
          participant: identity,
          accountFacts: (reservation) => reservation.value.account as unknown as CommercialTermsAccountFacts,
        },
      },
    );
  const authority = restart();
  const fence = createListingAuthorityFence({
    eventStore: consumerStore,
    owner: "marketplace",
    participants: [identity, authority.source],
  });
  const policies = createCommercialTermsPolicyRuntime({ eventStore: authority.eventStore, db });
  const created = await policies.createPolicyDocument(
    marketplaceSalesFeeSchedulePolicy,
    {
      value: MARKETPLACE_SALES_FEE_SCHEDULE_LAUNCH_POLICY_VALUE,
      status: "active",
      effectiveFrom: before,
      effectiveUntil: null,
      actorUserId: context.audit.performedByUserId,
    },
    context,
  );
  const input: ListingAuthorityOperationInput = {
    tenantId: context.tenantId,
    accountId: context.audit.forAccountId,
    actor: { kind: "user", userId: context.audit.performedByUserId },
    committingOwner: "marketplace",
    kind: "native-visibility",
    requestId: "synthetic-fee-request",
    command: { nativeVisibility: "enabled" },
    listingId: "lst_synthetic",
    subject: {
      inventoryItemId: "inv_synthetic",
      catalogItemId: "cat_synthetic",
      productId: "cat_synthetic::",
      selectedOptions: [],
      quantity: 1,
      pair: { amount: "100.00", currencyCode: "USD" },
      allocationRevision: null,
      commitmentSourceId: null,
    },
    target: { kind: "native-marketplace" },
    expectedListingRevision: 1,
    expectedTargetRevision: 1,
    expectedVisibilityRevision: 1,
    expectedPublicationRevision: null,
    participants: [identity.participant, authority.source.participant],
  };
  return {
    memory,
    context,
    now,
    before,
    future,
    account,
    identity,
    source: authority.source,
    restart,
    fence,
    policies,
    input,
    created,
    consumerStore,
  };
}

describe("Commercial Terms source participation", () => {
  it("compares effective windows as instants, not lexical timestamp representations", async () => {
    const f = await fixture();
    const offset = (instant: string) =>
      new Date(Date.parse(instant) + 5 * 3_600_000).toISOString().replace("Z", "+05:00");
    await f.policies.revisePolicyDocument(
      marketplaceSalesFeeSchedulePolicy,
      f.created.documentId,
      {
        value: MARKETPLACE_SALES_FEE_SCHEDULE_LAUNCH_POLICY_VALUE,
        status: "active",
        effectiveFrom: offset(f.before),
        effectiveUntil: offset(f.future),
        actorUserId: f.context.audit.performedByUserId,
      },
      f.context,
    );
    const operation = await f.fence.open(f.input, f.context);
    const grant = await f.source.prepare(operation, f.context);
    expect(grant.value.terms).toMatchObject({ marketplaceSalesFeeUnitAmount: "5.00" });
    expect(Date.parse(grant.validBefore)).toBe(Date.parse(f.future));
  });
  it("uses the existing fee formula from authoritative policy history and reserves Identity through the final operation", async () => {
    const f = await fixture();
    const operation = await f.fence.open(f.input, f.context);
    const grant = await f.source.prepare(operation, f.context);
    expect(grant.value.terms).toMatchObject({
      basisAmount: "100.00",
      marketplaceSalesFeeUnitAmount: "5.00",
      marketplaceSalesFeeCapAmount: "25.00",
    });
    const identity = await f.identity.inspect(operation);
    expect(identity?.status).toBe("reserved");
    expect(grant.value.identityReservationId).toBe(identity!.reservationId);
    await f.consumerStore.appendToStreams!([
      await f.fence.prepareCommit(operation, [grant, identity!], { enabled: true }),
    ]);
    await f.policies.revisePolicyDocument(
      marketplaceSalesFeeSchedulePolicy,
      f.created.documentId,
      {
        value: MARKETPLACE_SALES_FEE_SCHEDULE_LAUNCH_POLICY_VALUE,
        status: "inactive",
        effectiveFrom: f.before,
        effectiveUntil: null,
        actorUserId: f.context.audit.performedByUserId,
      },
      f.context,
    );
    expect((await f.fence.inspect(operation)).status).toBe("committed");
  });

  it("invalidates a grant when a previously absent agreement is created", async () => {
    const f = await fixture();
    const operation = await f.fence.open(f.input, f.context);
    await f.source.prepare(operation, f.context);
    await f.policies.createAgreementDocument(
      commercialTermsAgreementPolicy("acc_synthetic"),
      {
        documentId: "cag_synthetic",
        value: {
          label: "Synthetic agreement",
          accountId: "acc_synthetic",
          marketplaceSalesFeePercentageBps: 0,
          marketplaceSalesFeeFixedAmount: "0.00",
          shippingAllowancePercentageBps: 0,
        },
        status: "active",
        effectiveFrom: f.before,
        effectiveUntil: null,
        actorUserId: f.context.audit.performedByUserId,
      },
      { ...f.context, tenantId: "tnt_synthetic_authoring" },
    );
    expect((await f.fence.inspect(operation)).status).toBe("aborted");
    const next = await f.fence.open({ ...f.input, requestId: "synthetic-after-agreement" }, f.context);
    expect((await f.restart().source.prepare(next, f.context)).value.terms).toMatchObject({
      marketplaceSalesFeeUnitAmount: "0.00",
      agreementId: "cag_synthetic",
    });
  });

  it("bounds a grant at the next scheduled activation rather than only the selected document's end", async () => {
    const f = await fixture();
    await f.policies.revisePolicyDocument(
      marketplaceSalesFeeSchedulePolicy,
      f.created.documentId,
      {
        value: MARKETPLACE_SALES_FEE_SCHEDULE_LAUNCH_POLICY_VALUE,
        status: "active",
        effectiveFrom: f.before,
        effectiveUntil: f.future,
        actorUserId: f.context.audit.performedByUserId,
      },
      f.context,
    );
    await f.policies.createPolicyDocument(
      marketplaceSalesFeeSchedulePolicy,
      {
        value: { ...MARKETPLACE_SALES_FEE_SCHEDULE_LAUNCH_POLICY_VALUE, marketplaceSalesFeePercentageBps: 600 },
        status: "active",
        effectiveFrom: f.future,
        effectiveUntil: null,
        actorUserId: f.context.audit.performedByUserId,
      },
      f.context,
    );
    const operation = await f.fence.open(f.input, f.context);
    expect((await f.source.prepare(operation, f.context)).validBefore).toBe(f.future);
  });
});
