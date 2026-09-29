import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { authFixture } from "./listing-authority-test-support";
import { AuthSessionMutationPendingError } from "./listing-authority";
import { sessionRoutes } from "./route";
import { revokeSession, type AuthServices } from "../../../support/runtime-support/services";
import type { AuthApiEnv } from "../../../api";
import { authRetentionExemptions, authRetentionSweeps } from "../../../support/runtime-support/retention-policy";

describe("actual Auth recovery and writer boundary", () => {
  it("reconciles a lost abort reply before reporting effective revoke", async () => {
    const f = await authFixture();
    const operation = await f.fence.open(f.input, f.context);
    const grants = await f.prepareAuthorities(operation, f.context);
    const terminal = await f.fence.prepareCommit(operation, grants, {});
    f.loseAbortReply();
    const pending = await f.invalidate().catch((error: unknown) => error);
    expect(pending).toBeInstanceOf(AuthSessionMutationPendingError);
    expect((await f.fence.inspect(operation)).status).toBe("aborted");
    expect((await f.sessions.getSessionState(f.sessionId))?.status).toBe("active");
    f.restart();
    await f.sessions.listingAuthority.resumeMutation((pending as AuthSessionMutationPendingError).mutationId, f.audit);
    expect((await f.sessions.getSessionState(f.sessionId))?.status).toBe("revoked");
    await expect(f.consumerStore.appendToStreams!(terminal)).rejects.toThrow();
  });
  it("retains token closure after a lost persistence reply and cannot rotate twice on delayed replay", async () => {
    const f = await authFixture();
    const operation = await f.fence.open(f.input, f.context);
    const grants = await f.prepareAuthorities(operation, f.context);
    const terminal = await f.fence.prepareCommit(operation, grants, {});
    const apply = f.tokens.apply;
    const fault = vi.spyOn(f.tokens, "apply").mockImplementationOnce(async (id) => {
      await apply(id);
      throw new Error("Synthetic crash after SQL success, before reopening");
    });
    const mutation = {
      mutationId: "synthetic-lost-token-reply",
      sessionId: f.sessionId,
      tokenHash: f.auth.hashSecret("synthetic-new-secret"),
      expiresAt: "2099-01-01T00:00:00.000Z",
      context: f.audit,
    };
    await expect(f.sessions.listingAuthority.mutateToken(mutation)).rejects.toMatchObject({
      mutationId: mutation.mutationId,
    });
    expect((await f.tokens.read(f.sessionId))?.token_revision).toBe(mutation.mutationId);
    await expect(f.consumerStore.appendToStreams!(terminal)).rejects.toThrow();
    const evidence = await f.resolve("synthetic-new-secret");
    const context = {
      ...f.context,
      listingAuthorityPrincipal: { ...f.context.listingAuthorityPrincipal!, authentication: evidence!.authentication },
    };
    const next = await f.fence.open({ ...f.input, requestId: "synthetic-during-token-closure" }, context);
    await expect(f.sessions.listingAuthority.port.prepare(next, context)).rejects.toThrow(/pending invalidation/);
    fault.mockRestore();
    f.restart();
    await f.sessions.listingAuthority.resumeToken(mutation.mutationId);
    await f.sessions.listingAuthority.mutateToken({
      ...mutation,
      mutationId: "synthetic-next-token",
      tokenHash: f.auth.hashSecret("synthetic-next-secret"),
    });
    await f.sessions.listingAuthority.resumeToken(mutation.mutationId);
    expect((await f.tokens.read(f.sessionId))?.token_revision).toBe("synthetic-next-token");
    expect((await f.sessions.listingAuthority.readSession(f.sessionId)).revision).toBe("1");
  });

  it("advances the SQL recovery cursor beyond an unavailable mutation", async () => {
    const f = await authFixture();
    const operation = await f.fence.open(f.input, f.context);
    await f.prepareAuthorities(operation, f.context);
    f.setUnknownAbort(true);
    const pending = {
      mutationId: "a-pending",
      sessionId: f.sessionId,
      tokenHash: "synthetic-hash-a",
      expiresAt: "2099-01-01T00:00:00.000Z",
      context: f.audit,
    };
    await expect(f.sessions.listingAuthority.mutateToken(pending)).rejects.toBeInstanceOf(
      AuthSessionMutationPendingError,
    );
    await f.tokens.stage({
      ...pending,
      mutationId: "z-independent",
      sessionId: "ses_synthetic_independent",
      tokenHash: "synthetic-hash-z",
    });
    const first = await f.sessions.listingAuthority.recoverPage({ limit: 1 });
    expect(first.tokenAfter).toBe("a-pending");
    expect(first.outcomes).toContainEqual(expect.objectContaining({ identity: "a-pending", status: "pending" }));
    const second = await f.sessions.listingAuthority.recoverPage({ ...first, limit: 1 });
    expect(second.outcomes).toContainEqual({ identity: "z-independent", status: "recovered" });
    expect((await f.tokens.read("ses_synthetic_independent"))?.token_revision).toBe("z-independent");
  });

  for (const path of ["internal-revoke", "route-revoke", "route-switch", "direct-bulk"] as const)
    it(`${path} preserves pending identity and never reports effective success before abort`, async () => {
      const f = await authFixture();
      const operation = await f.fence.open(f.input, f.context);
      await f.prepareAuthorities(operation, f.context);
      f.setUnknownAbort(true);
      let mutationId: string;
      if (path.startsWith("route-")) {
        const app = new Hono<AuthApiEnv>();
        app.use("*", async (c, next) => {
          c.set("context", f.audit);
          await next();
        });
        app.route(
          "/sessions",
          sessionRoutes({
            ...f.sessions,
            getSession: async () => ({ session_id: f.sessionId, user_id: f.audit.audit.performedByUserId }) as never,
          }),
        );
        const reply = await app.request(
          `/sessions/${f.sessionId}/${path === "route-switch" ? "switch-account" : "revoke"}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ accountId: "acc_synthetic_other" }),
          },
        );
        expect(reply.status).toBe(503);
        const result = await reply.json();
        expect(result.error.code).toBe("auth_session_mutation_pending");
        mutationId = result.error.mutationId;
      } else {
        const result = await (
          path === "internal-revoke"
            ? revokeSession({ sessions: f.sessions } as AuthServices, { sessionId: f.sessionId, context: f.audit })
            : f.sessions.listingAuthority.eventStore.appendToStreams!([
                {
                  streamId: f.streamId,
                  expectedVersion: 1,
                  context: f.audit,
                  events: [{ eventType: "auth.session.revoked", payload: { sessionId: f.sessionId } }],
                },
              ])
        ).catch((error: unknown) => error);
        expect(result).toBeInstanceOf(AuthSessionMutationPendingError);
        mutationId = (result as AuthSessionMutationPendingError).mutationId;
      }
      expect(mutationId!).toMatch(/^session-write-/);
      expect((await f.sessions.getSessionState(f.sessionId))?.status).toBe("active");
      f.restart();
      f.setUnknownAbort(false);
      await f.sessions.listingAuthority.resumeMutation(mutationId!, f.audit);
      expect((await f.fence.inspect(operation)).status).toBe("aborted");
      const state = await f.sessions.getSessionState(f.sessionId);
      expect(path === "route-switch" ? state?.accountId : state?.status).toBe(
        path === "route-switch" ? "acc_synthetic_other" : "revoked",
      );
    });

  it("natural expiry retains then recovers the terminal, without retention deleting credentials", async () => {
    const expiry = new Date(Date.now() + 60_000).toISOString();
    const f = await authFixture({ tokenExpiresAt: expiry });
    const operation = await f.fence.open(f.input, f.context);
    await f.prepareAuthorities(operation, f.context);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(expiry) + 1);
    try {
      expect((await f.source.inspect(operation))?.status).toBe("reserved");
      await f.sessions.listingAuthority.recoverPage({ limit: 100 });
      expect((await f.fence.inspect(operation)).status).toBe("aborted");
      expect((await f.source.inspect(operation))?.status).toBe("released");
      expect(await f.tokens.read(f.sessionId)).not.toBeNull();
    } finally {
      clock.mockRestore();
    }
    expect(authRetentionSweeps.some((sweep) => sweep.tableName === "identity_session_tokens")).toBe(false);
    expect(authRetentionExemptions.some((exemption) => exemption.tableName === "identity_session_tokens")).toBe(true);
  });
});
