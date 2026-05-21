import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import { createId, type AccountId, type ShippingAddressId } from "@chase-sets/primitives/typed-ids";
import type { IdentityApiEnv } from "../../../api";
import { hasPermission } from "../../../support/request-support/permissions";
import type { ShippingAddressServices } from "./runtime";
import type { ShippingAddressSnapshot } from "../domain/domain";

type AddressBody = Readonly<{
  label?: unknown;
  name?: unknown;
  recipientName?: unknown;
  company?: unknown;
  line1?: unknown;
  line2?: unknown;
  city?: unknown;
  state?: unknown;
  postalCode?: unknown;
  postal_code?: unknown;
  country?: unknown;
  phone?: unknown;
  email?: unknown;
  makeDefault?: unknown;
}>;

function optionalText(value: unknown) {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function requiredText(value: unknown) {
  return String(value ?? "").trim();
}

function addressFromBody(body: AddressBody): ShippingAddressSnapshot {
  return {
    name: requiredText(body.name ?? body.recipientName),
    company: optionalText(body.company),
    line1: requiredText(body.line1),
    line2: optionalText(body.line2),
    city: requiredText(body.city),
    state: requiredText(body.state),
    postalCode: requiredText(body.postalCode ?? body.postal_code),
    country: requiredText(body.country || "US"),
    phone: optionalText(body.phone),
    email: optionalText(body.email),
  };
}

function isTrue(value: unknown) {
  return value === true || value === "true";
}

function canAccessAccount(actor: IdentityApiEnv["Variables"]["actor"], accountId: string, write: boolean) {
  if (!actor) {
    return false;
  }
  if (hasPermission(actor, "accounts.manage")) {
    return true;
  }
  return !write && actor.accountId === accountId && hasPermission(actor, "accounts.view");
}

function forbidden() {
  return {
    error: {
      code: "authorization_forbidden",
      message: t("identity.features.shippingAddresses.api.route.forbidden"),
    },
  };
}

function accountIdParam(c: { req: { param(name: string): string | undefined } }) {
  return String(c.req.param("accountId") ?? "");
}

async function drainShippingAddressProjectors(services: ShippingAddressServices) {
  let processed = 0;
  do {
    processed = 0;
    for (const projector of services.projectors) {
      const result = await projector.runOnce();
      processed += result.processed;
    }
  } while (processed > 0);
}

export function shippingAddressRoutes(services: ShippingAddressServices) {
  const app = new Hono<IdentityApiEnv>();

  app.get("/", async (c) => {
    const accountId = accountIdParam(c);
    if (!canAccessAccount(c.var.actor, accountId, false)) {
      return c.json(forbidden(), 403);
    }
    const includeArchived = c.req.query("includeArchived") === "true";
    const items = await services.listShippingAddresses(accountId, { includeArchived });
    return c.json({ items, total: items.length, count: items.length });
  });

  app.post("/", async (c) => {
    const accountId = accountIdParam(c);
    if (!canAccessAccount(c.var.actor, accountId, true)) {
      return c.json(forbidden(), 403);
    }
    const context = c.var.context;
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("identity.features.shippingAddresses.api.route.authentication.context.missing"),
          },
        },
        401,
      );
    }
    const body = await c.req.json<AddressBody>();
    const shippingAddressId = createId("adr") as ShippingAddressId;
    const result = await services.commandHandler({
      streamId: `identity.shipping-address-book-${accountId}`,
      command: {
        type: "AddShippingAddress",
        accountId: accountId as AccountId,
        shippingAddressId,
        label: optionalText(body.label),
        address: addressFromBody(body),
        makeDefault: isTrue(body.makeDefault),
        addedAt: new Date().toISOString(),
      },
      context,
    });
    await drainShippingAddressProjectors(services);
    return c.json(
      {
        id: shippingAddressId,
        version: result.version,
        status: "added",
      },
      201,
    );
  });

  app.put("/:shippingAddressId", async (c) => {
    const accountId = accountIdParam(c);
    if (!canAccessAccount(c.var.actor, accountId, true)) {
      return c.json(forbidden(), 403);
    }
    const context = c.var.context;
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("identity.features.shippingAddresses.api.route.authentication.context.missing"),
          },
        },
        401,
      );
    }
    const body = await c.req.json<AddressBody>();
    const shippingAddressId = c.req.param("shippingAddressId") as ShippingAddressId;
    const result = await services.commandHandler({
      streamId: `identity.shipping-address-book-${accountId}`,
      command: {
        type: "UpdateShippingAddress",
        shippingAddressId,
        label: optionalText(body.label),
        address: addressFromBody(body),
        makeDefault: isTrue(body.makeDefault),
        updatedAt: new Date().toISOString(),
      },
      context,
    });
    await drainShippingAddressProjectors(services);
    return c.json({
      id: shippingAddressId,
      version: result.version,
      status: "updated",
    });
  });

  app.post("/:shippingAddressId/default", async (c) => {
    const accountId = accountIdParam(c);
    if (!canAccessAccount(c.var.actor, accountId, true)) {
      return c.json(forbidden(), 403);
    }
    const context = c.var.context;
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("identity.features.shippingAddresses.api.route.authentication.context.missing"),
          },
        },
        401,
      );
    }
    const shippingAddressId = c.req.param("shippingAddressId") as ShippingAddressId;
    const result = await services.commandHandler({
      streamId: `identity.shipping-address-book-${accountId}`,
      command: {
        type: "SetDefaultShippingAddress",
        shippingAddressId,
        setAt: new Date().toISOString(),
      },
      context,
    });
    await drainShippingAddressProjectors(services);
    return c.json({
      id: shippingAddressId,
      version: result.version,
      status: "default-set",
    });
  });

  app.post("/:shippingAddressId/archive", async (c) => {
    const accountId = accountIdParam(c);
    if (!canAccessAccount(c.var.actor, accountId, true)) {
      return c.json(forbidden(), 403);
    }
    const context = c.var.context;
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("identity.features.shippingAddresses.api.route.authentication.context.missing"),
          },
        },
        401,
      );
    }
    const shippingAddressId = c.req.param("shippingAddressId") as ShippingAddressId;
    const result = await services.commandHandler({
      streamId: `identity.shipping-address-book-${accountId}`,
      command: {
        type: "ArchiveShippingAddress",
        shippingAddressId,
        archivedAt: new Date().toISOString(),
      },
      context,
    });
    await drainShippingAddressProjectors(services);
    return c.json({
      id: shippingAddressId,
      version: result.version,
      status: "archived",
    });
  });

  return app;
}
