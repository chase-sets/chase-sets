import type { Context } from "hono";
import type { IdentityApiEnv } from "../../../api";
import { parseAttemptKey, type MutationAction } from "../domain/contract";
import type { AccountManagementServices } from "./runtime";

export async function submitAccountManagement(
  c: Context<IdentityApiEnv>,
  service: AccountManagementServices | undefined,
  action: MutationAction,
  target: string | null,
  body: unknown,
) {
  const key = c.req.header("Idempotency-Key");
  if (key === undefined) return null;
  try {
    parseAttemptKey(key);
  } catch {
    return c.json({ outcome: "not-recorded", code: "interruption-safe-client-required" }, 400);
  }
  if (!c.var.actor || !c.var.context) return c.json({ error: { code: "authentication_required" } }, 401);
  if (!service) return c.json({ outcome: "indeterminate", code: "INDETERMINATE" }, 503);
  try {
    const result = await service.submit({ actor: c.var.actor, context: c.var.context, key, action, target, body });
    c.header("Cache-Control", "no-store");
    return c.json(
      result,
      result.outcome === "committed"
        ? 200
        : result.outcome === "conflict"
          ? 409
          : result.outcome === "not-recorded"
            ? 400
            : 503,
    );
  } catch (error) {
    if (error instanceof Error && error.message === "authorization_forbidden")
      return c.json({ outcome: "not-recorded", code: "authorization_forbidden" }, 403);
    return c.json({ outcome: "indeterminate", code: "INDETERMINATE" }, 503);
  }
}
