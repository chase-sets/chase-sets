import { createHash } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { buildChannelsApi, type ChannelsApiEnv } from "../../../api";
import { createChannelsServicesForTest } from "../../../tests/channels-services-test-support";
import type { ChannelConnectionServices } from "../../connections/domain/contracts";
import { createUnavailableListingCompositionServices } from "../../listing-composition/tests/service-stub";
import { createUnavailableOutboundSyncServices } from "../../outbound-sync/tests/test-support";
import { createTcgplayerCsvRuntime } from "../../tcgplayer-csv/api/runtime";
import { tcgplayerLiveExportHeader } from "../../tcgplayer-csv/domain/profile";
import { ManualSyncError } from "../domain/contracts";
import { createManualSyncRuntime, type ManualSyncServices } from "./runtime";

describe("manual-sync-panel-round-trip @marketplace-account", () => {
  it("channel-order-observation-callers: refuses fulfillment at the closed manual CSV surface", async () => {
    const services = manualServices();
    const response = await app(services, ["channels.manage"]).request(
      "http://local/api/channels/connections/owned/manual-sync/ingest?surface=channel-order-fulfillment-observation%2Fv1",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    expect(response.status).toBe(400);
    expect(services.ingest).not.toHaveBeenCalled();
  });
  it("returns a bounded unavailable state when authority cannot be read", async () => {
    const services = manualServices();
    services.readPanel.mockRejectedValue(new ManualSyncError("manual-sync-unavailable", "synthetic-secret-sentinel"));
    const response = await app(services, ["channels.view"]).request(
      "http://local/api/channels/connections/owned/manual-sync",
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: "manual-sync-unavailable", message: "manual-sync-unavailable" },
    });
  });

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
    ["live", liveCsv("987650")],
    ["staged", `${stagedHeader.join(",")}\n987650,0,0,1.00\n`],
  ] as const)("ingest-bounded-receipt: the %s ingest returns only the receipt", async (surface, csv) => {
    const db = recordingDb();
    const form = new FormData();
    form.set("export", new File([csv], `${surface}.csv`, { type: "text/csv" }));
    const response = await app(ingestRuntime(db), ["channels.manage"]).request(
      new Request(`http://local/api/channels/connections/owned/manual-sync/ingest?surface=${surface}`, {
        method: "POST",
        body: form,
      }),
    );
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toStrictEqual({
      surface,
      probe: {
        fileName: `${surface}.csv`,
        byteSize: new TextEncoder().encode(csv).byteLength,
        logicalRows: 1,
        headerSha256: createHash("sha256").update(csv.split("\n")[0]!, "utf8").digest("hex"),
        observedAt: "2026-10-11T12:00:00.000Z",
      },
      outcome: {
        kind: "ingested",
        snapshotId: expect.stringMatching(/^cis/),
        snapshotGeneration: 4,
        parsedRowCount: 1,
      },
    });
    expect(text).not.toContain("987650");
    expect(text).not.toContain("TCG Marketplace Price");
    expect(text).not.toContain('"rows"');
    expect(text).not.toContain('"header"');
    expect(db.statements.some((sql) => sql.includes("INSERT INTO channel_inventory_snapshots"))).toBe(true);
  });

  it.each(["live", "staged"] as const)(
    "ingest-bounded-receipt: a refused %s parse returns the refused outcome and persists nothing",
    async (surface) => {
      const db = recordingDb();
      const csv = "TCGplayer Id,Unexpected\n987650,1\n";
      const response = await app(ingestRuntime(db), ["channels.manage"]).request(
        `http://local/api/channels/connections/owned/manual-sync/ingest?surface=${surface}`,
        {
          method: "POST",
          headers: { "content-type": "text/csv", "x-channel-export-file-name": `${surface}.csv` },
          body: csv,
        },
      );
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(JSON.parse(text)).toStrictEqual({
        surface,
        probe: expect.objectContaining({ fileName: `${surface}.csv`, logicalRows: 1 }),
        outcome: { kind: "refused", reason: "header-missing-required-column" },
      });
      expect(text).not.toContain("987650");
      expect(text).not.toContain("Unexpected");
      expect(db.connect).not.toHaveBeenCalled();
      expect(db.statements.filter((sql) => !/^\s*SELECT/i.test(sql))).toEqual([]);
    },
  );

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

function app(manualSync: ManualSyncServices, permissions: readonly string[]) {
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
      ...createChannelsServicesForTest(),
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

function connections(
  getConnection: ChannelConnectionServices["getConnection"] = async () => null,
): ChannelConnectionServices {
  const unavailable = async (): Promise<never> => Promise.reject(new Error("not reached"));
  return {
    connectChannel: unavailable,
    activateChannelConnection: unavailable,
    pauseChannelConnection: unavailable,
    resumeChannelConnection: unavailable,
    disconnectChannelConnection: unavailable,
    getConnection,
    listConnections: unavailable,
    projectors: [],
  };
}

const stagedHeader = ["TCGplayer Id", "Total Quantity", "Add to Quantity", "TCG Marketplace Price"];

function liveCsv(externalKey: string) {
  const values: Record<string, string> = {
    "TCGplayer Id": externalKey,
    "Total Quantity": "2",
    "Add to Quantity": "0",
    "TCG Marketplace Price": "1.00",
    Condition: "Near Mint",
  };
  return `${tcgplayerLiveExportHeader.join(",")}\n${tcgplayerLiveExportHeader.map((key) => values[key] ?? "").join(",")}\n`;
}

function recordingDb() {
  const statements: string[] = [];
  const query = vi.fn(async (sql: string) => {
    statements.push(sql);
    return sql.includes("next_generation")
      ? { rows: [{ next_generation: 4 }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  });
  return { statements, query, connect: vi.fn(async () => ({ query, release: () => undefined })) };
}

function ingestRuntime(db: ReturnType<typeof recordingDb>) {
  return createManualSyncRuntime({
    db: db as never,
    connections: connections(async (input) =>
      input.accountId === "account-owner" && input.connectionId === "owned"
        ? {
            connectionId: "owned",
            providerKey: "tcgplayer",
            environment: "production",
            status: "active",
            createdAt: "2026-10-11T11:00:00.000Z",
            allowedActions: ["pause", "disconnect"],
          }
        : null,
    ),
    tcgplayerCsv: createTcgplayerCsvRuntime({ db: db as never } as never),
    connectorFeed: { readAuthority: vi.fn() },
    policies: { resolvePolicy: vi.fn() },
    marketplaceClamp: { kind: "not-mounted" },
    now: () => "2026-10-11T12:00:00.000Z",
  });
}
