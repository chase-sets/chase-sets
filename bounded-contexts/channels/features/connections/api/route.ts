import { Hono } from "hono";
import { createId } from "@chase-sets/primitives/typed-ids";
import { loadDeploymentEnvironment, type DeploymentEnvironment } from "@chase-sets/platform-runtime/config-schema";
import type { ChannelsApiEnv } from "../../../api";
import { ChannelConnectionError, type ChannelConnectionServices } from "../domain/contracts";
import { assertClosedRecord, assertProviderKey, assertStorageLocationIds } from "../domain/validation";
import { closePublicChannelConnection, toPublicChannelConnection } from "../read-model/queries";
import { listConnectableChannelProviders } from "./providers";

export type ChannelConnectionRouteOptions = Readonly<{
  deploymentEnvironment?: DeploymentEnvironment;
  ebaySandboxEnabled?: boolean;
}>;

export function channelConnectionRoutes(
  services: ChannelConnectionServices,
  options: ChannelConnectionRouteOptions = {},
) {
  const app = new Hono<ChannelsApiEnv>();
  const deploymentEnvironment = options.deploymentEnvironment ?? loadDeploymentEnvironment();

  app.post("/", async (c) => {
    try {
      const body: unknown = await c.req.json().catch(() => null);
      assertClosedRecord(body, ["providerKey"], "connect request");
      assertProviderKey(body.providerKey);
      const result = await services.connectChannel(
        { connectionId: createId("chn"), accountId: c.get("actor").accountId, providerKey: body.providerKey },
        { deploymentEnvironment },
        c.get("context"),
      );
      return c.json(toPublicChannelConnection(result.state), 201);
    } catch (error) {
      return routeError(error);
    }
  });

  app.post("/:id/activate", async (c) => {
    try {
      const body: unknown = await c.req.json().catch(() => null);
      assertClosedRecord(body, ["storageLocationIds"], "activate request");
      assertStorageLocationIds(body.storageLocationIds);
      const result = await services.activateChannelConnection(
        {
          accountId: c.get("actor").accountId,
          connectionId: c.req.param("id"),
          storageLocationIds: body.storageLocationIds,
        },
        c.get("context"),
      );
      return c.json(toPublicChannelConnection(result.state));
    } catch (error) {
      return routeError(error);
    }
  });

  app.get("/", async (c) => {
    try {
      const query = parseListQuery(c.req.url);
      const page = await services.listConnections({ accountId: c.get("actor").accountId, ...query });
      assertClosedRecord(page, ["items", "nextCursor"], "connection page");
      if (!Array.isArray(page.items)) throw invalidPageError();
      if (page.nextCursor !== undefined && !/^[A-Za-z0-9_-]{1,512}$/.test(page.nextCursor)) {
        throw invalidPageError();
      }
      return c.json({
        items: page.items.map(closePublicChannelConnection),
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      });
    } catch (error) {
      if (error instanceof ChannelConnectionError && error.message === "invalid-page") {
        return c.json(errorBody("invalid-page"), 400);
      }
      throw error;
    }
  });

  app.get("/providers", async (c) => {
    if (new URL(c.req.url).searchParams.size > 0) return c.json(errorBody("invalid-request"), 400);
    if (!c.get("actor").permissions.includes("channels.manage")) return c.json({ items: [] });
    try {
      const items = await listConnectableChannelProviders(deploymentEnvironment);
      return c.json({
        items: [
          ...items,
          ...(options.ebaySandboxEnabled && deploymentEnvironment !== "production"
            ? [{ providerKey: "ebay", environment: "sandbox" }]
            : []),
        ],
      });
    } catch {
      return c.json(errorBody("invalid-request"), 400);
    }
  });

  app.get("/:id", async (c) => {
    try {
      // This detail can be opened immediately after a connection transition.
      const item = await services.getConnection(
        { accountId: c.get("actor").accountId, connectionId: c.req.param("id") },
        "committed",
      );
      return item ? c.json(closePublicChannelConnection(item)) : c.json(errorBody("connection-not-found"), 404);
    } catch (error) {
      return routeError(error);
    }
  });

  app.post("/:id/pause", async (c) => {
    if (!(await hasEmptyBody(c.req.raw))) return c.json(errorBody("invalid-request"), 400);
    try {
      const result = await services.pauseChannelConnection(
        { accountId: c.get("actor").accountId, connectionId: c.req.param("id") },
        c.get("context"),
      );
      return c.json(toPublicChannelConnection(result.state));
    } catch (error) {
      return routeError(error);
    }
  });

  app.post("/:id/resume", async (c) => {
    if (!(await hasEmptyBody(c.req.raw))) return c.json(errorBody("invalid-request"), 400);
    try {
      const result = await services.resumeChannelConnection(
        { accountId: c.get("actor").accountId, connectionId: c.req.param("id") },
        c.get("context"),
      );
      return c.json(toPublicChannelConnection(result.state));
    } catch (error) {
      return routeError(error);
    }
  });

  app.post("/:id/disconnect", async (c) => {
    if (!(await hasEmptyBody(c.req.raw))) return c.json(errorBody("invalid-request"), 400);
    try {
      const result = await services.disconnectChannelConnection(
        { accountId: c.get("actor").accountId, connectionId: c.req.param("id") },
        c.get("context"),
      );
      return c.json(toPublicChannelConnection(result.state));
    } catch (error) {
      return routeError(error);
    }
  });

  return app;
}

function parseListQuery(url: string) {
  const search = new URL(url).searchParams;
  const allowed = new Set(["cursor", "limit", "status"]);
  for (const key of search.keys()) {
    if (!allowed.has(key) || search.getAll(key).length !== 1) throw invalidPageError();
  }
  const cursor = search.get("cursor");
  const limitValue = search.get("limit");
  const status = search.get("status");
  if (cursor !== null && !/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) throw invalidPageError();
  if (limitValue !== null && !/^(?:[1-9]|[1-9]\d|100)$/.test(limitValue)) throw invalidPageError();
  if (status !== null && !["pending-setup", "active", "paused", "disconnected"].includes(status)) {
    throw invalidPageError();
  }
  return {
    ...(cursor === null ? {} : { cursor }),
    ...(limitValue === null ? {} : { limit: Number(limitValue) }),
    ...(status === null ? {} : { status: status as "pending-setup" | "active" | "paused" | "disconnected" }),
  };
}

async function hasEmptyBody(request: Request): Promise<boolean> {
  const body = await request.text();
  return body.length === 0;
}

function routeError(error: unknown): Response {
  if (error instanceof ChannelConnectionError) {
    if (error.code === "connection-not-found") return Response.json(errorBody(error.code), { status: 404 });
    if (error.code === "invalid-input") return Response.json(errorBody("invalid-request"), { status: 400 });
    return Response.json(errorBody(error.code), { status: 409 });
  }
  return Response.json(errorBody("internal-error"), { status: 500 });
}

function errorBody(code: string) {
  return { error: { code, message: code } };
}

function invalidPageError() {
  return new ChannelConnectionError("invalid-input", "invalid-page");
}
