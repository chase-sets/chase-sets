import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { catalogApiPermissionMiddleware } from "../../server";

it("catalog api permission middleware enforces view for GET/HEAD/OPTIONS and manage for mutations", async () => {
  const methods = ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE", "PURGE"];
  for (const method of methods) {
    const read = ["GET", "HEAD", "OPTIONS"].includes(method);
    for (const permissions of [null, [], ["catalog.view"], ["catalog.manage"], ["catalog.view", "catalog.manage"]]) {
      const actor: ResolvedActor | null = permissions && {
        sessionId: "sess_test",
        tenantId: "tenant_test",
        userId: "user_test",
        accountId: "acc_test",
        membershipId: "member_test",
        roleKey: "platform-user",
        permissions,
      };
      const app = new Hono<{ Variables: { actor: ResolvedActor | null } }>();
      app.use("*", async (c, next) => {
        c.set("actor", actor);
        await next();
      });
      app.use("*", catalogApiPermissionMiddleware);
      const next = vi.fn();
      app.all("/", (c) => {
        next();
        return c.json({ reached: true });
      });

      const response = await app.request("/", { method });
      const allowed = permissions?.includes(read ? "catalog.view" : "catalog.manage") ?? false;
      expect(response.status, `${method} ${JSON.stringify(permissions)}`).toBe(!actor ? 401 : allowed ? 200 : 403);
      expect(next).toHaveBeenCalledTimes(allowed ? 1 : 0);
      if (method !== "HEAD") {
        await expect(response.json()).resolves.toEqual(
          !actor
            ? { error: { code: "authentication_required", message: "Authentication required." } }
            : allowed
              ? { reached: true }
              : { error: { code: "authorization_forbidden", message: "Forbidden." } },
        );
      }
    }
  }
});
