import { describe, expect, it, vi } from "vitest";
import { listingAuthoritySessionConformance } from "@chase-sets/platform-runtime/listing-authority-conformance";
import { AuthSessionMutationPendingError } from "./listing-authority";
import { authFixture } from "./listing-authority-test-support";

for (const owner of ["marketplace", "ordering"] as const)
  describe(`actual Auth with separate synthetic ${owner} consumer`, () => {
    listingAuthoritySessionConformance(it, () => authFixture({ owner }));
  });

describe("Auth session invalidators", () => {
  it("missing resource and integrity histories cannot permit effective revoke then retained commit", async () => {
    const f = await authFixture();
    const operation = await f.fence.open(f.input, f.context);
    const grants = await f.prepareAuthorities(operation, f.context);
    const terminal = await f.fence.prepareCommit(operation, grants, { accepted: true });
    const effects = ["business", "request-success"].map((kind) => ({
      streamId: `marketplace.synthetic-loss-${kind}`,
      expectedVersion: 0 as const,
      context: f.context,
      events: [{ eventType: `marketplace.synthetic-loss-${kind}`, payload: { accepted: true } }],
    }));
    for (const id of f.authMemory.streams.keys()) {
      if (id.startsWith("auth.listing-authority-resource-") || id.startsWith("auth.listing-authority-integrity-"))
        f.authMemory.streams.delete(id);
    }
    f.restart();
    const revoke = await f.sessions
      .commandHandler({ streamId: f.streamId, context: f.audit, command: { type: "RevokeSession" } })
      .catch((error: unknown) => error);
    if (revoke instanceof AuthSessionMutationPendingError) {
      expect((await f.sessions.getSessionState(f.sessionId))?.status).toBe("active");
      return;
    }
    // An effective receipt is only safe if every retained executor has lost the terminal.
    await expect(f.consumerStore.appendToStreams!([terminal, ...effects])).rejects.toThrow();
    expect((await f.fence.inspect(operation)).status).toBe("aborted");
    for (const effect of effects)
      expect(await f.consumerStore.readStream({ streamId: effect.streamId })).toHaveLength(0);
  });

  for (const type of [
    "RevokeSession",
    "SwitchSessionAccount",
    "ExpireSession",
    "token-rotation",
    "token-reduction",
  ] as const)
    it(`${type} defeats a retained terminal after effective mutation`, async () => {
      const f = await authFixture();
      const operation = await f.fence.open(f.input, f.context);
      const grants = await f.prepareAuthorities(operation, f.context);
      const append = await f.fence.prepareCommit(operation, grants, { accepted: true });
      if (type === "token-rotation" || type === "token-reduction") {
        await f.sessions.listingAuthority.mutateToken({
          mutationId: "synthetic-token-2",
          sessionId: f.sessionId,
          tokenHash: f.auth.hashSecret("synthetic-secret-2"),
          expiresAt: type === "token-reduction" ? "2098-01-01T00:00:00.000Z" : "2099-01-01T00:00:00.000Z",
          context: f.audit,
        });
        expect((await f.sessions.listingAuthority.readSession(f.sessionId)).revision).toBe("1");
        expect(await f.resolve("synthetic-secret-1")).toBeNull();
        expect((await f.resolve("synthetic-secret-2"))?.authentication.tokenRevision).toBe("synthetic-token-2");
      } else {
        await f.sessions.commandHandler({
          streamId: f.streamId,
          context: f.audit,
          command: type === "SwitchSessionAccount" ? { type, accountId: "acc_synthetic_other" } : { type },
        });
        if (type === "SwitchSessionAccount")
          await f.sessions.commandHandler({
            streamId: f.streamId,
            context: f.audit,
            command: { type, accountId: f.audit.audit.forAccountId },
          });
      }
      expect((await f.fence.inspect(operation)).status).toBe("aborted");
      await expect(f.consumerStore.appendToStreams!([append])).rejects.toThrow();
      const later = await f.fence.open({ ...f.input, requestId: "synthetic-stale-carrier" }, f.context);
      await expect(f.prepareAuthorities(later, f.context)).rejects.toThrow();
    });

  it("retains closure and the same mutation identity across unknown abort and restart", async () => {
    const f = await authFixture();
    const operation = await f.fence.open(f.input, f.context);
    await f.prepareAuthorities(operation, f.context);
    f.setUnknownAbort(true);
    const error = await f.sessions
      .commandHandler({ streamId: f.streamId, context: f.audit, command: { type: "RevokeSession" } })
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AuthSessionMutationPendingError);
    expect((await f.sessions.getSessionState(f.sessionId))?.status).toBe("active");
    const later = await f.fence.open({ ...f.input, requestId: "synthetic-during-closure" }, f.context);
    await expect(f.prepareAuthorities(later, f.context)).rejects.toThrow(/pending invalidation/);
    f.restart();
    f.setUnknownAbort(false);
    await f.sessions.listingAuthority.resumeMutation((error as AuthSessionMutationPendingError).mutationId, f.audit);
    expect((await f.sessions.getSessionState(f.sessionId))?.status).toBe("revoked");
    expect((await f.fence.inspect(operation)).status).toBe("aborted");
  });

  for (const boundary of ["session", "token"] as const)
    it(`natural ${boundary} expiry fences the retained append without a lifecycle event`, async () => {
      const expiry = new Date(Date.now() + 60_000).toISOString();
      const f = await authFixture(boundary === "session" ? { expiresAt: expiry } : { tokenExpiresAt: expiry });
      const operation = await f.fence.open(f.input, f.context);
      const grants = await f.prepareAuthorities(operation, f.context);
      const append = await f.fence.prepareCommit(operation, grants, {});
      vi.spyOn(Date, "now").mockReturnValue(Date.parse(expiry) + 1);
      try {
        await expect(f.consumerStore.appendToStreams!([append])).rejects.toThrow();
        expect((await f.source.inspect(operation))?.status).toBe("reserved");
        expect((await f.sessions.getSessionState(f.sessionId))?.status).toBe("active");
      } finally {
        vi.restoreAllMocks();
      }
    });
});
