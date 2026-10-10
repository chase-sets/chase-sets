import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { module as channelsModule } from "@chase-sets/channels";
import {
  isChannelsServices,
  type ChannelsServices,
  type ConnectorTransportServices,
  readAdmittedConnectorInboundEvents,
} from "@chase-sets/channels/server";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { Hono } from "hono";

describe("connector-feed-bootstrap-and-manifest", () => {
  it("retains the actual aggregate, public handoff export and existing sessionless mount ordinals", async () => {
    const unavailable = async (): Promise<never> => {
      throw new Error("unexpected-db-call");
    };
    const query = vi.fn<PgQueryable["query"]>().mockResolvedValue({ rows: [] });
    const services = channelsModule.createServices(
      { query, connect: unavailable },
      { channelSaleRecorder: unavailable },
    );
    expectTypeOf(services).toEqualTypeOf<ChannelsServices>();
    expectTypeOf(services.connectorFeed.claim).toEqualTypeOf<ConnectorTransportServices["claim"]>();
    expect(isChannelsServices(services)).toBe(true);
    expect(typeof readAdmittedConnectorInboundEvents).toBe("function");
    const claim = vi
      .spyOn(services.connectorFeed, "claim")
      .mockResolvedValue({ reservation: null, pollWindowSeconds: 60 });
    vi.spyOn(services.connectorFeed, "resolveTransportPolicy").mockResolvedValue({
      leaseMs: 1_800_000,
      pollWindowSeconds: 60,
      maxOperationsPerClaim: 100,
      maxIngestBytes: 33_554_432,
      maxIngestRecords: 100_000,
    });
    const mounts = channelsModule.buildApis(services);
    expect(mounts.map(({ mountPath, contextMountOrdinal }) => ({ mountPath, contextMountOrdinal }))).toEqual([
      { mountPath: "/api/channels", contextMountOrdinal: 1 },
      { mountPath: "/channel-connector/oauth", contextMountOrdinal: 2 },
    ]);
    const credential = mounts.find((mount) => mount.mountPath === "/channel-connector/oauth");
    if (!(credential?.router instanceof Hono)) throw new Error("missing-connector-router");
    expect(credential.router.routes.filter((route) => route.method === "POST").map((route) => route.path)).toEqual([
      "/register",
      "/token",
      "/revoke",
      "/connections/:connectionId/claim",
      "/connections/:connectionId/report",
      "/connections/:connectionId/ingest",
    ]);
    const app = new Hono();
    for (const mount of mounts) {
      if (!(mount.router instanceof Hono)) throw new Error("invalid-context-router");
      app.route(mount.mountPath, mount.router);
    }
    const response = await app.request("/channel-connector/oauth/connections/connection_test/claim", {
      method: "POST",
      headers: { authorization: "Bearer synthetic-connector", "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reservation: null, pollWindowSeconds: 60 });
    expect(claim).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[1]?.[3]).toBe("claim");
    expect(
      credential.router.routes.some(
        (route) => route.method === "GET" && route.path === "/tcgplayer-staged-import-dispatch-policy",
      ),
    ).toBe(true);
    const floor = await app.request(
      "/channel-connector/oauth/tcgplayer-staged-import-dispatch-policy?reservationId=synthetic&requestNonce=" +
        "a".repeat(32),
    );
    expect(floor.status).toBe(403);
    expect(await floor.json()).toEqual({ code: "authorization-refused" });
    expect(query.mock.calls.at(-1)?.[1]?.[3]).toBe("tcgplayer-staged-import-dispatch-policy");
    const denied = await app.request("/api/channels/connections");
    expect(denied.status).toBe(401);
  });
  it.each([
    "claim",
    "report",
    "ingest",
    "readAdmittedConnectorInboundEvents",
    "readStagedImportDispatchPolicy",
    "withGrantAuthority",
  ])("does not accept an aggregate missing %s", (method) => {
    const unavailable = async (): Promise<never> => {
      throw new Error("unexpected-db-call");
    };
    const services = channelsModule.createServices(
      { query: unavailable, connect: unavailable },
      { channelSaleRecorder: unavailable },
    );
    expect(
      isChannelsServices({
        ...services,
        connectorFeed: Object.fromEntries(Object.entries(services.connectorFeed).filter(([key]) => key !== method)),
      }),
    ).toBe(false);
  });
});
