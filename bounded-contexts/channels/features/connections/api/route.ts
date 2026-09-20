import { Hono } from "hono";
import { createId } from "@chase-sets/primitives/typed-ids";
import { loadDeploymentEnvironment, type DeploymentEnvironment } from "@chase-sets/platform-runtime/config-schema";
import type { ChannelsApiEnv } from "../../../api";
import {
  ChannelConnectionError,
  type ChannelConnectionServices,
  type ChannelStorageLocationAuthorityResolver,
} from "../domain/contracts";
import { assertClosedRecord, assertOpaqueId, assertProviderKey, assertSafeInteger } from "../domain/validation";
import { closePublicChannelConnection, toPublicChannelConnection } from "../read-model/queries";

export type ChannelConnectionRouteOptions = Readonly<{
  deploymentEnvironment?: DeploymentEnvironment;
  storageLocationAuthority?: ChannelStorageLocationAuthorityResolver;
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
      if (!Array.isArray(body.storageLocationIds) || body.storageLocationIds.length > 200) {
        throw new ChannelConnectionError("invalid-input");
      }
      const ids: string[] = [];
      for (const id of body.storageLocationIds) {
        assertOpaqueId(id, "storageLocationId");
        if (ids.includes(id)) throw new ChannelConnectionError("invalid-input");
        ids.push(id);
      }
      const input = { accountId: c.get("actor").accountId, connectionId: c.req.param("id") };
      if (!(await services.getConnection(input))) throw new ChannelConnectionError("connection-not-found");
      const bindings = [];
      for (const storageLocationId of ids) {
        const current = await options.storageLocationAuthority
          ?.resolve({ accountId: input.accountId, storageLocationId })
          .catch(() => null);
        if (!current) throw new ChannelConnectionError("binding-not-current");
        assertClosedRecord(current, ["accountId", "storageLocationId", "revision", "status"], "storage authority");
        assertSafeInteger(current.revision, "storage revision");
        if (
          current.accountId !== input.accountId ||
          current.storageLocationId !== storageLocationId ||
          current.status !== "active"
        ) {
          throw new ChannelConnectionError("binding-not-current");
        }
        bindings.push({ storageLocationId, revision: current.revision });
      }
      const result = await services.activateChannelConnection({ ...input, bindings }, c.get("context"));
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

  app.get("/:id", async (c) => {
    try {
      const item = await services.getConnection({
        accountId: c.get("actor").accountId,
        connectionId: c.req.param("id"),
      });
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
