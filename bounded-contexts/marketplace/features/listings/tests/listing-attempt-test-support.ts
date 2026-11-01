import type { Env, Hono } from "hono";

/**
 * Route fixtures that predate the Listing attempt carrier send each command once with a fresh attempt, exactly
 * as a browser form does. Attempt semantics (missing key, replay, conflict) are proved by the dedicated
 * listing-attempt tests, never through this helper.
 */
export function sendListingCommandsWithFreshAttempts<E extends Env>(app: Hono<E>): Hono<E> {
  app.use("*", async (c, next) => {
    if (c.req.method !== "GET" && !c.req.raw.headers.has("Idempotency-Key"))
      c.req.raw.headers.set("Idempotency-Key", `test_attempt_${crypto.randomUUID()}`);
    await next();
  });
  return app;
}
