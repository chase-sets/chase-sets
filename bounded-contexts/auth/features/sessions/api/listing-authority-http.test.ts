import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { authSessionMutationErrorHandler } from "./listing-authority";
import type { AuthApiEnv } from "../../../api";
import type { AuthServices } from "../../../support/runtime-support/services";
import { registerSessionApiRoutes } from "../../../support/api-support/session-routes";
import { authFixture } from "./listing-authority-test-support";

describe("Auth pending mutation at the host HTTP boundary", () => {
  it("sign-out preserves the pending mutation identity instead of losing it to a generic error", async () => {
    const f = await authFixture();
    const operation = await f.fence.open(f.input, f.context);
    await f.prepareAuthorities(operation, f.context);
    f.setUnknownAbort(true);
    const app = new Hono<AuthApiEnv>();
    app.onError(authSessionMutationErrorHandler);
    app.use("*", async (c, next) => {
      c.set("context", f.audit);
      c.set("actor", {
        tenantId: f.audit.tenantId,
        userId: f.audit.audit.performedByUserId,
        accountId: f.audit.audit.forAccountId,
        sessionId: f.sessionId,
        membershipId: "mbr_synthetic_auth",
        roleKey: "owner",
        permissions: ["security.manage"],
      });
      await next();
    });
    registerSessionApiRoutes(app, { sessions: f.sessions } as AuthServices);
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let response: Response;
    try {
      response = await app.request("/sign-out", { method: "POST" });
    } finally {
      quiet.mockRestore();
    }
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "auth_session_mutation_pending", mutationId: expect.stringMatching(/^session-write-/) },
    });
    expect((await f.sessions.getSessionState(f.sessionId))?.status).toBe("active");
  });
});
