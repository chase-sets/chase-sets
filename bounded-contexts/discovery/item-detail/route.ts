import { Hono } from "hono";
import type { DiscoveryServices } from "../services";
import { getDiscoveryItemDetail } from "./queries";

export function discoveryItemDetailRoutes(services: DiscoveryServices): Hono {
  const app = new Hono();

  app.get("/:id", async (c) => {
    const item = await getDiscoveryItemDetail(services.db, c.req.param("id"));

    if (!item) {
      return c.json({ error: "Item not found." }, 404);
    }

    return c.json(item);
  });

  return app;
}

