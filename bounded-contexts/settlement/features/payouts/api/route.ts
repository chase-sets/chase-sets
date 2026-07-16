import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import { createDurableJobEventStream } from "@chase-sets/platform-runtime/durable-job-events";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { SettlementApiEnv } from "../../../api";
import { providerWebhookErrorFromUnknown } from "@chase-sets/http/provider-errors";
import { toPayoutReconciliationJobStatus, type PayoutCommandSnapshot, type PayoutServices } from "./runtime";
import type { AccountId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";

function requirePayoutAccess(
  c: {
    get(key: "actor"): SettlementApiEnv["Variables"]["actor"];
  },
  permission: "payouts.view" | "payouts.request" | "payouts.reconcile" | "payouts.manage",
) {
  const actor = c.get("actor");
  if (!actor) {
    return {
      actor: null,
      response: new Response(
        JSON.stringify({
          error: {
            code: "authentication_required",
            message: t("settlement.features.payouts.api.route.authentication.required"),
          },
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      ),
    };
  }

  if (!actor.permissions.includes(permission)) {
    return {
      actor: null,
      response: new Response(
        JSON.stringify({
          error: { code: "authorization_forbidden", message: t("settlement.features.payouts.api.route.forbidden") },
        }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" },
        },
      ),
    };
  }

  return { actor, response: null };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : t("settlement.features.payouts.api.route.request.failed");
}

function validationErrorCode(error: unknown) {
  const message = errorMessage(error);
  return message.includes("Confirm it is you before requesting a payout") ? "step_up_required" : "validation_failed";
}

function validationErrorMessage(error: unknown) {
  return validationErrorCode(error) === "step_up_required"
    ? t("settlement.features.payouts.api.route.step.up.required")
    : errorMessage(error);
}

function providerWebhookFailureResponse(c: { json: (body: unknown, status?: number) => Response }, error: unknown) {
  const classified = providerWebhookErrorFromUnknown(error);
  const ignored =
    classified.failureClass === "unknown-event" ||
    classified.failureClass === "schema-mismatch" ||
    classified.failureClass === "inbox-conflict";
  if (ignored) {
    return c.json(
      {
        received: true,
        ignored: true,
        failure_class: classified.failureClass,
      },
      200,
    );
  }

  return c.json(
    {
      error: {
        code: `provider_webhook_${classified.failureClass.replaceAll("-", "_")}`,
        message:
          classified.failureClass === "handler-failure" ? "Provider webhook handler failed." : classified.message,
        failure_class: classified.failureClass,
        retryable: classified.retryable,
      },
    },
    400,
  );
}

function sellerPayoutSnapshot(payout: PayoutCommandSnapshot): PayoutCommandSnapshot {
  return {
    ...payout,
    provider_failure_code: null,
    provider_failure_message: null,
  };
}

export function createPayoutRoutes(services: PayoutServices) {
  const app = new Hono<SettlementApiEnv>();

  app.get("/payouts", async (c) => {
    const access = requirePayoutAccess(c, "payouts.view");
    if (access.response) {
      return access.response;
    }

    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);
    const result = await services.listPayouts({
      accountId: access.actor.accountId,
      limit,
      offset,
    });

    return c.json({
      items: result.items,
      total: result.total,
      count: result.items.length,
    });
  });

  app.get("/payouts/reconciliation", async (c) => {
    const access = requirePayoutAccess(c, "payouts.reconcile");
    if (access.response) {
      return access.response;
    }

    const limit = Number(c.req.query("limit") ?? 100);
    const filter = c.req.query("filter") ?? null;
    const items = await services.listPayoutsNeedingReconciliation({ accountId: access.actor.accountId, limit, filter });

    return c.json({
      items,
      total: items.length,
      count: items.length,
    });
  });

  app.get("/payouts/reconciliation/runs", async (c) => {
    const access = requirePayoutAccess(c, "payouts.reconcile");
    if (access.response) {
      return access.response;
    }

    const items = await services.listReconciliationRuns({
      limit: Number(c.req.query("limit") ?? 25),
    });

    return c.json({ items, total: items.length, count: items.length });
  });

  app.get("/payouts/provider-idempotency", async (c) => {
    const access = requirePayoutAccess(c, "payouts.reconcile");
    if (access.response) {
      return access.response;
    }

    const items = await services.listProviderIdempotencyKeys({
      accountId: access.actor.accountId,
      limit: Number(c.req.query("limit") ?? 25),
    });

    return c.json({ items, total: items.length, count: items.length });
  });

  app.get("/payouts/platform-balance-forecast", async (c) => {
    const access = requirePayoutAccess(c, "payouts.reconcile");
    if (access.response) {
      return access.response;
    }

    return c.json(await services.getPlatformBalanceForecast({ currencyCode: "usd" }));
  });

  app.post("/payouts/preview", async (c) => {
    const access = requirePayoutAccess(c, "payouts.request");
    if (access.response) {
      return access.response;
    }

    const body = await c.req.json();
    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("settlement.features.payouts.api.route.authentication.context.missing"),
          },
        },
        401,
      );
    }

    try {
      return c.json(
        await services.previewPayoutRequest(
          {
            accountId: access.actor.accountId as AccountId,
            amount: String(body.amount ?? ""),
          },
          context,
        ),
      );
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.get("/money-health", async (c) => {
    const access = requirePayoutAccess(c, "payouts.reconcile");
    if (access.response) {
      return access.response;
    }

    const [payouts, reconciliationRuns, platformBalanceForecast, providerHealth, negativeBalanceAccounts] =
      await Promise.all([
        services.listPayoutsNeedingReconciliation({ accountId: access.actor.accountId, limit: 25 }),
        services.listReconciliationRuns({ limit: 10 }),
        services.getPlatformBalanceForecast({ currencyCode: "usd" }),
        services.getProviderHealth(),
        services.listNegativeBalanceAccounts({ limit: 25 }),
      ]);

    return c.json({
      payouts_needing_attention: payouts,
      reconciliation_runs: reconciliationRuns,
      platform_balance_forecast: platformBalanceForecast,
      provider_health: providerHealth,
      negative_balance_accounts: negativeBalanceAccounts.items,
      negative_balance_total: negativeBalanceAccounts.total,
    });
  });

  app.get("/provider-health", async (c) => {
    const access = requirePayoutAccess(c, "payouts.reconcile");
    if (access.response) {
      return access.response;
    }

    return c.json(await services.getProviderHealth());
  });

  app.post("/payouts/reconciliation/run", async (c) => {
    const access = requirePayoutAccess(c, "payouts.reconcile");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("settlement.features.payouts.api.route.authentication.context.missing"),
          },
        },
        401,
      );
    }

    const body = await c.req.json().catch(() => ({}));
    const limit = Number((body as { limit?: unknown }).limit ?? 100);
    const result = await services.enqueuePayoutReconciliationJob({ limit }, context);

    return c.json(toPayoutReconciliationJobStatus(result), 202);
  });

  app.get("/payouts/reconciliation/jobs/:jobId", async (c) => {
    const access = requirePayoutAccess(c, "payouts.reconcile");
    if (access.response) {
      return access.response;
    }

    const job = await services.getPayoutReconciliationJob(c.req.param("jobId"));
    if (!job || job.payload.accountId !== access.actor.accountId) {
      return c.json(
        { error: { code: "not_found", message: t("settlement.features.payouts.api.route.job.not.found") } },
        404,
      );
    }

    return c.json(toPayoutReconciliationJobStatus(job));
  });

  app.get("/payouts/reconciliation/jobs/:jobId/events", async (c) => {
    const access = requirePayoutAccess(c, "payouts.reconcile");
    if (access.response) {
      return access.response;
    }

    const jobId = c.req.param("jobId");
    const job = await services.getPayoutReconciliationJob(jobId);
    if (!job || job.payload.accountId !== access.actor.accountId) {
      return c.json(
        { error: { code: "not_found", message: t("settlement.features.payouts.api.route.job.not.found") } },
        404,
      );
    }

    return createDurableJobEventStream({
      request: c.req.raw,
      signal: c.req.raw.signal,
      streamLimitKey: `account:${access.actor.accountId}`,
      loadEvents: async (afterSequence) =>
        (await services.listPayoutReconciliationJobEvents(jobId, afterSequence)).map((event) => ({
          sequence: event.sequence,
          eventName: event.eventName,
          data: event.job,
        })),
      loadCurrentSnapshot: async () => {
        const current = await services.getPayoutReconciliationJob(jobId);
        return current?.payload.accountId === access.actor.accountId ? toPayoutReconciliationJobStatus(current) : null;
      },
      waitForEvents: (_afterSequence, signal) => services.waitForPayoutReconciliationJobEvents(jobId, signal),
      isTerminal: (event) => event.data.status === "completed" || event.data.status === "failed",
      isTerminalSnapshot: (snapshot) => snapshot.status === "completed" || snapshot.status === "failed",
    });
  });

  app.get("/payouts/:id", async (c) => {
    const access = requirePayoutAccess(c, "payouts.view");
    if (access.response) {
      return access.response;
    }

    const payout = await services.getPayout(c.req.param("id"), access.actor.accountId);
    if (!payout) {
      return c.json(
        { error: { code: "not_found", message: t("settlement.features.payouts.api.route.payout.not.found") } },
        404,
      );
    }

    return c.json(payout);
  });

  app.get("/payouts/:id/timeline", async (c) => {
    const access = requirePayoutAccess(c, "payouts.view");
    if (access.response) {
      return access.response;
    }

    try {
      return c.json(
        await services.getPayoutMoneyTimeline({
          payoutId: c.req.param("id"),
          accountId: access.actor.accountId,
        }),
      );
    } catch (error) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: errorMessage(error),
          },
        },
        404,
      );
    }
  });

  app.post("/payouts", async (c) => {
    const access = requirePayoutAccess(c, "payouts.request");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("settlement.features.payouts.api.route.authentication.context.missing.2"),
          },
        },
        401,
      );
    }

    const body = await c.req.json();
    const idempotencyKey = c.req.header("Idempotency-Key") ?? null;

    try {
      const request = {
        accountId: access.actor.accountId as AccountId,
        amount: String(body.amount ?? ""),
        destinationReference: typeof body.destinationReference === "string" ? body.destinationReference : null,
        note: typeof body.note === "string" ? body.note : null,
        actorUserId: access.actor.userId,
        sensitiveActionToken: typeof body.sensitiveActionToken === "string" ? body.sensitiveActionToken : null,
        ...(typeof body.notificationEmail === "string" ? { notificationEmail: body.notificationEmail } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      };
      const result = await services.requestPayout(request, context);

      return c.json(
        {
          id: result.payoutId,
          version: result.version,
          status: result.payout.status,
          payout: sellerPayoutSnapshot(result.payout),
        },
        201,
      );
    } catch (error) {
      return c.json({ error: { code: validationErrorCode(error), message: validationErrorMessage(error) } }, 400);
    }
  });

  return app;
}

export function createMoneyMovementWebhookRoutes(services: PayoutServices) {
  const app = new Hono();

  app.post("/money-movement/webhooks", async (c) => {
    try {
      const rawBody = await c.req.raw.text();
      const signatureHeader = c.req.header("Stripe-Signature") ?? null;
      const result = await services.processMoneyMovementWebhook(
        {
          rawBody,
          signatureHeader,
        },
        {
          tenantId: "tnt_identity" as TenantId,
          audit: {
            performedByUserId: "usr_identity_system" as UserId,
            forAccountId: "acc_identity_system" as AccountId,
          },
        } as EventStoreContext,
      );

      return c.json(result, 200);
    } catch (error) {
      return providerWebhookFailureResponse(c, error);
    }
  });

  return app;
}
