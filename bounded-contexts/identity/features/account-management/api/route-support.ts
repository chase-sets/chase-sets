import type { Context } from "hono";
import type { IdentityApiEnv } from "../../../api";
import { parseAttemptKey, type MutationAction } from "../domain/contract";
import type { AccountManagementServices } from "./runtime";
import { SHIPPING_ADDRESS_REQUIRED_MESSAGES } from "../../shipping-addresses/domain/errors";
import { t } from "@chase-sets/localization";

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
    if (
      (action === "create" || action === "update") &&
      result.outcome === "not-recorded" &&
      result.code === "validation-failed" &&
      typeof result.shippingAddressField === "string" &&
      Object.hasOwn(SHIPPING_ADDRESS_REQUIRED_MESSAGES, result.shippingAddressField)
    ) {
      const field = result.shippingAddressField as keyof typeof SHIPPING_ADDRESS_REQUIRED_MESSAGES;
      const message = t(SHIPPING_ADDRESS_REQUIRED_MESSAGES[field]);
      c.header("Cache-Control", "no-store");
      return c.json(
        { error: { code: "validation_failed", message, details: [{ field, code: "required", message }] } },
        400,
      );
    }
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
