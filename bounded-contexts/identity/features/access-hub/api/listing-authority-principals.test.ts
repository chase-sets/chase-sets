import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { createListingAuthorityFence } from "@chase-sets/platform-runtime/listing-authority-fence";
import { createListingAuthorityParticipant } from "@chase-sets/platform-runtime/listing-authority-participant";
import type { ListingAuthorityPrincipal } from "@chase-sets/event-core/listing-authority";
import { createIdentityListingAuthority } from "./listing-authority";
import { identityFixture } from "./listing-authority-test-support";

async function delegatedFixture(additional = false) {
  const f = await identityFixture();
  await f.authority.mutateCredential({
    mutationId: "synthetic-delegation-1",
    context: f.audit,
    command: {
      kind: "delegation-grant",
      params: {
        authorizationId: "synthetic-delegation",
        userId: f.userId,
        accountId: f.accountId,
        clientId: "synthetic-client",
        platformProfileUrl: "https://synthetic.example.test",
        scopes: ["listings:write"],
        accessTokenHash: f.secrets.hashSecret("synthetic-bearer"),
        refreshTokenHash: "synthetic-refresh",
        accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
        refreshTokenExpiresAt: "2099-01-01T00:00:00.000Z",
        grantedAt: new Date().toISOString(),
      },
    },
  });
  const authenticated = await f.authority.authenticateDelegation("synthetic-bearer", f.membershipId);
  if (!authenticated || authenticated.kind !== "user" || authenticated.authentication.kind !== "delegation")
    throw new Error("Synthetic delegation did not authenticate");
  const base = f.context.listingAuthorityPrincipal!;
  if (base.kind !== "user") throw new Error("Expected user");
  const principal: ListingAuthorityPrincipal = additional
    ? { ...base, delegation: authenticated.authentication }
    : authenticated;
  return { ...f, context: { ...f.context, listingAuthorityPrincipal: principal } };
}

describe("Identity credential and standing boundaries", () => {
  for (const additional of [false, true])
    for (const mutation of ["revoke", "refresh", "expire"] as const)
      it(`${additional ? "additional" : "direct"} delegation ${mutation} defeats the retained terminal`, async () => {
        const f = await delegatedFixture(additional);
        const operation = await f.fence.open(f.input, f.context);
        const grant = await f.source.prepare(operation, f.context);
        const terminal = await f.fence.prepareCommit(operation, [grant], {});
        if (mutation === "expire") {
          const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(grant.validBefore) + 1);
          try {
            await expect(f.consumerStore.appendToStreams!(terminal)).rejects.toThrow();
            expect((await f.source.inspect(operation))?.status).toBe("reserved");
          } finally {
            clock.mockRestore();
          }
        } else {
          await f.authority.mutateCredential({
            mutationId: `synthetic-${mutation}`,
            context: f.audit,
            command:
              mutation === "revoke"
                ? {
                    kind: "delegation-revoke",
                    authorizationId: "synthetic-delegation",
                    accountId: f.accountId,
                    revokedAt: new Date().toISOString(),
                    reason: "synthetic-test",
                  }
                : {
                    kind: "delegation-rotate",
                    authorizationId: "synthetic-delegation",
                    params: {
                      refreshTokenHash: "synthetic-refresh",
                      newAccessTokenHash: "synthetic-next-access",
                      newRefreshTokenHash: "synthetic-next-refresh",
                      accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
                      refreshTokenExpiresAt: "2099-01-01T00:00:00.000Z",
                      refreshedAt: new Date().toISOString(),
                    },
                  },
          });
          expect((await f.fence.inspect(operation)).status).toBe("aborted");
          await expect(f.consumerStore.appendToStreams!(terminal)).rejects.toThrow();
          const later = await f.fence.open({ ...f.input, requestId: "synthetic-stale-delegation" }, f.context);
          await expect(f.source.prepare(later, f.context)).rejects.toThrow(/delegation/);
        }
      });

  for (const fault of ["scope", "revision", "account", "user"] as const)
    it(`delegation ${fault} substitution fails without promoting the account's owner role`, async () => {
      const f = await delegatedFixture();
      const p = f.context.listingAuthorityPrincipal;
      if (p.kind !== "user" || p.authentication.kind !== "delegation") throw new Error("Expected delegated user");
      const authentication = {
        ...p.authentication,
        ...(fault === "scope"
          ? { scopeCeiling: ["inventory:write"] }
          : fault === "revision"
            ? { revision: "synthetic-counterfeit" }
            : {}),
      };
      const principal = {
        ...p,
        authentication,
        ...(fault === "account"
          ? { accountId: "acc_synthetic_foreign" }
          : fault === "user"
            ? { userId: "usr_synthetic_foreign" }
            : {}),
      };
      const context = { ...f.context, listingAuthorityPrincipal: principal };
      await expect(
        (async () => {
          const operation = await f.fence.open(f.input, context);
          await f.source.prepare(operation, context);
        })(),
      ).rejects.toThrow();
      expect(await f.authority.authenticateApiKey("synthetic-counterfeit", f.membershipId, p.validBefore)).toBeNull();
      expect(await f.authority.authenticateDelegation("synthetic-counterfeit", f.membershipId)).toBeNull();
    });

  it("requires the actual admitting owner's grant, not an audit system-user identity", async () => {
    const f = await identityFixture();
    const principal: ListingAuthorityPrincipal = {
      kind: "standing-system",
      tenantId: f.audit.tenantId,
      accountId: f.accountId,
      userId: f.userId,
      admittingOwner: "pricing",
      authorityId: "synthetic-standing",
      authorityRevision: "1",
      scopeCeiling: ["listings.manage"],
      validBefore: "2099-01-01T00:00:00.000Z",
    };
    const context = { ...f.audit, listingAuthorityPrincipal: principal };
    let allowed = true;
    // Synthetic admitting OWNER only; actual Identity must demand this protected upstream promise.
    const pricing = createListingAuthorityParticipant({
      eventStore: createInMemoryEventStore().eventStore,
      participant: { owner: "pricing", purpose: "evaluated-price" },
      resources: () => ["synthetic-standing"],
      consumer: () => fence.forParticipant("pricing"),
      validate: async (operation) => {
        if (
          !allowed ||
          operation.principal?.kind !== "standing-system" ||
          operation.principal.authorityRevision !== "1"
        )
          throw new Error("Synthetic standing authority invalid");
        return {
          value: {},
          sourceRevisions: [{ resourceId: "synthetic-standing", revision: "1" }],
          validBefore: operation.prepareBefore,
        };
      },
    });
    const identity = createIdentityListingAuthority({
      eventStore: f.memory.eventStore,
      credentials: f.credentials,
      listingAuthorityConsumer: () => fence.forParticipant("identity"),
      standingAuthority: () => pricing,
    });
    const fence = createListingAuthorityFence({
      eventStore: f.consumerStore,
      owner: "marketplace",
      participants: [identity.port, pricing],
    });
    const input = {
      ...f.input,
      actor: {
        kind: "standing-system" as const,
        userId: f.userId,
        authorityId: principal.authorityId,
        authorityRevision: principal.authorityRevision,
      },
      participants: [identity.port.participant, pricing.participant],
    };
    const operation = await fence.open(input, context);
    const grants = await identity.prepareAuthorities(operation, context);
    expect(grants).toHaveLength(2);
    const terminal = await fence.prepareCommit(operation, grants, {});
    await pricing.mutate({
      resources: ["synthetic-standing"],
      mutationId: "synthetic-standing-revoke",
      command: {},
      context: f.audit,
      prepare: async () => {
        allowed = false;
        return [];
      },
    });
    await expect(f.consumerStore.appendToStreams!(terminal)).rejects.toThrow();
    const later = await fence.open({ ...input, requestId: "synthetic-standing-after-revoke" }, context);
    await expect(identity.prepareAuthorities(later, context)).rejects.toThrow(/standing authority invalid/);
    const missing = createIdentityListingAuthority({
      eventStore: f.memory.eventStore,
      credentials: f.credentials,
      listingAuthorityConsumer: () => fence.forParticipant("identity"),
    });
    await expect(missing.prepareAuthorities(later, context)).rejects.toThrow(/not mounted/);
  });
});
