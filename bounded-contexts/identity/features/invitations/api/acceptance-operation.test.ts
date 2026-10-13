import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { buildIdentityApi, type IdentityApiEnv } from "../../../api";
import { createInMemoryEventStore } from "../../../tests/in-memory-event-store";
import { createInvitationRuntime } from "./runtime";
import { createMembershipRuntime } from "../../memberships/api/runtime";
import type { IdentityServices } from "../../../support/runtime-support/services";
import { acceptInvitationOperation, readInvitationAcceptanceAuthority } from "./acceptance-operation";
import { acceptanceContext, acceptanceOperation, seedAcceptance } from "./acceptance-test-support";

function servicesFor(store: EventStore): IdentityServices {
  const deps = {
    eventStore: store,
    db: { query: async () => ({ rows: [] }) },
    checkpointStore: { loadCheckpoint: async () => ZERO_GLOBAL_POSITION, saveCheckpoint: async () => undefined },
  };
  return {
    eventStore: store,
    invitations: createInvitationRuntime(deps),
    memberships: createMembershipRuntime(deps),
    users: { getUser: async () => null, getUserByEmail: async () => null },
  } as unknown as IdentityServices;
}

async function accept(store: EventStore, operation = acceptanceOperation) {
  const app = new Hono<IdentityApiEnv>();
  app.use("*", async (c, next) => {
    c.set("context", acceptanceContext);
    await next();
  });
  app.route("/", buildIdentityApi(servicesFor(store)));
  return app.request("/internal/auth/invitations/ivt_invited/accept", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: operation.userId, acceptanceTokenHash: "existing-store-token-hash", operation }),
  });
}

describe("invitation-acceptance-identity-atomicity", () => {
  it("participant failure preserves every version and reveals independent appends", async () => {
    const inner = createInMemoryEventStore();
    await seedAcceptance(inner);
    const store: EventStore = {
      ...inner,
      appendToStream: async (input) => {
        if (input.streamId === "identity.membership-mbr_reserved") throw new Error("synthetic Membership fault");
        return inner.appendToStream(input);
      },
      appendToStreams: async () => {
        throw new Error("synthetic Membership fault");
      },
    };
    await expect(
      acceptInvitationOperation(store, {
        operation: acceptanceOperation,
        acceptanceTokenHash: "existing-store-token-hash",
        context: acceptanceContext,
      }),
    ).rejects.toThrow();
    expect(await inner.readStream({ streamId: "identity.invitation-ivt_invited" })).toHaveLength(2);
    expect(await inner.readStream({ streamId: "identity.membership-mbr_reserved" })).toHaveLength(0);
    expect(
      await inner.readStream({ streamId: `identity.invitation-acceptance-${acceptanceOperation.attemptId}` }),
    ).toHaveLength(0);
  });
  it("refuses terminal, duplicate and 501st-event authority tails", async () => {
    const store = createInMemoryEventStore();
    await seedAcceptance(store);
    const streamId = "identity.invitation-ivt_invited";
    const expiresAt = new Date(Date.now() + 86400_000 * 7).toISOString();
    await store.appendToStream({
      streamId,
      expectedVersion: 2,
      context: acceptanceContext,
      events: Array.from({ length: 498 }, () => ({ eventType: "identity.invitation.resent", payload: { expiresAt } })),
    });
    await expect(
      readInvitationAcceptanceAuthority(store, {
        invitationId: "ivt_invited",
        acceptanceTokenHash: "existing-store-token-hash",
        context: acceptanceContext,
      }),
    ).resolves.toMatchObject({ invitation: { status: "pending" } });
    await store.appendToStream({
      streamId,
      expectedVersion: 500,
      context: acceptanceContext,
      events: [{ eventType: "identity.invitation.cancelled", payload: {} }],
    });
    await expect(
      acceptInvitationOperation(store, {
        operation: acceptanceOperation,
        acceptanceTokenHash: "existing-store-token-hash",
        context: acceptanceContext,
      }),
    ).rejects.toThrow();
    expect(
      await store.readStream({ streamId: `identity.invitation-acceptance-${acceptanceOperation.attemptId}` }),
    ).toHaveLength(0);
  });
  it.each(["cancelled", "declined", "expired"])("refuses %s rather than synthesizing a receipt", async (status) => {
    const store = createInMemoryEventStore();
    await seedAcceptance(store);
    await store.appendToStream({
      streamId: "identity.invitation-ivt_invited",
      expectedVersion: 2,
      context: acceptanceContext,
      events: [{ eventType: `identity.invitation.${status}`, payload: {} }],
    });
    await expect(
      acceptInvitationOperation(store, {
        operation: acceptanceOperation,
        acceptanceTokenHash: "existing-store-token-hash",
        context: acceptanceContext,
      }),
    ).rejects.toThrow();
  });
  it("refuses a duplicate Account creation instead of trusting its last active state", async () => {
    const store = createInMemoryEventStore();
    await seedAcceptance(store);
    await store.appendToStream({
      streamId: "identity.account-acc_invited",
      expectedVersion: 1,
      context: acceptanceContext,
      events: [
        {
          eventType: "identity.account.created",
          payload: { accountId: "acc_invited", accountType: "business", name: "Poison", displayName: "Poison" },
        },
      ],
    });
    await expect(
      acceptInvitationOperation(store, {
        operation: acceptanceOperation,
        acceptanceTokenHash: "existing-store-token-hash",
        context: acceptanceContext,
      }),
    ).rejects.toThrow();
    expect(
      await store.readStream({ streamId: "identity.invitation-acceptance-" + acceptanceOperation.attemptId }),
    ).toHaveLength(0);
  });

  it("invitation-acceptance-terminal-history rejects secret nested fields in authoritative facts", async () => {
    const store = createInMemoryEventStore();
    await seedAcceptance(store);
    await store.appendToStream({
      streamId: "identity.invitation-ivt_invited",
      expectedVersion: 2,
      context: acceptanceContext,
      events: [
        {
          eventType: "identity.invitation.resent",
          payload: {
            expiresAt: new Date(Date.now() + 86400_000).toISOString(),
            extra: { password: "synthetic-must-not-be-authority" },
          },
        },
      ],
    });
    await expect(
      readInvitationAcceptanceAuthority(store, {
        invitationId: acceptanceOperation.invitationId,
        acceptanceTokenHash: "existing-store-token-hash",
        context: acceptanceContext,
      }),
    ).rejects.toThrow();
  });
  it("uses the attempt reservation and exact replay without a second Membership", async () => {
    const store = createInMemoryEventStore();
    await seedAcceptance(store);
    const first = await accept(store);
    expect(first.status).toBe(200);
    expect((await first.json()).membershipId).toBe(acceptanceOperation.membershipId);
    const again = await accept(store);
    expect(again.status).toBe(200);
    expect((await again.json()).membershipId).toBe(acceptanceOperation.membershipId);
    expect(store.streamIdsWithPrefix("identity.membership-")).toEqual(["identity.membership-mbr_reserved"]);
    expect(
      await store.readStream({ streamId: "identity.invitation-acceptance-" + acceptanceOperation.attemptId }),
    ).toHaveLength(1);
  });
});
