import { Hono } from "hono";
import type { InventoryApiEnv } from "../../../api";
import type { StorageLocationServices } from "./runtime";

function parseShipFromAddress(value: unknown) {
  const source = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};

  return {
    name: String(source.name ?? ""),
    company: source.company == null ? null : String(source.company),
    line1: String(source.line1 ?? ""),
    line2: source.line2 == null ? null : String(source.line2),
    city: String(source.city ?? ""),
    state: String(source.state ?? ""),
    postalCode: String(source.postalCode ?? ""),
    country: String(source.country ?? "US"),
    phone: source.phone == null ? null : String(source.phone),
    email: source.email == null ? null : String(source.email),
  };
}

export function inventoryStorageLocationRoutes(
  services: StorageLocationServices,
) {
  const app = new Hono<InventoryApiEnv>();

  app.get("/", async (c) => {
    const actor = c.get("actor");
    const items = await services.listStorageLocations({
      accountId: actor.accountId,
      includeArchived: c.req.query("includeArchived") === "true",
    });

    return c.json({
      items,
      total: items.length,
      count: items.length,
    });
  });

  app.post("/", async (c) => {
    const actor = c.get("actor");
    const body = await c.req.json();
    const result = await services.createStorageLocation(
      {
        accountId: actor.accountId as never,
        name: String(body.name ?? ""),
        description:
          typeof body.description === "string" ? body.description : null,
        shipFromCode: String(body.shipFromCode ?? ""),
        shipFromAddress: parseShipFromAddress(body.shipFromAddress),
      },
      c.get("context"),
    );

    return c.json(
      {
        id: result.storageLocationId,
        version: result.version,
      },
      201,
    );
  });

  app.patch("/:id", async (c) => {
    const actor = c.get("actor");
    const body = await c.req.json();
    const result = await services.updateStorageLocation(
      {
        storageLocationId: c.req.param("id"),
        accountId: actor.accountId,
        name: String(body.name ?? ""),
        description:
          typeof body.description === "string" ? body.description : null,
        shipFromCode: String(body.shipFromCode ?? ""),
        shipFromAddress: parseShipFromAddress(body.shipFromAddress),
        isArchived: Boolean(body.isArchived),
      },
      c.get("context"),
    );

    return c.json({
      id: result.storageLocationId,
      version: result.version,
    });
  });

  return app;
}
