import { createHash } from "node:crypto";
import { Hono } from "hono";
import type { ProviderWebhookTelemetry } from "@chase-sets/http/provider-errors";
import type { EbayAccountDeletionConfiguration } from "../domain/configuration";

export type EbayAccountDeletionOptions = Readonly<{
  config: EbayAccountDeletionConfiguration | null;
  telemetry?: ProviderWebhookTelemetry;
}>;

export function createEbayAccountDeletionRoutes({ config, telemetry }: EbayAccountDeletionOptions) {
  const app = new Hono();
  const record = (statusCode: number) =>
    telemetry?.record({
      endpoint: "channels-ebay-account-deletion",
      outcome: statusCode === 200 ? "processed" : "ignored",
      failureClass: statusCode === 400 || statusCode === 405 ? "schema-mismatch" : null,
      statusCode,
      retryable: false,
    });
  // Hono dispatches HEAD through GET routes; the original request method remains authoritative.
  app.use("/ebay/account-deletion", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (c.req.raw.method !== "GET") {
      record(405);
      c.header("Allow", "GET");
      return c.json({ error: { code: "method_not_allowed" } }, 405);
    }
    await next();
  });
  app.get("/ebay/account-deletion", (c) => {
    if (!config) {
      record(503);
      return c.json({ error: { code: "ebay_account_deletion_not_configured" } }, 503);
    }
    const challenges = c.req.queries("challenge_code");
    if (challenges?.length !== 1 || !challenges[0]) {
      record(400);
      return c.json({ error: { code: "ebay_account_deletion_challenge_invalid" } }, 400);
    }
    const challengeResponse = createHash("sha256")
      .update(challenges[0], "utf8")
      .update(config.verificationToken, "utf8")
      .update(config.endpoint, "utf8")
      .digest("hex");
    record(200);
    return c.json({ challengeResponse });
  });
  return app;
}
