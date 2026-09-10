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
      "http://local/api/channels/connections/owned/manual-sync/ingest?surface=staged",
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

  it("refuses raw byte 33554433 before reading or ingestion", async () => {
    const services = manualServices();
    const response = await app(services, ["channels.manage"]).request(
      "http://local/api/channels/connections/owned/manual-sync/ingest?surface=staged",
      {
        method: "POST",
        headers: {
          "content-type": "text/csv",
          "content-length": "33554433",
          "x-channel-export-file-name": "staged.csv",
        },
        body: "",
      },
    );
    expect(response.status).toBe(413);
    expect(services.ingest).not.toHaveBeenCalled();
  });

  it("admits the inclusive raw and multipart declared bounds and passes only the extracted CSV bytes", async () => {
    const rawServices = manualServices();
    rawServices.ingest.mockResolvedValueOnce({} as never);
    const raw = await app(rawServices, ["channels.manage"]).request(
      "http://local/api/channels/connections/owned/manual-sync/ingest?surface=staged",
      {
        method: "POST",
        headers: {
          "content-type": "text/csv",
          "content-length": "33554432",
          "x-channel-export-file-name": "staged.csv",
        },
        body: "id\n1\n",
      },
    );
    expect(raw.status).toBe(200);
    expect(rawServices.ingest).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: "staged.csv", bytes: new TextEncoder().encode("id\n1\n") }),
    );

    const multipartServices = manualServices();
    multipartServices.ingest.mockResolvedValueOnce({} as never);
    const form = new FormData();
    form.set("export", new File(["id\n1\n"], "staged.csv", { type: "text/csv" }));
    const request = new Request("http://local/api/channels/connections/owned/manual-sync/ingest?surface=staged", {
      method: "POST",
      headers: { "content-length": "35651584" },
      body: form,
    });
    const multipart = await app(multipartServices, ["channels.manage"]).request(request);
    expect(multipart.status).toBe(200);
    expect(multipartServices.ingest).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: "staged.csv", bytes: new TextEncoder().encode("id\n1\n") }),
    );
  });

  it("bounds an endless raw stream, cancels it, and performs zero ingestion writes", async () => {
    const services = manualServices();
    let chunksProduced = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksProduced += 1;
        controller.enqueue(new Uint8Array(1_048_576));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request("http://local/api/channels/connections/owned/manual-sync/ingest?surface=live", {
      method: "POST",
      headers: { "content-type": "text/csv", "x-channel-export-file-name": "live.csv" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const response = await app(services, ["channels.manage"]).request(request);
    expect(response.status).toBe(413);
    expect(chunksProduced).toBeLessThanOrEqual(18);
    expect(cancelled).toBe(true);
    expect(services.ingest).not.toHaveBeenCalled();
  });

  it("maps a recursively malformed Summary to the closed invalid-input response", async () => {
    const services = manualServices();
    const response = await app(services, ["channels.manage"]).request(
      "http://local/api/channels/connections/owned/manual-sync/runs/run-1/verify",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: 7,
          verificationSnapshotId: "snapshot-1",
          importSummary: {
            fileName: "staged.csv",
            dateImportedText: "today",
            numberOfProducts: { coerced: 2 },
            recordedAt: "2026-09-10T12:00:00Z",
          },
        }),
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "invalid-input", message: "invalid-input" } });
    expect(services.verify).not.toHaveBeenCalled();
  });

  it.each([
    ["retry-clamp", "retryClamp"],
    ["release", "release"],
    ["validation-cancelled", "recordValidationCancellation"],
  ] as const)(
    "routes the revision-fenced %s action without accepting a stale or malformed revision",
    async (path, key) => {
      const services = manualServices();
      services[key].mockResolvedValueOnce({} as never);
      const authorized = app(services, ["channels.manage"]);
      const accepted = await authorized.request(
        `http://local/api/channels/connections/owned/manual-sync/runs/run-1/${path}?expectedRevision=7`,
        { method: "POST" },
      );
      expect(accepted.status).toBe(200);
      expect(services[key]).toHaveBeenCalledWith(
        { accountId: "account-owner", connectionId: "owned", runId: "run-1", expectedRevision: 7 },
        expect.any(Object),
      );

      const malformed = await authorized.request(
        `http://local/api/channels/connections/owned/manual-sync/runs/run-1/${path}?expectedRevision=7.1`,
        { method: "POST" },
      );
      expect(malformed.status).toBe(400);
      expect(services[key]).toHaveBeenCalledTimes(1);
    },
  );
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
    retryClamp: vi.fn<ManualSyncServices["retryClamp"]>(async () => {
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
