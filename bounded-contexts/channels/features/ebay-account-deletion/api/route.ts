import { createHash } from "node:crypto";
import { Hono } from "hono";
import type { ProviderKeyAuthorityOutcome, ProviderWebhookTelemetry } from "@chase-sets/http/provider-errors";
import type { EbayAccountDeletionConfiguration } from "../domain/configuration";
import { parseEbayAccountDeletionPayload } from "../domain/notice";
import type { EbayAccountDeletionServices } from "./runtime";
import {
  createEbayDeletionKeyAuthority,
  EbayDeletionBoundaryError,
  parseEbayDeletionSignature,
  readEbayDeletionBody,
} from "./signature";

export type EbayAccountDeletionOptions = Readonly<{
  config: EbayAccountDeletionConfiguration | null;
  telemetry?: ProviderWebhookTelemetry;
  keyAuthority?: ReturnType<typeof createEbayDeletionKeyAuthority>;
  recordReceipt?: (
    notice: Parameters<EbayAccountDeletionServices["recordEbayAccountDeletionReceipt"]>[1],
  ) => ReturnType<EbayAccountDeletionServices["recordEbayAccountDeletionReceipt"]>;
}>;

export function createEbayAccountDeletionRoutes({
  config,
  telemetry,
  keyAuthority,
  recordReceipt,
}: EbayAccountDeletionOptions) {
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
    if (c.req.raw.method !== "GET" && c.req.raw.method !== "POST") {
      record(405);
      c.header("Allow", "GET, POST");
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
  app.post("/ebay/account-deletion", async (c) => {
    let tokenMint: ProviderKeyAuthorityOutcome = "not-attempted";
    let keyFetch: ProviderKeyAuthorityOutcome = "not-attempted";
    const respond = (status: 200 | 400 | 408 | 409 | 412 | 413 | 415 | 503, code: string) => {
      telemetry?.record({
        endpoint: "channels-ebay-account-deletion",
        statusCode: status,
        outcome: status === 200 ? "processed" : status === 503 ? "failed" : "ignored",
        failureClass:
          status === 200
            ? null
            : status === 412
              ? "signature-invalid"
              : status === 409
                ? "inbox-conflict"
                : status === 503
                  ? "handler-failure"
                  : "schema-mismatch",
        retryable: status === 503,
        tokenMint,
        keyFetch,
      });
      return c.json(status === 200 ? { received: true } : { error: { code } }, status);
    };
    if (!config) return respond(503, "ebay_account_deletion_not_configured");
    if (!keyAuthority || !config.applicationAuthority)
      return respond(503, "ebay_account_deletion_key_authority_unavailable");
    if (!/^application\/json(?:\s*;|$)/i.test(c.req.header("content-type") ?? ""))
      return respond(415, "ebay_account_deletion_media_invalid");
    const signature = parseEbayDeletionSignature(c.req.header("x-ebay-signature"));
    if (!signature) return respond(412, "ebay_account_deletion_signature_invalid");
    let payload: unknown;
    try {
      const bytes = await readEbayDeletionBody(c.req.raw);
      payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch (error) {
      return respond(
        error instanceof EbayDeletionBoundaryError ? error.status : 400,
        "ebay_account_deletion_body_invalid",
      );
    }
    const verification = await keyAuthority.verify(payload, signature);
    tokenMint = verification.tokenMint;
    keyFetch = verification.keyFetch;
    if (verification.status === "unavailable") return respond(503, "ebay_account_deletion_key_authority_unavailable");
    if (verification.status !== "verified") return respond(412, "ebay_account_deletion_signature_invalid");
    let notice;
    try {
      notice = parseEbayAccountDeletionPayload(payload);
    } catch {
      return respond(400, "ebay_account_deletion_payload_invalid");
    }
    try {
      const result = await recordReceipt?.(notice);
      if (result === "recorded" || result === "duplicate") return respond(200, "received");
      if (result === "conflict") return respond(409, "ebay_account_deletion_receipt_conflict");
    } catch {
      /* A failed transaction must never be acknowledged. */
    }
    return respond(503, "ebay_account_deletion_receipt_unavailable");
  });
  return app;
}
