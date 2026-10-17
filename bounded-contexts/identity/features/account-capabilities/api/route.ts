import { Hono } from "hono";
import type { IdentityApiEnv } from "../../../api";
import { CapabilityAdministrationError, parseCapabilityAssignmentInput } from "./administration";
import type { AccountCapabilityRuntime } from "./runtime";

export function accountCapabilityRoutes(runtime: AccountCapabilityRuntime) {
  const app = new Hono<IdentityApiEnv>();
  app.onError((error, c) => {
    const code = error instanceof CapabilityAdministrationError ? error.code : "assignment_unavailable";
    const status =
      code === "invalid_assignment_input"
        ? 400
        : code === "authentication_required"
          ? 401
          : code === "assignment_concurrency_conflict"
            ? 409
            : code.endsWith("unavailable")
              ? 503
              : 403;
    return c.json({ error: { code } }, status);
  });
  for (const action of ["grant", "revoke"] as const) {
    app.post(`/${action}`, async (c) => {
      const input = parseCapabilityAssignmentInput(await c.req.json().catch(() => null));
      return c.json(await runtime.attemptAccountCapabilityAssignment(action, c.var.actor, input, c.var.context));
    });
  }
  return app;
}
