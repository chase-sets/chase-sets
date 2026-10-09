import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { WorkerHostRuntime } from "@chase-sets/platform-runtime/worker";
import { collectRetentionSweepTargets, executeRetentionSweepBatch } from "@chase-sets/platform-runtime/retention-sweep";
import { module as channelsModule } from "../../../index";
import { connectorInboundRetentionExemptions, connectorInboundRetentionSweeps } from "../read-model/retention-policy";
import { fulfillmentObservationRetentionSweeps } from "../../order-fulfillment-observations/read-model/schema";

describe("connector-inbound-retention-module", () => {
  it("mounts every registered kind sweep on the Channels module and nothing that exempts the payload", () => {
    expect(channelsModule.retentionSweeps).toEqual([
      ...connectorInboundRetentionSweeps,
      ...fulfillmentObservationRetentionSweeps,
    ]);
    expect(channelsModule.retentionExemptions).toEqual(
      expect.arrayContaining([...connectorInboundRetentionExemptions]),
    );
    expect(
      channelsModule.retentionExemptions?.filter((exemption) => exemption.tableName.startsWith("channel_connector_")),
    ).toEqual([expect.objectContaining({ tableName: "channel_connector_inbound_events", owner: "channels" })]);
    expect(connectorInboundRetentionExemptions[0]?.reason).toContain("#7795");
  });

  it("is collected by the worker retention runner as the mounted Channels targets", () => {
    const pool = { query: vi.fn() } as unknown as PgQueryable;
    const runtime = {
      mountedContexts: [{ contextName: "channels", module: channelsModule, pool }],
    } as unknown as WorkerHostRuntime;
    const control = { query: vi.fn() } as unknown as PgQueryable;
    const targets = collectRetentionSweepTargets(runtime, control).filter(
      (target) => target.sweep.tableName === "channel_connector_inbound_payloads",
    );
    expect(targets).toEqual(
      connectorInboundRetentionSweeps.map((sweep) => ({ contextName: "channels", db: pool, sweep })),
    );
    const unmounted = {
      mountedContexts: [{ contextName: "channels", module: { ...channelsModule, retentionSweeps: [] }, pool }],
    } as unknown as WorkerHostRuntime;
    expect(
      collectRetentionSweepTargets(unmounted, control).filter(
        (target) => target.sweep.tableName === "channel_connector_inbound_payloads",
      ),
    ).toEqual([]);
  });

  it("passes the shared runner's trusted-fragment gate as one bounded atomic DELETE per kind", async () => {
    for (const sweep of connectorInboundRetentionSweeps) {
      const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
      await expect(executeRetentionSweepBatch({ query } as unknown as PgQueryable, sweep)).resolves.toBe(0);
      const [sql, parameters] = query.mock.calls[0] as [string, unknown[]];
      expect(parameters).toEqual([2, `retention:channel_connector_inbound_payloads:${sweep.name}`]);
      expect(sql).toContain(sweep.predicateSql);
      expect(sql).toContain("FOR UPDATE SKIP LOCKED");
      expect(sql).toContain("DELETE FROM channel_connector_inbound_payloads AS retained");
    }
  });

  it("documents the class windows beside the other shared retention windows", () => {
    const doc = readFileSync(
      new URL("../../../../../docs/architecture/postgres-retention-sweeps.md", import.meta.url),
      "utf8",
    );
    const row = doc.split("\n").find((line) => line.startsWith("| Connector inbound payloads |"));
    expect(row).toContain("604800 s");
    expect(row).toContain("7776000 s");
    expect(row).toContain("channel_connector_inbound_payloads");
    expect(doc).toContain("- `channel_connector_inbound_events`:");
  });
});
