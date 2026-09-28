import { describe, expect, it } from "vitest";
import { createInMemoryEventStore, withSyntheticListingPrincipal } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { requireListingAuthorityPrincipal } from "@chase-sets/event-core/listing-authority";
import {
  createListingAuthorityFence,
  prepareListingStandingAuthority,
  type ListingAuthorityOperationInput,
} from "./listing-authority-fence";
import { createListingAuthorityParticipant } from "./listing-authority-participant";
import { authorityContext } from "./listing-authority-state";

function fixture() {
  const context = withSyntheticListingPrincipal({
    tenantId: "tnt_synthetic",
    audit: { forAccountId: "acc_synthetic", performedByUserId: "usr_synthetic" },
  });
  const consumer = createInMemoryEventStore().eventStore;
  const store = createInMemoryEventStore().eventStore;
  const source = createListingAuthorityParticipant({
    eventStore: store,
    participant: { owner: "identity", purpose: "manage-listing" },
    consumer: () => fence.forParticipant("identity"),
    resources: () => ["synthetic-membership"],
    validate: async (operation) => ({
      value: {},
      sourceRevisions: [{ resourceId: "synthetic-membership", revision: "1" }],
      validBefore: operation.prepareBefore,
    }),
  });
  const fence = createListingAuthorityFence({ eventStore: consumer, owner: "marketplace", participants: [source] });
  const input: ListingAuthorityOperationInput = {
    tenantId: context.tenantId,
    accountId: context.audit.forAccountId,
    actor: { kind: "user", userId: context.audit.performedByUserId },
    committingOwner: "marketplace",
    kind: "accept-price",
    requestId: "synthetic-principal-probe",
    command: { amount: "12.00", currencyCode: "USD" },
    listingId: "lst_synthetic",
    subject: {
      inventoryItemId: "inv_synthetic",
      catalogItemId: "cat_synthetic",
      productId: "cat_synthetic::",
      selectedOptions: [],
      quantity: 1,
      pair: { amount: "12.00", currencyCode: "USD" },
      allocationRevision: null,
      commitmentSourceId: null,
    },
    target: { kind: "native-marketplace" },
    expectedListingRevision: 1,
    expectedTargetRevision: 1,
    expectedVisibilityRevision: null,
    expectedPublicationRevision: null,
    participants: [source.participant],
  };
  return { context, consumer, source, fence, input };
}

describe("trusted Listing principal binding", () => {
  it("rejects audit-only identity without guessing a membership or credential", async () => {
    const f = fixture();
    const { listingAuthorityPrincipal: _, ...auditOnly } = f.context;
    await expect(f.fence.open(f.input, auditOnly)).rejects.toThrow("principal");
    expect(await f.consumer.readAll()).toHaveLength(0);
  });

  it("distinguishes the interactive and restricted principal that have identical audit identity", async () => {
    const f = fixture();
    const principal = requireListingAuthorityPrincipal(f.context);
    if (principal.kind !== "user") throw new Error("Synthetic user required");
    const restricted: EventStoreContext = {
      ...f.context,
      listingAuthorityPrincipal: {
        ...principal,
        delegation: { delegationId: "grant_synthetic_read_only", revision: "1", scopeCeiling: ["listings:read"] },
      },
    };
    expect(restricted.audit).toEqual(f.context.audit);
    const operation = await f.fence.open(f.input, f.context);
    await f.source.prepare(operation, f.context);
    await expect(f.fence.open(f.input, restricted)).rejects.toThrow("different command");
    await expect(f.source.prepare(operation, restricted)).rejects.toThrow("binding conflict");
    expect((await f.fence.inspect(operation)).status).toBe("pending");
  });

  it("binds selected membership, credential revision, delegation scopes and validity on identical retries", async () => {
    const f = fixture();
    const principal = requireListingAuthorityPrincipal(f.context);
    if (principal.kind !== "user") throw new Error("Synthetic user required");
    const operation = await f.fence.open(f.input, f.context);
    for (const changed of [
      { ...principal, membershipId: "mbr_other" },
      { ...principal, authentication: { kind: "api-key" as const, keyId: "key_synthetic", revision: "2" } },
      { ...principal, authentication: { ...principal.authentication, revision: "2" } },
      { ...principal, validBefore: "2098-01-01T00:00:00.000Z" },
      {
        ...principal,
        delegation: { delegationId: "grant_synthetic", revision: "1", scopeCeiling: ["listings:write"] },
      },
    ])
      await expect(f.fence.open(f.input, { ...f.context, listingAuthorityPrincipal: changed })).rejects.toThrow(
        "different command",
      );
    const restarted = createListingAuthorityFence({
      eventStore: f.consumer,
      owner: "marketplace",
      participants: [f.source],
    });
    expect(await restarted.open(f.input, authorityContext(operation))).toEqual(operation);
    expect((await f.source.prepare(operation, authorityContext(operation))).operation.principal).toEqual(principal);
  });

  it("rejects mismatched and expired admission and carries principal expiry into the atomic commit deadline", async () => {
    const f = fixture();
    const principal = requireListingAuthorityPrincipal(f.context);
    await expect(
      f.fence.open(f.input, { ...f.context, listingAuthorityPrincipal: { ...principal, accountId: "acc_other" } }),
    ).rejects.toThrow("principal");
    await expect(
      f.fence.open(f.input, {
        ...f.context,
        listingAuthorityPrincipal: { ...principal, validBefore: "2000-01-01T00:00:00.000Z" },
      }),
    ).rejects.toThrow("expired");
    const validBefore = new Date(Date.now() + 30_000).toISOString();
    const context = { ...f.context, listingAuthorityPrincipal: { ...principal, validBefore } };
    const operation = await f.fence.open(f.input, context);
    const grant = await f.source.prepare(operation, context);
    expect((await f.fence.prepareCommit(operation, [grant], {})).authorizationDeadline).toBe(validBefore);
  });

  it("retains an exact standing owner reservation on the final operation and rejects substitution", async () => {
    const f = fixture();
    const principal = {
      kind: "standing-system" as const,
      tenantId: f.input.tenantId,
      accountId: f.input.accountId,
      userId: f.input.actor.userId,
      admittingOwner: "pricing" as const,
      authorityId: "policy_synthetic",
      authorityRevision: "7",
      scopeCeiling: ["listings:write"],
      validBefore: "2099-01-01T00:00:00.000Z",
    };
    const context = { ...f.context, listingAuthorityPrincipal: principal };
    const input = {
      ...f.input,
      actor: {
        kind: "standing-system" as const,
        userId: principal.userId,
        authorityId: principal.authorityId,
        authorityRevision: principal.authorityRevision,
      },
      participants: [...f.input.participants, { owner: "pricing" as const, purpose: "evaluated-price" as const }],
    };
    const operation = await f.fence.open(input, context);
    const owner = createListingAuthorityParticipant({
      eventStore: createInMemoryEventStore().eventStore,
      participant: { owner: "pricing", purpose: "evaluated-price" },
      consumer: () => f.fence.forParticipant("pricing"),
      resources: () => ["synthetic-policy"],
      validate: async () => ({
        value: {},
        sourceRevisions: [{ resourceId: "synthetic-policy", revision: "7" }],
        validBefore: operation.prepareBefore,
      }),
    });
    const grant = await prepareListingStandingAuthority(operation, context, owner);
    expect(grant.operation).toEqual(operation);
    await expect(prepareListingStandingAuthority(operation, context, f.source)).rejects.toThrow("admitting owner");
    await expect(
      prepareListingStandingAuthority(
        operation,
        { ...context, listingAuthorityPrincipal: { ...principal, authorityRevision: "8" } },
        owner,
      ),
    ).rejects.toThrow("binding conflict");
    await f.fence.abort(operation, "synthetic-recovery");
    expect((await owner.settle(operation)).status).toBe("released");
  });
});
