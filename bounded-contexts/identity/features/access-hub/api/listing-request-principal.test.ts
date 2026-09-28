import { describe, expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/auth-context";
import type { ListingAuthoritySessionEvidence } from "@chase-sets/event-core/listing-authority";
import { createListingRequestPrincipalResolver } from "./listing-request-principal";
import { identityFixture } from "./listing-authority-test-support";

describe("authenticated Listing request principal", () => {
  async function fixture() {
    const f = await identityFixture();
    const actor: ResolvedActor = {
      tenantId: f.context.tenantId,
      userId: f.userId,
      accountId: f.accountId,
      membershipId: f.membershipId,
      sessionId: "synthetic-session",
      roleKey: "owner",
      permissions: ["listings.manage"],
    };
    const evidence: ListingAuthoritySessionEvidence = {
      tenantId: actor.tenantId,
      userId: actor.userId,
      accountId: actor.accountId,
      authentication: {
        kind: "session",
        sessionId: actor.sessionId,
        revision: "1",
        tokenRevision: "synthetic-token-r1",
      },
      validBefore: "2099-01-01T00:00:00.000Z",
    };
    const authenticated = vi.fn(async () => evidence);
    return {
      ...f,
      actor,
      evidence,
      authenticated,
      resolve: createListingRequestPrincipalResolver(f.authority, authenticated),
    };
  }

  it("uses authenticated evidence and the actual Identity membership, not request claims", async () => {
    const f = await fixture();
    const request = new Request("https://synthetic.test/api/marketplace", {
      method: "POST",
      body: JSON.stringify({ listingAuthorityPrincipal: { authentication: { tokenRevision: "forged" } } }),
    });
    expect(await f.resolve(request, f.actor)).toEqual({
      ...f.evidence,
      kind: "user",
      membershipId: f.membershipId,
      delegation: null,
    });
    expect(f.authenticated).toHaveBeenCalledWith(request);
    await f.invalidate();
    await expect(f.resolve(request, f.actor)).rejects.toThrow("membership");
  });

  it("does not cross-bind an actor or manufacture a guest credential", async () => {
    const f = await fixture();
    const request = new Request("https://synthetic.test");
    for (const change of [
      { sessionId: "guest:synthetic" },
      { accountId: "acc_other" },
      { userId: "usr_other" },
      { tenantId: "tnt_other" },
    ])
      expect(await f.resolve(request, { ...f.actor, ...change })).toBeNull();
    expect(await createListingRequestPrincipalResolver(f.authority, async () => null)(request, f.actor)).toBeNull();
  });

  it("never reinterprets a delegated actor as a session or falls back to its cookie", async () => {
    const f = await fixture();
    const actor = { ...f.actor, agentGrant: { grantId: "synthetic-delegation", scopes: [], rolePermissions: [] } };
    expect(
      await f.resolve(
        new Request("https://synthetic.test", {
          headers: { authorization: "Bearer synthetic-invalid", cookie: "chase_sets_session=synthetic-cookie" },
        }),
        actor,
      ),
    ).toBeNull();
    expect(f.authenticated).not.toHaveBeenCalled();
  });
});
