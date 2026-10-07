import { Hono } from "hono";
import { t } from "@chase-sets/localization";
import { parseTypedId } from "@chase-sets/primitives/typed-ids";
import type { SettlementApiEnv } from "../../../api";
import { requireProof, StagingProofCreditError } from "../domain/staging-proof-credit";
import type { StagingProofCreditServices } from "./staging-proof-credit-runtime";

export function createStagingProofCreditRoutes(services: StagingProofCreditServices) {
  const app = new Hono<SettlementApiEnv>();
  app.use("/wallet/staging-proof-credits/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.onError((error, c) =>
    c.json(
      {
        error: {
          code: error instanceof StagingProofCreditError ? error.code : "proof_credit_refused",
          message: t("settlement.features.wallets.api.staging-proof-credit.refused"),
        },
      },
      409,
    ),
  );
  app.post("/wallet/staging-proof-credits", async (c) => {
    requireProof(services.deploymentEnvironment === "staging", "proof_environment_refused");
    const actor = c.get("actor");
    const context = c.get("context");
    if (!actor || !context) return c.json({ error: { code: "authentication_required" } }, 401);
    requireProof(
      c.req.header("X-Chase-Sets-CSRF") === "1" && c.req.header("Sec-Fetch-Site") !== "cross-site",
      "proof_csrf_required",
    );
    requireProof(c.req.header("Content-Type")?.split(";")[0]?.trim() === "application/json", "proof_request_invalid");
    const body: unknown = await c.req.json();
    requireProof(typeof body === "object" && body !== null && !Array.isArray(body), "proof_request_invalid");
    requireProof(
      Object.keys(body).length === 2 && "targetAccountId" in body && "amount" in body,
      "proof_request_invalid",
    );
    requireProof(typeof body.targetAccountId === "string" && typeof body.amount === "string", "proof_request_invalid");
    const targetAccountId = parseTypedId(body.targetAccountId, "acc");
    return c.json({ receipt: await services.post({ targetAccountId, amount: body.amount }, actor, context) });
  });
  app.get("/wallet/staging-proof-credits/:accountId", async (c) => {
    const actor = c.get("actor");
    if (!actor) return c.json({ error: { code: "authentication_required" } }, 401);
    const receipt = await services.receipt(parseTypedId(c.req.param("accountId"), "acc"), actor);
    return c.json({ receipt });
  });
  return app;
}
