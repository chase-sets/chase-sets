import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore, withSyntheticListingPrincipal } from "@chase-sets/event-core/test-support";
import {
  assertListingAuthorityParticipants,
  completeListingAuthorityParticipants,
  requireListingAuthorityPrincipal,
  LISTING_AUTHORITY_PARTICIPANT_LIMIT,
  type ListingAuthorityOperation,
  type ListingAuthorityParticipant,
  type ListingAuthoritySessionAuthorityPort,
  type ListingAuthoritySessionEvidence,
} from "@chase-sets/event-core/listing-authority";
import {
  combineListingAuthorityReservations,
  createListingAuthorityFence,
  prepareListingSessionAuthority,
  type ListingAuthorityOperationInput,
} from "./listing-authority-fence";
import { createListingAuthorityParticipant } from "./listing-authority-participant";
import { listingAuthoritySessionConformance } from "./listing-authority-conformance";
import { authorityContext, authorityPayload } from "./listing-authority-state";

/** Synthetic protocol sources, NOT Auth authentication or Identity policy implementation. */
function fixture(owner: "marketplace" | "ordering" = "marketplace") {
  const evidence: ListingAuthoritySessionEvidence = {
    tenantId: "tnt_synthetic",
    accountId: "acc_synthetic",
    userId: "usr_synthetic",
    authentication: {
      kind: "session",
      sessionId: "ses_synthetic",
      revision: "7",
      tokenRevision: "synthetic-token-version-9",
    },
    validBefore: "2099-01-01T00:00:00.000Z",
  };
  const context = withSyntheticListingPrincipal(
    {
      tenantId: "tnt_synthetic",
      audit: { forAccountId: "acc_synthetic", performedByUserId: "usr_synthetic" },
    },
    evidence.authentication,
  );
  const consumerStore = createInMemoryEventStore().eventStore;
  const sourceStore = createInMemoryEventStore().eventStore;
  const identityStore = createInMemoryEventStore().eventStore;
  let enabled = true;
  function services() {
    const participant = { owner: "auth", purpose: "authenticated-session" } as const;
    const source = createListingAuthorityParticipant({
      eventStore: sourceStore,
      participant,
      resourceScope: "owner",
      consumer: () => fence.forParticipant("auth"),
      resources: () => ["session/ses_synthetic"],
      validate: async (operation) => {
        if (!enabled) throw new Error("Synthetic session revoked.");
        return {
          value: {},
          validBefore: new Date(
            Math.min(Date.parse(operation.prepareBefore), Date.parse(operation.principal!.validBefore)),
          ).toISOString(),
          sourceRevisions: [
            { resourceId: "session/ses_synthetic", revision: "7" },
            { resourceId: "session-token/ses_synthetic", revision: "synthetic-token-version-9" },
          ],
        };
      },
    });
    const port: ListingAuthoritySessionAuthorityPort = { ...source, participant };
    const identity = createListingAuthorityParticipant({
      eventStore: identityStore,
      participant: { owner: "identity", purpose: "manage-listing" },
      consumer: () => fence.forParticipant("identity"),
      resources: () => ["synthetic-membership"],
      validate: async (operation) => ({
        value: {},
        validBefore: operation.prepareBefore,
        sourceRevisions: [{ resourceId: "synthetic-membership", revision: "1" }],
      }),
    });
    const fence = createListingAuthorityFence({ eventStore: consumerStore, owner, participants: [source, identity] });
    const input: ListingAuthorityOperationInput = {
      tenantId: context.tenantId,
      accountId: context.audit.forAccountId,
      actor: { kind: "user", userId: context.audit.performedByUserId },
      committingOwner: owner,
      kind: owner === "ordering" ? "native-commitment" : "accept-price",
      requestId: "synthetic-session-protocol",
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
        commitmentSourceId: owner === "ordering" ? "ord_synthetic" : null,
      },
      target: { kind: "native-marketplace" },
      expectedListingRevision: 1,
      expectedTargetRevision: 1,
      expectedVisibilityRevision: null,
      expectedPublicationRevision: null,
      participants: completeListingAuthorityParticipants(
        [identity.participant],
        requireListingAuthorityPrincipal(context),
      ),
    };
    return {
      context,
      consumerStore,
      sourceStore,
      identityStore,
      source,
      port,
      identity,
      fence,
      input,
      prepareAuthorities: async (operation: ListingAuthorityOperation, carrier = context) => [
        await prepareListingSessionAuthority(operation, carrier, port),
        await identity.prepare(operation, carrier),
      ],
      invalidate: async () => {
        await source.mutate({
          context,
          resources: ["session/ses_synthetic"],
          mutationId: "synthetic-revoke",
          command: { revoke: true },
          prepare: async () => {
            enabled = false;
            return [];
          },
        });
      },
      restart: services,
    };
  }
  return services();
}

describe("synthetic session protocol conformance, not actual owner proof", () => {
  it.each([
    "infrastructure/platform-runtime/listing-authority-conformance.ts#readStream#1",
    "infrastructure/platform-runtime/listing-authority-conformance.ts#readStream#2",
  ])("synthetic effect census %s rejects an incorrect count", async (siteId) => {
    const cases = new Map<string, () => Promise<void>>();
    listingAuthoritySessionConformance(
      (name, run) => cases.set(name, run),
      async () => {
        const f = fixture();
        const read = f.consumerStore.readStream;
        vi.spyOn(f.consumerStore, "readStream").mockImplementation(async (input) => {
          const events = await read(input);
          if (input.streamId.includes("listing-authority")) return events;
          return siteId.endsWith("#1") ? [{ synthetic: true } as never] : [];
        });
        return f;
      },
    );
    const name = siteId.endsWith("#1")
      ? "session revoke rejects a retained append and atomically leaves no business or request success"
      : "unchanged session commits once and commit-wins preserves business and request success";
    await expect(cases.get(name)!()).rejects.toMatchObject({
      code: "ERR_ASSERTION",
      actual: siteId.endsWith("#1") ? 1 : 0,
      expected: siteId.endsWith("#1") ? 0 : 1,
    });
  });
  for (const owner of ["marketplace", "ordering"] as const)
    describe(owner, () => listingAuthoritySessionConformance(it, async () => fixture(owner)));

  it("natural principal expiry rejects retained append without erasing the promise or upgrading recovery", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const principal = requireListingAuthorityPrincipal(f.context);
      const context = {
        ...f.context,
        listingAuthorityPrincipal: {
          ...principal,
          validBefore: new Date(Date.now() + 30_000).toISOString(),
        },
      };
      const operation = await f.fence.open(f.input, context);
      const grants = await f.prepareAuthorities(operation, context);
      const terminal = await f.fence.prepareCommit(operation, grants, { accepted: true });
      for (const append of terminal)
        expect(append.authorizationDeadline).toBe(context.listingAuthorityPrincipal.validBefore);
      vi.setSystemTime(Date.now() + 31_000);
      await expect(f.consumerStore.appendToStreams!([...terminal])).rejects.toThrow();
      expect((await f.source.inspect(operation))?.status).toBe("reserved");
      expect(await f.restart().fence.open(f.input, authorityContext(operation))).toEqual(operation);
      await f.fence.abort(operation, "synthetic-expiry");
      await f.fence.settle(operation);
      expect((await f.source.inspect(operation))?.status).toBe("released");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects missing token revisions without fabricating legacy authentication", async () => {
    const f = fixture();
    const principal = requireListingAuthorityPrincipal(f.context);
    if (principal.kind !== "user" || principal.authentication.kind !== "session") throw new Error("session fixture");
    const { tokenRevision: _, ...authentication } = principal.authentication;
    const context = { ...f.context, listingAuthorityPrincipal: { ...principal, authentication } } as typeof f.context;
    await expect(f.fence.open(f.input, context)).rejects.toThrow("principal");
    expect(await f.consumerStore.readAll()).toHaveLength(0);
  });

  it("requires the original carrier even for Auth grant replay and reconstructs it after restart", async () => {
    const f = fixture();
    const operation = await f.fence.open(f.input, f.context);
    const grant = await prepareListingSessionAuthority(operation, f.context, f.port);
    const { listingAuthorityPrincipal: _, ...auditOnly } = f.context;
    await expect(f.source.prepare(operation, auditOnly)).rejects.toThrow("principal");
    expect(await f.restart().source.prepare(operation, authorityContext(operation))).toEqual(grant);
    expect(await prepareListingSessionAuthority(operation, authorityContext(operation), f.restart().port)).toEqual(
      grant,
    );
    expect(grant.sourceRevisions).toEqual([
      { resourceId: "session/ses_synthetic", revision: "7" },
      { resourceId: "session-token/ses_synthetic", revision: "synthetic-token-version-9" },
    ]);
    expect((await f.fence.inspect(operation)).status).toBe("pending");
    await expect(f.source.settle(operation)).rejects.toThrow();
  });

  it("rejects wrong ports, altered grants, unreserved status and extended validity", async () => {
    const f = fixture();
    const operation = await f.fence.open(f.input, f.context);
    const grant = await prepareListingSessionAuthority(operation, f.context, f.port);
    await expect(
      prepareListingSessionAuthority(operation, f.context, f.identity as ListingAuthoritySessionAuthorityPort),
    ).rejects.toThrow("binding conflict");
    for (const changed of [
      { ...grant, operation: { ...operation, generation: 2 } },
      { ...grant, participant: f.identity.participant },
      { ...grant, status: "consumed" as const },
      { ...grant, validBefore: "2100-01-01T00:00:00.000Z" },
      { ...grant, validBefore: "invalid" },
      { ...grant, resources: ["session/ses_other"] },
      { ...grant, sourceRevisions: grant.sourceRevisions.slice(0, 1) },
      { ...grant, sourceRevisions: grant.sourceRevisions.map((entry) => ({ ...entry, revision: "synthetic-stale" })) },
    ]) {
      const port = { ...f.port, prepare: async () => changed, inspect: async () => changed };
      await expect(prepareListingSessionAuthority(operation, f.context, port)).rejects.toThrow();
    }
    await expect(
      prepareListingSessionAuthority(operation, f.context, { ...f.port, inspect: async () => null }),
    ).rejects.toThrow("binding conflict");
  });

  it("rejects Auth without session authentication and does not admit Auth as a standing issuer", async () => {
    const f = fixture();
    const keyContext = withSyntheticListingPrincipal(f.context);
    await expect(f.fence.open(f.input, keyContext)).rejects.toThrow("authenticated-session");
    const { listingAuthorityPrincipal: _, ...auditOnly } = f.context;
    await expect(f.fence.open({ ...f.input, participants: [f.port.participant] }, auditOnly)).rejects.toThrow(
      "authenticated-session",
    );
    expect(() =>
      requireListingAuthorityPrincipal({
        ...f.context,
        listingAuthorityPrincipal: {
          kind: "standing-system",
          tenantId: f.input.tenantId,
          accountId: f.input.accountId,
          userId: f.input.actor.userId,
          admittingOwner: "auth",
          authorityId: "synthetic",
          authorityRevision: "1",
          scopeCeiling: [],
          validBefore: "2099-01-01T00:00:00.000Z",
        },
      }),
    ).toThrow("principal");
  });

  it("rejects retained operations missing Auth at final authorization, source inspection and recovery", async () => {
    const f = fixture();
    const operation = await f.fence.open(f.input, f.context);
    const forged = { ...operation, participants: [f.identity.participant], operationId: "synthetic-corrupt-retained" };
    await f.consumerStore.appendToStream({
      streamId: `marketplace.listing-authority-operation-${forged.operationId}`,
      expectedVersion: 0,
      context: f.context,
      events: [
        {
          eventType: "marketplace.listing-authority-operation.opened",
          payload: authorityPayload({ operation: forged }),
        },
      ],
    });
    await expect(f.fence.prepareCommit(forged, [], {})).rejects.toThrow("authenticated-session");
    await expect(f.source.inspect(forged)).rejects.toThrow("authenticated-session");
    expect(() => authorityContext(forged)).toThrow("authenticated-session");
    expect(
      await f.consumerStore.readStream({ streamId: `marketplace.listing-authority-operation-${forged.operationId}` }),
    ).toHaveLength(1);
  });

  it("fails closed when the final consumer has no Auth mount", async () => {
    const f = fixture();
    const operation = await f.fence.open(f.input, f.context);
    const grants = await f.prepareAuthorities(operation);
    const missing = createListingAuthorityFence({
      eventStore: f.consumerStore,
      owner: "marketplace",
      participants: [f.identity],
    });
    await expect(missing.prepareCommit(operation, grants, {})).rejects.toThrow("not mounted");
    expect((await f.source.inspect(operation))?.status).toBe("reserved");
  });

  it("requires globally owner-scoped serialization for the Auth session source", () => {
    const f = fixture();
    expect(() =>
      createListingAuthorityParticipant({
        eventStore: f.sourceStore,
        participant: f.port.participant,
        consumer: () => f.fence.forParticipant("auth"),
        resources: () => ["session/ses_synthetic"],
        validate: async () => ({ value: {}, validBefore: "2099-01-01T00:00:00.000Z", sourceRevisions: [] }),
      }),
    ).toThrow("owner-scoped");
  });

  it("deduplicates only identical final grants, never a substituted operation or same-name grant", async () => {
    const f = fixture();
    const operation = await f.fence.open(f.input, f.context);
    const grants = await f.prepareAuthorities(operation);
    expect(combineListingAuthorityReservations(operation, [...grants, ...grants])).toEqual(grants);
    expect(() =>
      combineListingAuthorityReservations(operation, [...grants, { ...grants[0]!, reservationId: "synthetic-other" }]),
    ).toThrow("binding conflict");
    expect(() => combineListingAuthorityReservations({ ...operation, generation: 2 }, grants)).toThrow(
      "binding conflict",
    );
  });
});

describe("bounded final participant matrix", () => {
  const identity = { owner: "identity", purpose: "manage-listing" } as const;
  const inventory = { owner: "inventory", purpose: "stock-allocation" } as const;
  const catalog = { owner: "catalog", purpose: "product-measures" } as const;
  const fee = { owner: "commercial-terms", purpose: "native-fee" } as const;
  const pricing = { owner: "pricing", purpose: "evaluated-price" } as const;
  const connection = { owner: "channels", purpose: "connection" } as const;
  const readiness = { owner: "marketplace", purpose: "native-readiness" } as const;
  const commitment = { owner: "marketplace", purpose: "native-commitment" } as const;
  const matrix: Record<string, readonly ListingAuthorityParticipant[]> = {
    "channel-only creation": [identity, inventory, catalog],
    "native creation": [identity, inventory, catalog, fee],
    "manual native acceptance": [identity],
    "evaluated native acceptance": [identity, pricing],
    "external acceptance": [identity, pricing, connection],
    "channel activation": [identity, inventory, connection],
    "native enable": [identity, inventory, catalog, readiness, fee],
    "native disable": [identity],
    "native-off capacity or resume": [identity, inventory],
    "native capacity increase": [identity, inventory, fee],
    "final native commitment": [identity, inventory, catalog, commitment],
  };
  for (const [name, participants] of Object.entries(matrix))
    it(`${name}: completes session exactly once without requiring Auth for other credentials`, () => {
      const f = fixture();
      const principal = requireListingAuthorityPrincipal(f.context);
      const completed = completeListingAuthorityParticipants(participants, principal);
      expect(completed).toHaveLength(participants.length + 1);
      expect(completed.length).toBeLessThanOrEqual(LISTING_AUTHORITY_PARTICIPANT_LIMIT);
      expect(completeListingAuthorityParticipants(completed, principal)).toEqual(completed);
      expect(
        completeListingAuthorityParticipants(
          participants,
          requireListingAuthorityPrincipal(withSyntheticListingPrincipal(f.context)),
        ),
      ).toEqual(participants);
      const user = requireListingAuthorityPrincipal(withSyntheticListingPrincipal(f.context));
      if (user.kind !== "user") throw new Error("synthetic user");
      const delegated = {
        ...user,
        authentication: {
          kind: "delegation" as const,
          delegationId: "synthetic-delegation",
          revision: "1",
          scopeCeiling: ["listings:write"],
        },
      };
      expect(completeListingAuthorityParticipants(participants, delegated)).toEqual(participants);
      const standing = {
        kind: "standing-system" as const,
        tenantId: user.tenantId,
        accountId: user.accountId,
        userId: user.userId,
        admittingOwner: "pricing" as const,
        authorityId: "synthetic-policy",
        authorityRevision: "1",
        scopeCeiling: ["listings:write"],
        validBefore: user.validBefore,
      };
      expect(completeListingAuthorityParticipants(participants, standing)).toEqual(participants);
    });
  it("preserves the eight-participant limit, closed purpose ownership and rejects duplicate Auth", () => {
    const principal = requireListingAuthorityPrincipal(fixture().context);
    const maximum = completeListingAuthorityParticipants(
      [identity, inventory, catalog, fee, pricing, connection, readiness],
      principal,
    );
    expect(maximum).toHaveLength(8);
    expect(() => assertListingAuthorityParticipants([...maximum, commitment])).toThrow("participant set");
    expect(() => completeListingAuthorityParticipants([...maximum, maximum.at(-1)!], principal)).toThrow(
      "participant set",
    );
    expect(() => assertListingAuthorityParticipants([{ owner: "identity", purpose: "authenticated-session" }])).toThrow(
      "participant set",
    );
    expect(() => assertListingAuthorityParticipants([{ owner: "auth", purpose: "manage-listing" }])).toThrow(
      "participant set",
    );
  });
});
