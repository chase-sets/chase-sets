import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { createListingAuthorityParticipant } from "@chase-sets/platform-runtime/listing-authority-participant";
import { createListingAuthorityFence } from "@chase-sets/platform-runtime/listing-authority-fence";
import { listingAuthoritySessionConformance } from "@chase-sets/platform-runtime/listing-authority-conformance";
import { createIdentityListingAuthority } from "@chase-sets/identity/server";
import { authFixture } from "./listing-authority-test-support";

async function combinedFixture(owner: "marketplace" | "ordering" = "marketplace") {
  return authFixture({
    owner,
    restartIdentity: (eventStore, consumer, sessionAuthority) =>
      createIdentityListingAuthority({ eventStore, listingAuthorityConsumer: consumer, sessionAuthority }).source,
    makeIdentity: async (eventStore, consumer, sessionAuthority) => {
      const authority = createIdentityListingAuthority({
        eventStore,
        listingAuthorityConsumer: consumer,
        sessionAuthority,
      });
      const context = {
        tenantId: "tnt_synthetic_auth",
        audit: { forAccountId: "acc_synthetic_auth", performedByUserId: "usr_synthetic_auth" },
      } as const;
      // Canonical Identity bulk writer, not a mirror or synthetic policy. SQL is not used by session principals.
      await authority.eventStore.appendToStreams!([
        {
          streamId: "identity.account-acc_synthetic_auth",
          expectedVersion: 0,
          context,
          events: [
            {
              eventType: "identity.account.created",
              payload: {
                accountId: "acc_synthetic_auth",
                name: "Synthetic account",
                accountType: "personal",
                displayName: "Synthetic account",
              },
            },
          ],
        },
        {
          streamId: "identity.user-usr_synthetic_auth",
          expectedVersion: 0,
          context,
          events: [
            {
              eventType: "identity.user.created",
              payload: {
                userId: "usr_synthetic_auth",
                displayName: "Synthetic user",
                givenName: "",
                familyName: "",
                primaryEmail: "synthetic@example.test",
                primaryContactMethod: {
                  contactMethodId: "synthetic-contact",
                  type: "email",
                  value: "synthetic@example.test",
                  verifiedAt: null,
                },
              },
            },
          ],
        },
        {
          streamId: "identity.membership-mbr_synthetic_auth",
          expectedVersion: 0,
          context,
          events: [
            {
              eventType: "identity.membership.granted",
              payload: {
                membershipId: "mbr_synthetic_auth",
                userId: "usr_synthetic_auth",
                accountId: "acc_synthetic_auth",
                roleKey: "owner",
              },
            },
          ],
        },
      ]);
      return authority.source;
    },
  });
}

for (const owner of ["marketplace", "ordering"] as const)
  describe(`actual Auth + Identity with separate ${owner} consumer`, () => {
    listingAuthoritySessionConformance(it, () => combinedFixture(owner));
  });

describe("combined owner authority boundaries", () => {
  it("fits the eight-participant maximum with real Auth and Identity and exact duplicate preparation", async () => {
    const f = await combinedFixture();
    const extraParticipants = [
      { owner: "channels", purpose: "connection" },
      { owner: "pricing", purpose: "evaluated-price" },
      { owner: "inventory", purpose: "stock-allocation" },
      { owner: "catalog", purpose: "product-measures" },
      { owner: "marketplace", purpose: "native-readiness" },
      { owner: "commercial-terms", purpose: "native-fee" },
    ] as const;
    const extra = extraParticipants.map((participant) =>
      createListingAuthorityParticipant({
        eventStore: createInMemoryEventStore().eventStore,
        participant,
        resources: () => [`synthetic-${participant.owner}`],
        consumer: () => fence.forParticipant(participant.owner),
        validate: async (operation) => ({
          value: {},
          sourceRevisions: [{ resourceId: `synthetic-${participant.owner}`, revision: "1" }],
          validBefore: operation.prepareBefore,
        }),
      }),
    );
    const identity = createIdentityListingAuthority({
      eventStore: f.identityStore,
      listingAuthorityConsumer: () => fence.forParticipant("identity"),
      sessionAuthority: f.sessions.listingAuthority.port,
    });
    const fence = createListingAuthorityFence({
      eventStore: f.consumerStore,
      owner: "marketplace",
      participants: [f.sessions.listingAuthority.port, identity.port, ...extra],
    });
    const input = {
      ...f.input,
      participants: [f.sessions.listingAuthority.port.participant, identity.port.participant, ...extraParticipants],
    };
    const operation = await fence.open(input, f.context);
    const composite = await identity.prepareAuthorities(operation, f.context);
    expect(await identity.prepareAuthorities(operation, f.context)).toEqual(composite);
    const grants = [...composite, ...(await Promise.all(extra.map((source) => source.prepare(operation, f.context))))];
    expect(grants).toHaveLength(8);
    await f.consumerStore.appendToStreams!(await fence.prepareCommit(operation, grants, { accepted: true }));
    expect((await fence.inspect(operation)).status).toBe("committed");
    await fence.settle(operation);
  });

  it("lost prepare and commit replies reconcile the same final operation without refreshing credentials", async () => {
    const f = await combinedFixture();
    const operation = await f.fence.open(f.input, f.context);
    const prepare = f.sessions.listingAuthority.port.prepare;
    const fault = vi.spyOn(f.sessions.listingAuthority.port, "prepare").mockImplementationOnce(async (...args) => {
      await prepare(...args);
      throw new Error("Synthetic lost prepare reply");
    });
    await expect(f.prepareAuthorities(operation, f.context)).rejects.toThrow(/lost prepare reply/);
    fault.mockRestore();
    f.restart();
    const replay = await f.fence.open(f.input, f.context);
    expect(replay).toEqual(operation);
    const grants = await f.prepareAuthorities(replay, f.context);
    const terminal = await f.fence.prepareCommit(replay, grants, { accepted: true });
    const effects = ["business", "request-success"].map((kind) => ({
      streamId: `marketplace.synthetic-lost-${kind}`,
      expectedVersion: 0 as const,
      context: f.context,
      events: [{ eventType: `marketplace.synthetic-lost-${kind}`, payload: {} }],
    }));
    const commit = f.consumerStore.appendToStreams!;
    const lost = vi.spyOn(f.consumerStore, "appendToStreams").mockImplementationOnce(async (inputs) => {
      await commit(inputs);
      throw new Error("Synthetic lost commit reply");
    });
    await expect(f.consumerStore.appendToStreams!([...terminal, ...effects])).rejects.toThrow(/lost commit reply/);
    lost.mockRestore();
    f.restart();
    await f.invalidate();
    expect((await f.fence.inspect(replay)).status).toBe("committed");
    for (const effect of effects)
      expect(await f.consumerStore.readStream({ streamId: effect.streamId })).toHaveLength(1);
    await f.fence.settle(replay);
  });
  it("Auth success never confers Identity permissions", async () => {
    const f = await combinedFixture();
    const identity = createIdentityListingAuthority({
      eventStore: f.identityStore,
      listingAuthorityConsumer: () => f.fence.forParticipant("identity"),
      sessionAuthority: f.sessions.listingAuthority.port,
    });
    await identity.eventStore.appendToStream({
      streamId: "identity.membership-mbr_synthetic_auth",
      expectedVersion: 1,
      context: f.audit,
      events: [{ eventType: "identity.membership.role-changed", payload: { roleKey: "viewer" } }],
    });
    const operation = await f.fence.open(f.input, f.context);
    await f.sessions.listingAuthority.port.prepare(operation, f.context);
    await expect(f.identity.prepare(operation, f.context)).rejects.toThrow(/cannot manage listings/);
    expect((await f.sessions.listingAuthority.port.inspect(operation))?.status).toBe("reserved");
    await f.fence.abort(operation, "synthetic-partial-policy-failure");
    await f.sessions.listingAuthority.port.settle(operation);
  });

  it("token-only rotation defeats a complete retained composite without changing the session revision", async () => {
    const f = await combinedFixture();
    const operation = await f.fence.open(f.input, f.context);
    const grants = await f.prepareAuthorities(operation, f.context);
    const terminal = await f.fence.prepareCommit(operation, grants, { accepted: true });
    await f.sessions.listingAuthority.mutateToken({
      mutationId: "synthetic-combined-rotation",
      context: f.audit,
      sessionId: f.sessionId,
      tokenHash: f.auth.hashSecret("synthetic-rotated-secret"),
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect((await f.sessions.listingAuthority.readSession(f.sessionId)).revision).toBe("1");
    await expect(f.consumerStore.appendToStreams!(terminal)).rejects.toThrow();
    expect((await f.fence.inspect(operation)).status).toBe("aborted");
    await f.identity.settle(operation);
    expect((await f.identity.inspect(operation))?.status).toBe("released");
  });
});
