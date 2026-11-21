import { Hono } from "hono";
import { parseStrictTypedUlid } from "@chase-sets/primitives/typed-ids";
import type { IdentityApiEnv } from "../../../api";
import { parseAccountProfileReportSubmission } from "../domain/submission";
import { AccountProfileReportAttemptConflict, type SubmitAccountProfileReport } from "./runtime";

export function accountProfileReportRoutes(submit: SubmitAccountProfileReport) {
  const app = new Hono<IdentityApiEnv>();
  return app.post("/:accountId/profile-reports", async (c) => {
    c.header("Cache-Control", "no-store");
    const { actor, context } = c.var;
    if (!actor || !context) return c.json({ error: { code: "authentication_required" } }, 401);
    if (
      actor.tenantId !== context.tenantId ||
      actor.accountId !== context.audit.forAccountId ||
      actor.userId !== context.audit.performedByUserId
    )
      return c.json({ error: { code: "authentication_required" } }, 401);
    const body = parseAccountProfileReportSubmission(await c.req.json().catch(() => null));
    if (!body) return c.json({ error: { code: "invalid_profile_report" } }, 400);
    try {
      return c.json(
        await submit(
          {
            ...body,
            target: c.req.param("accountId"),
            reporterAccountId: parseStrictTypedUlid(actor.accountId, "acc"),
          },
          context,
        ),
        202,
      );
    } catch (error) {
      // Storage and parser exceptions may carry private report data.
      if (error instanceof AccountProfileReportAttemptConflict)
        return c.json({ error: { code: "attempt_conflict" } }, 409);
      return c.json({ error: { code: "profile_report_unavailable" } }, 503);
    }
  });
}
