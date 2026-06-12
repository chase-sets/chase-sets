import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { OrderingApiEnv } from "../../../api";
import { mapPostagePolicyDomainError, type OrderingPostagePolicyPayload } from "../domain/domain";
import type { PostagePolicyPreviewRequest, PostagePolicyServices } from "./runtime";

type PostagePolicyPermission = "postage-policies.view" | "postage-policies.manage";

function requireAccess(
  c: { get(key: "actor"): OrderingApiEnv["Variables"]["actor"] },
  permission: PostagePolicyPermission,
) {
  const actor = c.get("actor");
  if (!actor) {
    return {
      actor: null,
      response: new Response(
        JSON.stringify({
          error: {
            code: "authentication_required",
            message: t("ordering.features.postagePolicies.api.route.authentication.required"),
          },
        }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      ),
    };
  }

  if (!actor.permissions.includes(permission)) {
    return {
      actor: null,
      response: new Response(
        JSON.stringify({
          error: {
            code: "authorization_forbidden",
            message: t("ordering.features.postagePolicies.api.route.forbidden"),
          },
        }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      ),
    };
  }

  return { actor, response: null };
}

function readArray(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry));
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function readNullableNumber(value: unknown) {
  if (value == null || value === "") {
    return null;
  }
  return Number(value);
}

function policyPayload(body: Record<string, unknown>): Partial<OrderingPostagePolicyPayload> {
  return {
    policyVersion: String(body.policyVersion ?? ""),
    maxLetterUnits: Number(body.maxLetterUnits ?? 0),
    maxLetterWeightOunces: Number(body.maxLetterWeightOunces ?? 0),
    maxLetterThicknessInches: Number(body.maxLetterThicknessInches ?? 0),
    maxLetterDeclaredValueAmount: Number(body.maxLetterDeclaredValueAmount ?? 0),
    letterEnvelopeWeightOunces: Number(body.letterEnvelopeWeightOunces ?? 0),
    parcelPackagingWeightOunces: Number(body.parcelPackagingWeightOunces ?? 0),
    parcelRequiredShippingOptions: readArray(
      body.parcelRequiredShippingOptions,
    ) as OrderingPostagePolicyPayload["parcelRequiredShippingOptions"],
    letterRequiredPhysicalFlags: readArray(
      body.letterRequiredPhysicalFlags,
    ) as OrderingPostagePolicyPayload["letterRequiredPhysicalFlags"],
    parcelRequiredPhysicalFlags: readArray(
      body.parcelRequiredPhysicalFlags,
    ) as OrderingPostagePolicyPayload["parcelRequiredPhysicalFlags"],
    signatureRequiredShippingOptions: readArray(
      body.signatureRequiredShippingOptions,
    ) as OrderingPostagePolicyPayload["signatureRequiredShippingOptions"],
    signatureRequiredDeclaredValueAmount: readNullableNumber(body.signatureRequiredDeclaredValueAmount),
    signatureRequiredPhysicalFlags: readArray(
      body.signatureRequiredPhysicalFlags,
    ) as OrderingPostagePolicyPayload["signatureRequiredPhysicalFlags"],
  };
}

function policyCommandBody(body: Record<string, unknown>) {
  return {
    label: String(body.label ?? ""),
    payload: policyPayload(body),
    effectiveFrom: typeof body.effectiveFrom === "string" ? body.effectiveFrom : new Date().toISOString(),
    effectiveUntil:
      typeof body.effectiveUntil === "string" && body.effectiveUntil.trim().length > 0 ? body.effectiveUntil : null,
  };
}

function previewBody(body: Record<string, unknown>) {
  const policySource =
    typeof body.policy === "object" && body.policy !== null ? (body.policy as Record<string, unknown>) : body;
  return {
    policy: policyPayload(policySource),
    shippingOption: String(body.shippingOption ?? "standard") as PostagePolicyPreviewRequest["shippingOption"],
    itemSubtotalAmount: String(body.itemSubtotalAmount ?? "0"),
    quantity: Number(body.quantity ?? 1),
    unitLengthInches: Number(body.unitLengthInches ?? 3.5),
    unitWidthInches: Number(body.unitWidthInches ?? 2.5),
    unitHeightInches: Number(body.unitHeightInches ?? 0.016),
    unitWeightOunces: Number(body.unitWeightOunces ?? 0.05),
    physicalFlags:
      readArray(body.physicalFlags).length > 0
        ? (readArray(body.physicalFlags) as PostagePolicyPreviewRequest["physicalFlags"])
        : (["raw-card"] as PostagePolicyPreviewRequest["physicalFlags"]),
  };
}

export function createPostagePolicyRoutes(services: PostagePolicyServices) {
  const app = new Hono<OrderingApiEnv>();

  app.get("/", async (c) => {
    const access = requireAccess(c, "postage-policies.view");
    if (access.response) {
      return access.response;
    }

    const result = await services.listPolicies({
      limit: Number(c.req.query("limit") ?? 50),
      offset: Number(c.req.query("offset") ?? 0),
    });

    return c.json({
      items: result.items,
      total: result.total,
      count: result.items.length,
    });
  });

  app.get("/active", async (c) => {
    const access = requireAccess(c, "postage-policies.view");
    if (access.response) {
      return access.response;
    }

    return c.json({ payload: await services.getActivePolicy(c.req.query("effectiveAt")) });
  });

  app.post("/preview", async (c) => {
    const access = requireAccess(c, "postage-policies.manage");
    if (access.response) {
      return access.response;
    }

    const body = await c.req.json();
    try {
      return c.json({ packagePlan: services.previewPolicy(previewBody(body)) });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: mapPostagePolicyDomainError(error) } }, 400);
    }
  });

  app.get("/:id", async (c) => {
    const access = requireAccess(c, "postage-policies.view");
    if (access.response) {
      return access.response;
    }

    const policy = await services.getPolicy(c.req.param("id"));
    if (!policy) {
      return c.json(
        { error: { code: "not_found", message: t("ordering.features.postagePolicies.api.route.policy.not.found") } },
        404,
      );
    }

    return c.json(policy);
  });

  app.post("/", async (c) => {
    const access = requireAccess(c, "postage-policies.manage");
    if (access.response) {
      return access.response;
    }
    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("ordering.features.postagePolicies.api.route.authentication.context.missing"),
          },
        },
        401,
      );
    }

    const body = await c.req.json();
    try {
      const result = await services.createPolicy(
        {
          ...policyCommandBody(body),
          createdByUserId: access.actor.userId,
        },
        context,
      );
      return c.json({ id: result.policyId, version: result.version }, 201);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: mapPostagePolicyDomainError(error) } }, 400);
    }
  });

  app.put("/:id", async (c) => {
    const access = requireAccess(c, "postage-policies.manage");
    if (access.response) {
      return access.response;
    }
    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("ordering.features.postagePolicies.api.route.authentication.context.missing"),
          },
        },
        401,
      );
    }

    const body = await c.req.json();
    try {
      const result = await services.revisePolicy(
        c.req.param("id"),
        {
          ...policyCommandBody(body),
          revisedByUserId: access.actor.userId,
        },
        context,
      );
      return c.json({ id: result.policyId, version: result.version });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: mapPostagePolicyDomainError(error) } }, 400);
    }
  });

  app.post("/:id/activate", async (c) => {
    const access = requireAccess(c, "postage-policies.manage");
    if (access.response) {
      return access.response;
    }
    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("ordering.features.postagePolicies.api.route.authentication.context.missing"),
          },
        },
        401,
      );
    }

    const body = await c.req.json().catch(() => ({}));
    try {
      const result = await services.activatePolicy(
        c.req.param("id"),
        {
          activatedByUserId: access.actor.userId,
          activationReason: String(body.activationReason ?? "Admin activated postage policy."),
        },
        context,
      );
      return c.json({ id: result.policyId, version: result.version });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: mapPostagePolicyDomainError(error) } }, 400);
    }
  });

  app.post("/:id/clone", async (c) => {
    const access = requireAccess(c, "postage-policies.manage");
    if (access.response) {
      return access.response;
    }
    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("ordering.features.postagePolicies.api.route.authentication.context.missing"),
          },
        },
        401,
      );
    }

    const body = await c.req.json().catch(() => ({}));
    try {
      const result = await services.clonePolicy(
        c.req.param("id"),
        {
          label: String(body.label ?? "Rollback postage policy draft"),
          effectiveFrom: String(body.effectiveFrom ?? new Date().toISOString()),
          effectiveUntil:
            typeof body.effectiveUntil === "string" && body.effectiveUntil.trim().length > 0
              ? body.effectiveUntil
              : null,
          createdByUserId: access.actor.userId,
        },
        context,
      );
      return c.json({ id: result.policyId, version: result.version }, 201);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: mapPostagePolicyDomainError(error) } }, 400);
    }
  });

  app.post("/:id/retire", async (c) => {
    const access = requireAccess(c, "postage-policies.manage");
    if (access.response) {
      return access.response;
    }
    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("ordering.features.postagePolicies.api.route.authentication.context.missing"),
          },
        },
        401,
      );
    }

    const body = await c.req.json().catch(() => ({}));
    try {
      const result = await services.retirePolicy(
        c.req.param("id"),
        {
          retiredByUserId: access.actor.userId,
          retirementReason: String(body.retirementReason ?? "Admin retired postage policy."),
        },
        context,
      );
      return c.json({ id: result.policyId, version: result.version });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: mapPostagePolicyDomainError(error) } }, 400);
    }
  });

  return app;
}
