import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { buildChannelsApi, type ChannelsApiEnv } from "../../../api";
import type { ChannelConnectionServices } from "../../connections/domain/contracts";
import { createUnavailableListingCompositionServices } from "../../listing-composition/tests/service-stub";
import { createUnavailableOutboundSyncServices } from "../../outbound-sync/tests/test-support";
import { ManualSyncError } from "../domain/contracts";
import type { ManualSyncServices } from "./runtime";

describe("manual-sync-panel-round-trip @marketplace-account", () => {
  it("authorizes before reads and makes missing and foreign connection responses identical", async () => {
    const services = manualServices();
    const forbidden = app(services, []);
    expect((await forbidden.request("http://local/api/channels/connections/owned/manual-sync")).status).toBe(403);
    expect(services.readPanel).not.toHaveBeenCalled();

    const authorized = app(services, ["channels.view"]);
    const missing = await authorized.request("http://local/api/channels/connections/missing/manual-sync");
    const foreign = await authorized.request("http://local/api/channels/connections/foreign/manual-sync");
    expect({ status: missing.status, body: await missing.text() }).toEqual({
      status: foreign.status,
      body: await foreign.text(),
    });
  });

  it("rejects an unavailable state without manufacturing a producer transition", async () => {
    const services = manualServices();
    services.release.mockRejectedValueOnce(new ManualSyncError("invalid-action"));
    const response = await app(services, ["channels.manage"]).request(
      "http://local/api/channels/connections/owned/manual-sync/runs/run-1/release?expectedRevision=7",
      { method: "POST" },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "invalid-action", message: "invalid-action" } });
  });

  it("refuses multipart byte 35651585 before materialization or ingestion", async () => {
    const services = manualServices();
    const response = await app(services, ["channels.manage"]).request(
      "http://local/api/channels/connections/owned/manual-sync/ingest?surface=live",
      {
        method: "POST",
        headers: {
          "content-type": "multipart/form-data; boundary=bounded",
          "content-length": "35651585",
        },
        body: "",
      },
    );
    expect(response.status).toBe(413);
    expect(services.ingest).not.toHaveBeenCalled();
  });
});

function app(manualSync: ReturnType<typeof manualServices>, permissions: readonly string[]) {
  const root = new Hono<ChannelsApiEnv>();
  root.use("*", async (c, next) => {
    c.set("actor", { accountId: "account-owner", permissions });
    c.set("context", {
      tenantId: "tenant" as never,
      audit: { performedByUserId: "user" as never, forAccountId: "account-owner" as never },
    });
    await next();
  });
  root.route(
    "/api/channels",
    buildChannelsApi({
      connections: connections(),
      listingComposition: createUnavailableListingCompositionServices(),
      outboundSync: createUnavailableOutboundSyncServices(),
      manualSync,
      projectors: [],
    }),
  );
  return root;
}

function manualServices() {
  return {
    readPanel: vi.fn<ManualSyncServices["readPanel"]>(async () => null),
    compose: vi.fn<ManualSyncServices["compose"]>(async () => {
      throw new Error("not reached");
    }),
    claimAndDownload: vi.fn<ManualSyncServices["claimAndDownload"]>(async () => {
      throw new Error("not reached");
    }),
    release: vi.fn<ManualSyncServices["release"]>(async () => {
      throw new Error("not reached");
    }),
    recordUploadAttempt: vi.fn<ManualSyncServices["recordUploadAttempt"]>(async () => {
      throw new Error("not reached");
    }),
    recordValidationCancellation: vi.fn<ManualSyncServices["recordValidationCancellation"]>(async () => {
      throw new Error("not reached");
    }),
    ingest: vi.fn<ManualSyncServices["ingest"]>(async () => {
      throw new Error("not reached");
    }),
    verify: vi.fn<ManualSyncServices["verify"]>(async () => {
      throw new Error("not reached");
    }),
  };
}

function connections(): ChannelConnectionServices {
  const unavailable = async (): Promise<never> => Promise.reject(new Error("not reached"));
  return {
    connectChannel: unavailable,
    activateChannelConnection: unavailable,
    pauseChannelConnection: unavailable,
    resumeChannelConnection: unavailable,
    disconnectChannelConnection: unavailable,
    getConnection: async () => null,
    listConnections: unavailable,
    projectors: [],
  };
}
