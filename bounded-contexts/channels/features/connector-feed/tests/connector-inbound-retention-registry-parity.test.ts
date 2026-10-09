import { describe, expect, it } from "vitest";
import { manualSyncIngestContract } from "../../manual-sync/domain/contracts";
import { connectorInboundKinds } from "../domain/transport";
import {
  ConnectorInboundRetentionRegistryError,
  connectorInboundKindRetention,
  connectorInboundRetentionClasses,
  resolveConnectorInboundRetentionClasses,
} from "../domain/retention";
import { connectorInboundSchemaSql } from "../read-model/inbound-schema";
import {
  buildConnectorInboundRetentionSweeps,
  connectorInboundRetentionBatchLimit,
  connectorInboundRetentionSweeps,
} from "../read-model/retention-policy";

describe("connector-inbound-retention-registry-parity", () => {
  it("resolves exactly one closed class per admitted kind with elapsed-second windows", () => {
    expect(resolveConnectorInboundRetentionClasses(connectorInboundKindRetention)).toEqual([
      { retentionClass: "inventory-snapshot", windowSeconds: 604_800, inboundKinds: ["export"] },
      {
        retentionClass: "order-observation",
        windowSeconds: 7_776_000,
        inboundKinds: ["order", "channel-order-fulfillment-observation/v1"],
      },
    ]);
    expect(connectorInboundRetentionClasses).toEqual({
      export: { retentionClass: "inventory-snapshot", windowSeconds: 604_800 },
      order: { retentionClass: "order-observation", windowSeconds: 7_776_000 },
      "channel-order-fulfillment-observation/v1": { retentionClass: "order-observation", windowSeconds: 7_776_000 },
    });
  });

  it.each([
    ["missing-kind", [{ inboundKind: "export", retentionClass: "inventory-snapshot" }]],
    [
      "unknown-kind",
      [...connectorInboundKindRetention, { inboundKind: "fulfillment", retentionClass: "order-observation" }],
    ],
    ["unknown-class", [{ inboundKind: "export", retentionClass: "forever" }, connectorInboundKindRetention[1]]],
    [
      "duplicate-kind",
      [...connectorInboundKindRetention, { inboundKind: "export", retentionClass: "inventory-snapshot" }],
    ],
    [
      "duplicate-kind",
      [...connectorInboundKindRetention, { inboundKind: "order", retentionClass: "inventory-snapshot" }],
    ],
    [
      "invalid-registration",
      [{ ...connectorInboundKindRetention[0], windowSeconds: 1 }, connectorInboundKindRetention[1]],
    ],
    ["invalid-registration", [null, ...connectorInboundKindRetention]],
    ["invalid-registration", [["export", "inventory-snapshot"], connectorInboundKindRetention[1]]],
  ])("refuses a %s registration before any sweep exists", (code, registrations) => {
    const refusal = new ConnectorInboundRetentionRegistryError(code as ConnectorInboundRetentionRegistryError["code"]);
    expect(() => resolveConnectorInboundRetentionClasses(registrations)).toThrow(refusal);
    expect(() => buildConnectorInboundRetentionSweeps(registrations)).toThrow(refusal);
  });

  it("derives one bounded, strictly-after, elapsed-second sweep per kind from its registered class", () => {
    expect(connectorInboundRetentionBatchLimit).toBe(
      Math.floor((256 * 1_048_576) / manualSyncIngestContract.configuredBounds.bytes[1]),
    );
    expect(connectorInboundRetentionBatchLimit).toBe(2);
    expect(connectorInboundRetentionSweeps).toEqual(
      buildConnectorInboundRetentionSweeps(connectorInboundKindRetention),
    );
    expect(
      connectorInboundRetentionSweeps.map(({ name, tableName, orderBySql, intervalMs, batchLimit }) => ({
        name,
        tableName,
        orderBySql,
        intervalMs,
        batchLimit,
      })),
    ).toEqual(
      ["inventory-snapshot", "order-observation", "fulfillment-observation"].map((name) => ({
        name: `connector-inbound-${name}`,
        tableName: "channel_connector_inbound_payloads",
        orderBySql: "candidate.received_at ASC, candidate.provider_event_id ASC",
        intervalMs: 3_600_000,
        batchLimit: 2,
      })),
    );
    const [exportSweep, orderSweep, fulfillmentSweep] = connectorInboundRetentionSweeps;
    expect(exportSweep?.predicateSql.replace(/\s+/g, " ")).toBe(
      "candidate.inbound_kind = 'export' AND candidate.received_at < CURRENT_TIMESTAMP - make_interval(secs => 604800)",
    );
    expect(orderSweep?.predicateSql.replace(/\s+/g, " ")).toBe(
      "candidate.inbound_kind = 'order' AND candidate.received_at < CURRENT_TIMESTAMP - make_interval(secs => 7776000)",
    );
    expect(fulfillmentSweep?.predicateSql.replace(/\s+/g, " ")).toBe(
      "candidate.inbound_kind = 'channel-order-fulfillment-observation/v1' AND candidate.received_at < CURRENT_TIMESTAMP - make_interval(secs => 7776000)",
    );
  });

  it("covers every kind the payload table admits and no other", () => {
    const tableKinds = [...connectorInboundSchemaSql.matchAll(/CHECK \(inbound_kind IN \(([^)]*)\)\)/g)]
      .at(-1)?.[1]
      ?.split(",")
      .map((kind) => kind.trim().replaceAll("'", ""));
    expect(new Set(tableKinds)).toEqual(new Set(connectorInboundKinds));
    expect(
      new Set(resolveConnectorInboundRetentionClasses(connectorInboundKindRetention).flatMap((c) => c.inboundKinds)),
    ).toEqual(new Set(connectorInboundKinds));
  });
});
