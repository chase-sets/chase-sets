import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { buildChannelsApi, type ChannelsApiEnv } from "../../../api";
import type { ChannelConnectionServices } from "../domain/contracts";
import { AUTH_ROLE_PERMISSIONS } from "../../../../auth/support/auth-support/constants";
import { ROLE_PERMISSIONS } from "../../../../identity/features/memberships/read-model/constants";
import { testContext } from "./test-support";

describe("channel-connection-authorization-isolation and channel-connection-grant-parity", () => {
  it("uses shared 403 behavior and keeps the Identity/Auth grant mirrors exact", async () => {
    const app = new Hono<ChannelsApiEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", { accountId: "acc_owner", permissions: [] });
      c.set("context", testContext);
      await next();
    });
    app.route("/api/channels", buildChannelsApi({ connections: services(), projectors: [] }));
    const response = await app.request("http://local/api/channels/connections");
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "authorization_forbidden", message: "authorization_forbidden" },
    });

    for (const role of ["platform-admin", "owner", "manager", "fulfillment", "viewer"] as const) {
      expect(AUTH_ROLE_PERMISSIONS[role].filter((permission) => permission.startsWith("channels."))).toEqual(
        ROLE_PERMISSIONS[role].filter((permission) => permission.startsWith("channels.")),
      );
    }
  });
});

function services(): ChannelConnectionServices {
  const unavailable = async () => {
    throw new Error("not reached");
  };
  return {
    connectChannel: unavailable,
    activateChannelConnection: unavailable,
    pauseChannelConnection: unavailable,
    resumeChannelConnection: unavailable,
    disconnectChannelConnection: unavailable,
    getConnection: unavailable,
    listConnections: unavailable,
    projectors: [],
  };
}
