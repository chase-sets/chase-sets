import { describe, expect, it, vi } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { connectorPolicyDefaults } from "../../connector-feed/domain/policy";
import { channelProviderRegistry } from "../../publication-port/api/registry";
import { scheduleDueLiveExports } from "../api/live-export";
import { createOrderPullScanCursor } from "../api/order-pull";
import type { OutboundSyncRuntimeDependencies } from "../domain/contracts";

const at = "2026-10-10T12:00:00Z";
function fixture() {
  const query = vi.fn<PgTransactionalPool["query"]>().mockResolvedValue({ rows: [] });
  const dependencies: OutboundSyncRuntimeDependencies = {
    db: {
      query,
      connect: async () => {
        throw new Error("unexpected-transaction");
      },
    },
    liveExport: { resolveConnectorPolicy: async () => connectorPolicyDefaults },
    readAdditionalOutboundHold: async () => ({ held: false, sources: [] }),
  };
  const scan = createOrderPullScanCursor();
  return {
    query,
    dependencies,
    scan,
    tick: (deps = dependencies) => scheduleDueLiveExports(deps, { registry: channelProviderRegistry }, () => at, scan),
  };
}

describe("live-export-schedule-due-boundary", () => {
  it("fails safely on unavailable policy and never queries with an impossible lease budget", async () => {
    const h = fixture();
    await expect(
      h.tick({
        ...h.dependencies,
        liveExport: {
          resolveConnectorPolicy: async () => {
            throw new Error("sensitive-policy-detail");
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "live-export-schedule-unavailable",
      message: "The connector transport policy could not be resolved.",
    });
    await expect(
      h.tick({
        ...h.dependencies,
        liveExport: { resolveConnectorPolicy: async () => ({ ...connectorPolicyDefaults, leaseMs: 140_000 }) },
      }),
    ).resolves.toBe(0);
    await expect(h.tick({ ...h.dependencies, liveExport: undefined })).resolves.toBe(0);
    expect(h.query).not.toHaveBeenCalled();
  });
  it("caps due scans at 100 with a keyset cursor and resets an exhausted scan", async () => {
    const h = fixture();
    h.scan.advance(h.scan.current(), "connection_previous");
    expect(await h.tick()).toBe(0);
    expect(h.query).toHaveBeenCalledOnce();
    expect(h.query.mock.calls[0]![0]).toContain("connection.connection_id > $3");
    expect(h.query.mock.calls[0]![0]).toContain("LIMIT $4");
    expect(h.query.mock.calls[0]![1]).toEqual([at, "2026-10-10T06:00:00.000Z", "connection_previous", 100]);
    expect(h.scan.current().after).toBeNull();
  });
});
